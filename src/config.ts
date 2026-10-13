import { SecurityPolicy } from "./security.js";

export type DsmCredentials = {
  baseUrl: string;
  user: string;
  password: string;
  otp?: string;
  insecureTls: boolean;
  sessionTtlMs: number;
  timeoutMs: number;
  maxRetries: number;
};

export type AppConfig = {
  credentials: DsmCredentials;
  policy: SecurityPolicy;
  transport: "http" | "stdio";
  port: number;
  host: string;
  mcpToken?: string;
  logLevel: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function str(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function bool(name: string, fallback: boolean): boolean {
  const value = str(name);
  if (value === undefined) return fallback;
  const lowered = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lowered)) return true;
  if (["0", "false", "no", "off"].includes(lowered)) return false;
  throw new ConfigError(`${name} must be a boolean, received "${value}".`);
}

function int(name: string, fallback: number, min = 0): number {
  const value = str(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    throw new ConfigError(
      `${name} must be an integer >= ${min}, received "${value}".`,
    );
  }
  return parsed;
}

/** Splits "/a,/b" into normalized path prefixes, dropping empties. */
function pathList(name: string): string[] {
  const value = str(name);
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith("/")) {
        throw new ConfigError(
          `${name} entries must be absolute paths starting with "/", received "${entry}".`,
        );
      }
      return entry.replace(/\/+$/, "") || "/";
    });
}

/** Rejects a URL that is missing a scheme, so failures surface at boot. */
function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(
      `SYNOLOGY_URL must be a full URL including the scheme and port, received "${raw}".`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError(
      `SYNOLOGY_URL must use http or https, received "${parsed.protocol}".`,
    );
  }
  return parsed.origin;
}

export function loadConfig(): AppConfig {
  const rawUrl = str("SYNOLOGY_URL");
  if (!rawUrl) {
    throw new ConfigError(
      "SYNOLOGY_URL is required, for example https://192.168.1.10:5001",
    );
  }
  const user = str("SYNOLOGY_USER");
  const password = str("SYNOLOGY_PASSWORD");
  if (!user || !password) {
    throw new ConfigError(
      "SYNOLOGY_USER and SYNOLOGY_PASSWORD are required. Use a dedicated non-admin DSM account.",
    );
  }

  const transportRaw = (str("SYNOLOGY_MCP_TRANSPORT") ?? "http").toLowerCase();
  const transport =
    transportRaw === "stdio" ? "stdio" : ("http" as "http" | "stdio");
  if (!["http", "stdio", "sse"].includes(transportRaw)) {
    throw new ConfigError(
      `SYNOLOGY_MCP_TRANSPORT must be "http" or "stdio", received "${transportRaw}".`,
    );
  }

  // Over HTTP the token is the only thing between the network and the NAS,
  // so running without one has to be an explicit choice.
  const mcpToken = str("SYNOLOGY_MCP_TOKEN");
  if (transport === "http" && !mcpToken && !bool("SYNOLOGY_ALLOW_NO_AUTH", false)) {
    throw new ConfigError(
      "SYNOLOGY_MCP_TOKEN is required in HTTP mode. Set a long random token, or set SYNOLOGY_ALLOW_NO_AUTH=true to run without authentication (only behind another layer that authenticates clients).",
    );
  }

  const policy = new SecurityPolicy({
    readOnly: bool("SYNOLOGY_READONLY", true),
    allowDelete: bool("SYNOLOGY_ALLOW_DELETE", false),
    allowSystemControl: bool("SYNOLOGY_ALLOW_SYSTEM_CONTROL", false),
    allowGenericApi: bool("SYNOLOGY_ALLOW_GENERIC_API", false),
    allowedPaths: pathList("SYNOLOGY_ALLOWED_PATHS"),
    deniedPaths: pathList("SYNOLOGY_DENIED_PATHS"),
    maxReadBytes: int("SYNOLOGY_MAX_READ_BYTES", 1024 * 1024, 1024),
  });

  return {
    credentials: {
      baseUrl: normalizeBaseUrl(rawUrl),
      user,
      password,
      otp: str("SYNOLOGY_OTP"),
      insecureTls: bool("SYNOLOGY_INSECURE_TLS", false),
      sessionTtlMs: int("SYNOLOGY_SESSION_TTL_SECONDS", 1800, 60) * 1000,
      timeoutMs: int("SYNOLOGY_REQUEST_TIMEOUT_MS", 30_000, 1000),
      maxRetries: int("SYNOLOGY_MAX_RETRIES", 2, 0),
    },
    policy,
    transport,
    port: int("PORT", 3000, 1),
    host: str("HOST") ?? "0.0.0.0",
    mcpToken,
    logLevel: str("LOG_LEVEL") ?? "info",
  };
}
