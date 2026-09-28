/**
 * DSM reports failures as numeric codes inside a 200 OK body, and the meaning
 * of a code depends on which API family produced it. Code 400 is "wrong
 * password" for SYNO.API.Auth but "invalid file operation parameter" for
 * File Station, so the lookup has to be scoped.
 */

export type ErrorScope =
  | "common"
  | "auth"
  | "filestation"
  | "download"
  | "photos";

/** Applies to every DSM API. */
const COMMON: Record<number, string> = {
  100: "Unknown error.",
  101: "No parameter of API, method or version.",
  102: "The requested API does not exist on this DSM.",
  103: "The requested method does not exist.",
  104: "The requested version does not support this functionality.",
  105: "The logged-in session does not have permission. Grant the DSM account access to this feature or shared folder.",
  106: "Session timeout.",
  107: "Session interrupted by a duplicate login.",
  114: "Lost parameters for this API.",
  115: "Not allowed to upload a file.",
  116: "Not allowed to perform for a demo site.",
  117: "The network connection is unstable or the system is overloaded.",
  118: "Request failed because of an internal error.",
  119: "SID not found. The session is no longer valid.",
  150: "Request source IP does not match the login IP.",
};

const AUTH: Record<number, string> = {
  400: "No such account, or incorrect password.",
  401: "Disabled account.",
  402: "Permission denied. The account may lack the DSM application privilege required to sign in.",
  403: "2-step verification code required. Set SYNOLOGY_OTP, or use an account without 2FA.",
  404: "Failed to authenticate the 2-step verification code.",
  406: "Enforced 2-step verification. Enable it for this account or use another account.",
  407: "Blocked IP source. DSM auto-block may have banned the server address.",
  408: "Expired password cannot change.",
  409: "Expired password.",
  410: "Password must be changed before this account can be used.",
};

const FILESTATION: Record<number, string> = {
  400: "Invalid parameter of file operation.",
  401: "Unknown error of file operation.",
  402: "System is too busy.",
  403: "Invalid user for this file operation.",
  404: "Invalid group for this file operation.",
  405: "Invalid user and group for this file operation.",
  406: "Cannot get user or group information from the account server.",
  407: "Operation not permitted.",
  408: "No such file or directory.",
  409: "Non-supported file system.",
  410: "Failed to connect to the internet-based file system.",
  411: "Read-only file system.",
  412: "Filename too long in the non-encrypted file system.",
  413: "Filename too long in the encrypted file system.",
  414: "File already exists.",
  415: "Disk quota exceeded.",
  416: "No space left on device.",
  417: "Input/output error.",
  418: "Illegal name or path.",
  419: "Illegal file name.",
  420: "Illegal file name on FAT file system.",
  421: "Device or resource busy.",
  599: "No such task for this file operation.",
  // Delete
  900: "Failed to delete files or folders.",
  // Copy / move
  1000: "Failed to copy files or folders.",
  1001: "Failed to move files or folders.",
  1002: "An error occurred at the destination.",
  1003: "Cannot overwrite or skip an existing file because no overwrite parameter was given.",
  1004: "A file cannot overwrite a folder with the same name, or vice versa.",
  1006: "Cannot copy or move a name with special characters to a FAT32 file system.",
  1007: "Cannot copy or move a file larger than 4G to a FAT32 file system.",
  // Create folder
  1100: "Failed to create the folder.",
  1101: "The number of folders would exceed the system limitation.",
  // Rename
  1200: "Failed to rename it.",
  // Compress
  1300: "Failed to compress files or folders.",
  1301: "Cannot create the archive because the given archive name is too long.",
  // Extract
  1400: "Failed to extract files.",
  1401: "Cannot open the file as an archive.",
  1402: "Failed to read archive data.",
  1403: "Wrong archive password.",
  1404: "Failed to get the file and directory list in the archive.",
  1405: "Failed to find the item ID in the archive file.",
  // Background task
  1800: "There is no Content-Length information in the HTTP header.",
  1801: "Waited too long, no data received.",
  1802: "No filename information in the last part of the file content.",
  1803: "Upload connection was cancelled.",
  1804: "Failed to upload an oversized file to a FAT file system.",
  1805: "Cannot overwrite or skip the existing file.",
  // Sharing links
  2000: "Sharing link does not exist.",
  2001: "Cannot generate the sharing link.",
  2002: "The number of sharing links exceeds the limitation.",
  2003: "Failed to access sharing links.",
};

const DOWNLOAD: Record<number, string> = {
  400: "File upload failed.",
  401: "Maximum number of tasks reached.",
  402: "Destination denied.",
  403: "Destination does not exist.",
  404: "Invalid task id.",
  405: "Invalid task action.",
  406: "No default destination configured in Download Station.",
  407: "Set destination failed.",
  408: "File does not exist.",
};

const PHOTOS: Record<number, string> = {
  400: "Invalid parameter for Synology Photos.",
  401: "Unknown Synology Photos error.",
  641: "The requested item does not exist in Synology Photos.",
};

const SCOPES: Record<ErrorScope, Record<number, string>> = {
  common: {},
  auth: AUTH,
  filestation: FILESTATION,
  download: DOWNLOAD,
  photos: PHOTOS,
};

export class SynologyError extends Error {
  readonly code: number;
  readonly api: string;
  readonly method: string;
  readonly details: unknown;

  constructor(args: {
    code: number;
    api: string;
    method: string;
    message: string;
    details?: unknown;
  }) {
    super(args.message);
    this.name = "SynologyError";
    this.code = args.code;
    this.api = args.api;
    this.method = args.method;
    this.details = args.details;
  }

  /** DSM tells us the session died; the client retries these once. */
  get isSessionExpired(): boolean {
    return this.code === 106 || this.code === 107 || this.code === 119;
  }
}

/** Turns a DSM numeric code into an actionable sentence. */
export function describeDsmError(
  code: number,
  scope: ErrorScope,
  api: string,
): string {
  const scoped = SCOPES[scope]?.[code];
  if (scoped) return scoped;
  const common = COMMON[code];
  if (common) return common;
  return `DSM returned error code ${code} for ${api}.`;
}

/** Picks the right error table from the API name. */
export function scopeForApi(api: string): ErrorScope {
  if (api.startsWith("SYNO.API.Auth")) return "auth";
  if (api.startsWith("SYNO.FileStation")) return "filestation";
  if (api.startsWith("SYNO.DownloadStation")) return "download";
  if (api.startsWith("SYNO.Foto")) return "photos";
  return "common";
}

/** Renders any thrown value as text suitable for an MCP tool result. */
export function formatError(error: unknown): string {
  if (error instanceof SynologyError) {
    return `${error.message} (DSM code ${error.code}, api ${error.api}, method ${error.method})`;
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "The request to DSM timed out. Check that the server can reach SYNOLOGY_URL.";
    }
    return error.message;
  }
  return String(error);
}
