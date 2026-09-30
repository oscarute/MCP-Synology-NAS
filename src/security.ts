/**
 * A DSM account already limits what the server can touch. This policy is the
 * second, narrower gate: it exists so that handing the MCP server to an AI
 * client cannot escalate into destructive actions that the operator did not
 * explicitly switch on.
 */

export type SecurityOptions = {
  readOnly: boolean;
  allowDelete: boolean;
  allowSystemControl: boolean;
  allowGenericApi: boolean;
  allowedPaths: string[];
  deniedPaths: string[];
  maxReadBytes: number;
};

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export class SecurityPolicy {
  constructor(private readonly options: SecurityOptions) {}

  get readOnly(): boolean {
    return this.options.readOnly;
  }

  get maxReadBytes(): number {
    return this.options.maxReadBytes;
  }

  get allowDelete(): boolean {
    return !this.options.readOnly && this.options.allowDelete;
  }

  get allowGenericApi(): boolean {
    return this.options.allowGenericApi;
  }

  /** Any operation that changes state on the NAS. */
  assertWritable(action: string): void {
    if (this.options.readOnly) {
      throw new PolicyError(
        `Refused: "${action}" modifies the NAS but the server runs in read-only mode. Set SYNOLOGY_READONLY=false to allow it.`,
      );
    }
  }

  /** Deletion is gated separately because it is the one action with no undo. */
  assertDeletable(action: string): void {
    this.assertWritable(action);
    if (!this.options.allowDelete) {
      throw new PolicyError(
        `Refused: "${action}" permanently removes data. Set SYNOLOGY_ALLOW_DELETE=true to allow it.`,
      );
    }
  }

  /** Rebooting DSM, toggling services, controlling containers. */
  assertSystemControl(action: string): void {
    this.assertWritable(action);
    if (!this.options.allowSystemControl) {
      throw new PolicyError(
        `Refused: "${action}" controls system or container state. Set SYNOLOGY_ALLOW_SYSTEM_CONTROL=true to allow it.`,
      );
    }
  }

  assertGenericApi(api: string): void {
    if (!this.options.allowGenericApi) {
      throw new PolicyError(
        `Refused: the raw DSM WebAPI bridge is disabled, so "${api}" cannot be called. Set SYNOLOGY_ALLOW_GENERIC_API=true to allow it.`,
      );
    }
  }

  /**
   * File Station paths are rooted at the shared folder, e.g. "/Documents/a.txt".
   * Traversal segments are rejected outright rather than resolved, because a
   * resolved path can still escape an allowlist through a symlink on the NAS.
   */
  normalizePath(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) throw new PolicyError("Path must not be empty.");
    if (!trimmed.startsWith("/")) {
      throw new PolicyError(
        `Path must be absolute and start with the shared folder, for example "/Documents/report.pdf". Received "${input}".`,
      );
    }
    if (trimmed.includes("\0")) {
      throw new PolicyError("Path must not contain null bytes.");
    }
    const segments = trimmed.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new PolicyError(`Path traversal is not allowed: "${input}".`);
    }
    const collapsed = segments.filter((segment) => segment && segment !== ".");
    const normalized = "/" + collapsed.join("/");
    return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
  }

  /** Validates a single path against the allow and deny lists. */
  assertPathAllowed(input: string): string {
    const path = this.normalizePath(input);

    for (const denied of this.options.deniedPaths) {
      if (isWithin(path, denied)) {
        throw new PolicyError(
          `Refused: "${path}" is inside the denied path "${denied}".`,
        );
      }
    }

    if (this.options.allowedPaths.length === 0) return path;

    const permitted = this.options.allowedPaths.some(
      (allowed) => isWithin(path, allowed) || isWithin(allowed, path),
    );
    if (!permitted) {
      throw new PolicyError(
        `Refused: "${path}" is outside the allowed paths (${this.options.allowedPaths.join(", ")}).`,
      );
    }
    return path;
  }

  assertPathsAllowed(inputs: string[]): string[] {
    return inputs.map((input) => this.assertPathAllowed(input));
  }

  /** Exposed on the health endpoint so the active posture is auditable. */
  describe(): Record<string, unknown> {
    return {
      readOnly: this.options.readOnly,
      allowDelete: this.options.allowDelete,
      allowSystemControl: this.options.allowSystemControl,
      allowGenericApi: this.options.allowGenericApi,
      allowedPaths:
        this.options.allowedPaths.length > 0
          ? this.options.allowedPaths
          : "all paths reachable by the DSM account",
      deniedPaths: this.options.deniedPaths,
      maxReadBytes: this.options.maxReadBytes,
    };
  }
}

/** True when `path` equals `base` or sits underneath it. */
function isWithin(path: string, base: string): boolean {
  if (base === "/") return true;
  return path === base || path.startsWith(base.replace(/\/+$/, "") + "/");
}
