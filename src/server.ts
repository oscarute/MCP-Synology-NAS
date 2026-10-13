import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AppConfig } from "./config.js";
import type { DsmClient } from "./client.js";
import { formatError } from "./errors.js";
import { PolicyError, type SecurityPolicy } from "./security.js";
import type { ToolContext, ToolDef } from "./tool.js";
import { allTools, buildToolIndex } from "./tools/index.js";

export const SERVER_NAME = "synology";
// package.json is the single source of the version; it sits next to dist/.
export const SERVER_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/**
 * A tool that can never succeed under the current policy is hidden rather than
 * advertised and then refused, so the model is not tempted to keep retrying it.
 * Tools that are only conditionally blocked stay visible and return an
 * actionable policy message instead.
 */
function isAvailable(tool: ToolDef, policy: SecurityPolicy): boolean {
  if (policy.readOnly && !tool.readOnly) return false;
  if (!policy.allowGenericApi && tool.name === "call_dsm_api") return false;
  return true;
}

export function visibleTools(policy: SecurityPolicy): ToolDef[] {
  return allTools.filter((tool) => isAvailable(tool, policy));
}

export function createMcpServer(
  client: DsmClient,
  config: AppConfig,
): Server {
  const policy = config.policy;
  const tools = visibleTools(policy);
  const index = buildToolIndex(tools);
  const context: ToolContext = { client, policy };

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.schema, {
        $refStrategy: "none",
      }) as Record<string, unknown>,
      annotations: {
        title: tool.title,
        readOnlyHint: tool.readOnly === true,
        destructiveHint: tool.destructive === true,
        idempotentHint: tool.idempotent === true,
        openWorldHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = index.get(request.params.name);

    if (!tool) {
      const hidden = allTools.some((t) => t.name === request.params.name);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: hidden
              ? `The tool "${request.params.name}" exists but is disabled by the current safety policy. ${
                  policy.readOnly
                    ? "The server is in read-only mode; set SYNOLOGY_READONLY=false to enable writes."
                    : "Enable the matching SYNOLOGY_ALLOW_* setting to use it."
                }`
              : `Unknown tool: ${request.params.name}`,
          },
        ],
      };
    }

    try {
      const parsed = tool.schema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Invalid arguments for ${tool.name}. ${issues}`,
            },
          ],
        };
      }

      const result = await tool.handler(context, parsed.data);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      // Policy refusals are expected outcomes, not faults, and their message
      // already names the setting that would allow the call.
      const text =
        error instanceof PolicyError ? error.message : formatError(error);
      return {
        isError: true,
        content: [{ type: "text" as const, text }],
      };
    }
  });

  return server;
}
