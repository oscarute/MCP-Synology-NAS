import { Agent, type Dispatcher } from "undici";
import type { DsmCredentials } from "./config.js";
import { SynologyError, describeDsmError, scopeForApi } from "./errors.js";

/** One entry of the SYNO.API.Info discovery map. */
export type ApiDescriptor = {
  path: string;
  minVersion: number;
  maxVersion: number;
  requestFormat?: string;
};

export type ApiInfoMap = Record<string, ApiDescriptor>;

type DsmEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: { code: number; errors?: unknown };
};

/**
 * The only body shapes this client sends. Spelled out rather than using the
 * DOM's BodyInit, which is not in scope for a Node-only compilation.
 */
type RequestBody = string | FormData;

type FetchInit = {
  method: string;
  body?: RequestBody;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export type RequestOptions = {
  /**
   * Preferred API version. The client clamps it to the range the DSM actually
   * advertises, so the same tool works across DSM 6 and DSM 7.
   */
  version?: number;
  /** Force POST, required when parameters are long (e.g. many file paths). */
  method?: "GET" | "POST";
  timeoutMs?: number;
};

/** DSM wants scalars as bare strings and structured values as JSON text. */
function encodeParam(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function buildSearchParams(params: Record<string, unknown>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, encodeParam(value));
  }
  return search;
}

export class DsmClient {
  private sid: string | null = null;
  private sessionCreatedAt = 0;
  private apiInfo: ApiInfoMap | null = null;
  private loginInFlight: Promise<void> | null = null;
  private readonly dispatcher?: Dispatcher;

