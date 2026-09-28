import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { DsmClient } from "./client.js";
import type { AppConfig } from "./config.js";
import {
  SERVER_NAME,
  SERVER_VERSION,
  createMcpServer,
  visibleTools,
} from "./server.js";

type Session = { server: Server; transport: StreamableHTTPServerTransport };

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

/** Constant-time-ish comparison so the token is not learnable by timing. */
function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(req: IncomingMessage, config: AppConfig): boolean {
  if (!config.mcpToken) return true;
  const header = req.headers.authorization;
  if (!header) return false;
  const [scheme, value] = header.split(" ");
  if (!value || scheme.toLowerCase() !== "bearer") return false;
  return tokenMatches(value.trim(), config.mcpToken);
}

export async function startHttpServer(
  client: DsmClient,
  config: AppConfig,
): Promise<void> {
  const sessions = new Map<string, Session>();

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // The path is normalized so the server works both at the root and behind a
    // reverse proxy that mounts it under a prefix such as /mcp/synology/.
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isMcpPath = path === "/" || path.endsWith("/mcp") || path === "/mcp";

    if (path.endsWith("/healthz") || path === "/healthz") {
      sendJson(res, 200, {
        status: "ok",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        transport: "streamable-http",
        activeSessions: sessions.size,
        toolsExposed: visibleTools(config.policy).length,
        policy: config.policy.describe(),
      });
      return;
    }

    if (!isMcpPath) {
      sendJson(res, 404, { error: `Not found: ${path}` });
      return;
    }

    if (!isAuthorized(req, config)) {
      res.setHeader("www-authenticate", 'Bearer realm="synology-mcp"');
      sendJson(res, 401, {
        error:
          "Missing or invalid bearer token. Send Authorization: Bearer <SYNOLOGY_MCP_TOKEN>.",
      });
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing =
      typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (existing) {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    // Sessions live in memory, so a restart forgets them. The MCP spec
    // requires 404 for an unknown session id: that is what tells the client
    // to re-initialize instead of failing every call with 400.
    if (typeof sessionId === "string") {
      sendJson(res, 404, {
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Session not found. Start a new MCP session.",
        },
        id: null,
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 400, {
        error:
          "No active MCP session. Initialize with a POST before opening a stream.",
      });
      return;
    }

    // A new session: build the server first so the transport callback can
    // close over it without a self-referential initializer.
    const mcpServer = createMcpServer(client, config);
    let transport: StreamableHTTPServerTransport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string): void => {
        sessions.set(id, { server: mcpServer, transport });
      },
    });

    transport.onclose = (): void => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };

    await mcpServer.connect(transport);
    const body = await readBody(req);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, resolve);
  });

  const toolCount = visibleTools(config.policy).length;
  console.error(
    `[${SERVER_NAME}] listening on ${config.host}:${config.port} with ${toolCount} tools ` +
      `(readOnly=${config.policy.readOnly}, auth=${config.mcpToken ? "required" : "disabled"})`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[${SERVER_NAME}] received ${signal}, shutting down`);
    for (const session of sessions.values()) {
      await session.transport.close().catch(() => undefined);
    }
    sessions.clear();
    await client.logout();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