  constructor(private readonly credentials: DsmCredentials) {
    // A NAS on the LAN almost always presents a self-signed certificate. This
    // is scoped to this client rather than disabling TLS checks process-wide.
    if (credentials.insecureTls) {
      this.dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  // ---------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------

  /**
   * SYNO.API.Info is the only endpoint with a fixed path. Everything else is
   * looked up here, which is what lets the server work against DSM versions
   * that moved an API to a different CGI handler.
   */
  async getApiInfo(): Promise<ApiInfoMap> {
    if (this.apiInfo) return this.apiInfo;

    const url = new URL("/webapi/query.cgi", this.credentials.baseUrl);
    url.search = buildSearchParams({
      api: "SYNO.API.Info",
      version: 1,
      method: "query",
      query: "all",
    }).toString();

    const envelope = await this.fetchJson<ApiInfoMap>(url, { method: "GET" });
    this.apiInfo = this.unwrap(envelope, "SYNO.API.Info", "query");
    return this.apiInfo;
  }

  /** Clamps a preferred version into the range this DSM supports. */
  private async resolve(
    api: string,
    preferred?: number,
  ): Promise<{ path: string; version: number }> {
    const info = await this.getApiInfo();
    const descriptor = info[api];

    if (!descriptor) {
      throw new SynologyError({
        code: 102,
        api,
        method: "resolve",
        message: `The API "${api}" is not available on this DSM. The package may not be installed, or the account may not have permission to see it.`,
      });
    }

    const wanted = preferred ?? descriptor.maxVersion;
    const version = Math.min(
      Math.max(wanted, descriptor.minVersion),
      descriptor.maxVersion,
    );
    return { path: descriptor.path, version };
  }

  // ---------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------

  private get sessionExpired(): boolean {
    if (!this.sid) return true;
    return Date.now() - this.sessionCreatedAt > this.credentials.sessionTtlMs;
  }

  /** Concurrent tool calls share a single in-flight login. */
  async ensureSession(): Promise<void> {
    if (!this.sessionExpired) return;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async login(): Promise<void> {
    const { path, version } = await this.resolve("SYNO.API.Auth", 6);

    const params: Record<string, unknown> = {
      api: "SYNO.API.Auth",
      version,
      method: "login",
      account: this.credentials.user,
      passwd: this.credentials.password,
      session: "FileStation",
      format: "sid",
    };
    if (this.credentials.otp) params.otp_code = this.credentials.otp;

    const url = new URL(`/webapi/${path}`, this.credentials.baseUrl);

    // Credentials go in the body so they never land in a proxy access log.
    const envelope = await this.fetchJson<{ sid: string }>(url, {
      method: "POST",
      body: buildSearchParams(params).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    const data = this.unwrap(envelope, "SYNO.API.Auth", "login");
    if (!data?.sid) {
      throw new SynologyError({
        code: 400,
        api: "SYNO.API.Auth",
        method: "login",
        message: "DSM accepted the login request but returned no session id.",
      });
    }
    this.sid = data.sid;
    this.sessionCreatedAt = Date.now();
  }

  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      const { path, version } = await this.resolve("SYNO.API.Auth", 6);
      const url = new URL(`/webapi/${path}`, this.credentials.baseUrl);
      url.search = buildSearchParams({
        api: "SYNO.API.Auth",
        version,
        method: "logout",
        session: "FileStation",
        _sid: this.sid,
      }).toString();
      await this.fetchJson(url, { method: "GET" });
    } catch {
      // A failed logout must never mask the real shutdown reason.
    } finally {
      this.sid = null;
    }
  }

  // ---------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------

  /**
   * Calls any DSM API and returns the unwrapped `data` payload.
   * Retries once, after re-authenticating, if DSM says the session died.
   */
  async request<T = unknown>(
    api: string,
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<T> {
    return this.withSessionRetry(async () => {
      const { path, version } = await this.resolve(api, options.version);
      const url = new URL(`/webapi/${path}`, this.credentials.baseUrl);

      const payload = buildSearchParams({
        ...params,
        api,
        version,
        method,
        _sid: this.sid,
      });

      const usePost =
        options.method === "POST" || payload.toString().length > 1800;

      let envelope: DsmEnvelope<T>;
      if (usePost) {
        envelope = await this.fetchJson<T>(url, {
          method: "POST",
          body: payload.toString(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          timeoutMs: options.timeoutMs,
        });
      } else {
        url.search = payload.toString();
        envelope = await this.fetchJson<T>(url, {
          method: "GET",
          timeoutMs: options.timeoutMs,
        });
      }

      return this.unwrap(envelope, api, method);
    });
  }

  /**
   * Streams raw bytes, used by file download and thumbnails. DSM signals
   * failure here with a JSON body instead of the file, so that is detected.
   */
  async requestBinary(
    api: string,
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    return this.withSessionRetry(async () => {
      const { path, version } = await this.resolve(api, options.version);
      const url = new URL(`/webapi/${path}`, this.credentials.baseUrl);
      url.search = buildSearchParams({
        ...params,
        api,
        version,
        method,
        _sid: this.sid,
      }).toString();

      const response = await this.rawFetch(url, {
        method: "GET",
        timeoutMs: options.timeoutMs,
      });
      const contentType = response.headers.get("content-type") ?? "";

      if (contentType.includes("application/json")) {
        const envelope = (await response.json()) as DsmEnvelope<unknown>;
        this.unwrap(envelope, api, method);
      }

      const buffer = await response.arrayBuffer();
      return { bytes: new Uint8Array(buffer), contentType };
    });
  }

  /** Multipart upload; DSM requires the file part to be named "file". */
  async requestUpload<T = unknown>(
    api: string,
    method: string,
    fields: Record<string, unknown>,
    file: { filename: string; bytes: Uint8Array; contentType?: string },
    options: RequestOptions = {},
  ): Promise<T> {
    return this.withSessionRetry(async () => {
      const { path, version } = await this.resolve(api, options.version);
      const url = new URL(`/webapi/${path}`, this.credentials.baseUrl);

      const form = new FormData();
      form.set("api", api);
      form.set("version", String(version));
      form.set("method", method);
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        form.set(key, encodeParam(value));
      }
      form.set(
        "file",
        new Blob([file.bytes], {
          type: file.contentType ?? "application/octet-stream",
        }),
        file.filename,
      );

      url.search = buildSearchParams({ _sid: this.sid }).toString();

      const envelope = await this.fetchJson<T>(url, {
        method: "POST",
        body: form,
        timeoutMs: options.timeoutMs ?? 120_000,
      });
      return this.unwrap(envelope, api, method);
    });
  }

  /** Builds an authenticated URL without performing the request. */
  async buildUrl(
    api: string,
    method: string,
    params: Record<string, unknown> = {},
    version?: number,
  ): Promise<string> {
    await this.ensureSession();
    const resolved = await this.resolve(api, version);
    const url = new URL(`/webapi/${resolved.path}`, this.credentials.baseUrl);
    url.search = buildSearchParams({
      ...params,
      api,
      version: resolved.version,
      method,
      _sid: this.sid,
    }).toString();
    return url.toString();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * DSM invalidates sessions aggressively (duplicate login, idle timeout,
   * reboot). Rather than surfacing that to the model as a tool failure, the
   * client re-authenticates once and replays the call.
   */
  private async withSessionRetry<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureSession();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SynologyError && error.isSessionExpired) {
        this.sid = null;
        await this.ensureSession();
        return operation();
      }
      throw error;
    }
  }

  private unwrap<T>(envelope: DsmEnvelope<T>, api: string, method: string): T {
    if (envelope.success) return envelope.data as T;

    const code = envelope.error?.code ?? 100;
    throw new SynologyError({
      code,
      api,
      method,
      message: describeDsmError(code, scopeForApi(api), api),
      details: envelope.error?.errors,
    });
  }

  private async fetchJson<T>(
    url: URL,
    init: FetchInit,
  ): Promise<DsmEnvelope<T>> {
    const response = await this.rawFetch(url, init);
    const text = await response.text();
    try {
      return JSON.parse(text) as DsmEnvelope<T>;
    } catch {
      throw new Error(
        `DSM returned a non-JSON response (HTTP ${response.status}). Check that SYNOLOGY_URL points at the DSM web interface and not a reverse proxy that rewrites it.`,
      );
    }
  }

  /** Single place where the timeout, TLS agent and retry loop are applied. */
  private async rawFetch(url: URL, init: FetchInit): Promise<Response> {
    const timeoutMs = init.timeoutMs ?? this.credentials.timeoutMs;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.credentials.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url.toString(), {
          method: init.method,
          body: init.body,
          headers: init.headers,
          signal: controller.signal,
          // @ts-expect-error dispatcher is an undici extension to fetch init
          dispatcher: this.dispatcher,
        });

        // 5xx from DSM is usually transient overload; 4xx is not retryable.
        if (response.status >= 500 && attempt < this.credentials.maxRetries) {
          lastError = new Error(`DSM responded with HTTP ${response.status}.`);
          await delay(300 * 2 ** attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt === this.credentials.maxRetries) break;
        await delay(300 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw normalizeNetworkError(lastError, this.credentials.baseUrl);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turns opaque fetch failures into something the operator can act on. */
function normalizeNetworkError(error: unknown, baseUrl: string): Error {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    const code = cause?.code;

    if (error.name === "AbortError") {
      return new Error(
        `Timed out contacting DSM at ${baseUrl}. Verify the tunnel to the NAS is up.`,
      );
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return new Error(
        `Cannot resolve the DSM hostname in ${baseUrl}. Check SYNOLOGY_URL and DNS.`,
      );
    }
    if (code === "ECONNREFUSED") {
      return new Error(
        `Connection refused by ${baseUrl}. Check the DSM port and that the tunnel forwards it.`,
      );
    }
    if (
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
      code === "SELF_SIGNED_CERT_IN_CHAIN"
    ) {
      return new Error(
        "DSM uses a self-signed certificate. Set SYNOLOGY_INSECURE_TLS=true if this is a trusted LAN or tunnel.",
      );
    }
    return error;
  }
  return new Error(String(error));
}
