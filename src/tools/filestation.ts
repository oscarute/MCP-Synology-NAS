import { z } from "zod";
import type { DsmClient } from "../client.js";
import { SynologyError } from "../errors.js";
import { defineTool, humanBytes, isoTime, pathParam } from "../tool.js";

/** Shape of a File Station file/folder entry, trimmed to the useful fields. */
type FileEntry = {
  path: string;
  name: string;
  isdir: boolean;
  additional?: {
    size?: number;
    time?: { mtime?: number; crtime?: number; atime?: number };
    type?: string;
    owner?: { user?: string; group?: string };
    perm?: { posix?: number };
  };
};

/**
 * The default additional fields. Requesting these up front avoids a second
 * round trip for size and modified time, which the model almost always wants.
 */
const DEFAULT_ADDITIONAL = pathParam([
  "size",
  "time",
  "type",
  "owner",
  "perm",
]);

function summarizeEntry(entry: FileEntry) {
  const extra = entry.additional ?? {};
  return {
    name: entry.name,
    path: entry.path,
    type: entry.isdir ? "folder" : "file",
    size: entry.isdir ? undefined : extra.size,
    sizeHuman: entry.isdir ? undefined : humanBytes(extra.size ?? 0),
    modified: isoTime(extra.time?.mtime),
    created: isoTime(extra.time?.crtime),
    owner: extra.owner?.user,
    group: extra.owner?.group,
  };
}

/**
 * Some DSM builds evict a File Station background task as soon as it
 * completes, so the status poll reports 599 "no such task" for work that
 * actually finished. Maps that case to null; any other failure still rejects.
 */
function statusOrEvicted<T>(request: Promise<T>): Promise<T | null> {
  return request.catch((error) =>
    error instanceof SynologyError && error.code === 599
      ? null
      : Promise.reject(error),
  );
}

/**
 * The 599 is intermittent: the same MD5 task often succeeds on the next
 * call. Polling once more after this delay recovers DSM's own result, which
 * is far cheaper than a fallback, before giving up on the task.
 */
const EVICTION_RETRY_MS = 1000;

/**
 * Fresh MD5 tasks started after DSM loses one. The task that was lost is
 * stopped first, in case a lingering task is what blocks the next.
 */
const MAX_MD5_RESTARTS = 2;

/**
 * MD5 tasks this server started and has not yet reported, keyed by DSM task
 * id. get_file_checksum_result only accepts these ids, so it cannot be used
 * to probe other DSM tasks, and it can name the file in its answer.
 */
const pendingChecksums = new Map<string, string>();
const MAX_PENDING_CHECKSUMS = 100;

type Md5Status = { finished: boolean; md5?: string };

/** One status poll, with the single retry that recovers a transient 599. */
async function pollMd5(client: DsmClient, taskid: string): Promise<Md5Status | null> {
  const poll = () =>
    statusOrEvicted(
      client.request<Md5Status>("SYNO.FileStation.MD5", "status", { taskid }),
    );
  const first = await poll();
  if (first) return first;
  await new Promise((resolve) => setTimeout(resolve, EVICTION_RETRY_MS));
  return poll();
}

/**
 * Sums a folder tree through the listing API: slower than the DirSize task,
 * but unaffected by task eviction. Stops descending once the deadline passes
 * and reports the result as incomplete.
 */
async function folderSizeByListing(
  client: DsmClient,
  root: string,
  deadline: number,
): Promise<{ folders: number; files: number; totalSize: number; complete: boolean }> {
  const totals = { folders: 0, files: 0, totalSize: 0, complete: true };

  const walk = async (dir: string): Promise<void> => {
    for (let offset = 0; ; ) {
      if (Date.now() >= deadline) {
        totals.complete = false;
        return;
      }
      const page = await client.request<{ files?: FileEntry[]; total: number }>(
        "SYNO.FileStation.List",
        "list",
        {
          folder_path: dir,
          offset,
          limit: 1000,
          additional: pathParam(["size"]),
        },
      );
      const entries = page.files ?? [];
      for (const entry of entries) {
        if (entry.isdir) {
          totals.folders += 1;
          await walk(entry.path);
        } else {
          totals.files += 1;
          totals.totalSize += entry.additional?.size ?? 0;
        }
      }
      offset += entries.length;
      if (entries.length === 0 || offset >= (page.total ?? 0)) return;
    }
  };

  await walk(root);
  return totals;
}

export const fileStationReadTools = [
  defineTool({
    name: "list_shared_folders",
    title: "List shared folders",
    description:
      "Lists the top-level shared folders on the Synology NAS that the configured DSM account can access. Start here when you do not yet know which paths exist, because every other File Station path is rooted at one of these shared folders.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(100),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{
        shares: FileEntry[];
        total: number;
      }>("SYNO.FileStation.List", "list_share", {
        offset: args.offset,
        limit: args.limit,
        additional: DEFAULT_ADDITIONAL,
      });

      return {
        total: data.total,
        shares: (data.shares ?? []).map(summarizeEntry),
      };
    },
  }),

  defineTool({
    name: "list_files",
    title: "List folder contents",
    description:
      "Lists files and subfolders inside a folder. The path is rooted at a shared folder, for example '/Documents/Reports'. Use list_shared_folders first if the shared folder name is unknown. Supports paging and sorting for large directories.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      path: z
        .string()
        .describe("Folder path rooted at a shared folder, e.g. /Documents"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(100),
      sortBy: z
        .enum(["name", "size", "user", "group", "mtime", "crtime", "type"])
        .default("name"),
      sortDirection: z.enum(["asc", "desc"]).default("asc"),
      filterExtensions: z
        .array(z.string())
        .optional()
        .describe("Only return files with these extensions, e.g. ['pdf','docx']"),
      onlyFolders: z.boolean().default(false),
    }),
    handler: async (ctx, args) => {
      const folder = ctx.policy.assertPathAllowed(args.path);

      const data = await ctx.client.request<{
        files: FileEntry[];
        total: number;
      }>("SYNO.FileStation.List", "list", {
        folder_path: folder,
        offset: args.offset,
        limit: args.limit,
        sort_by: args.sortBy,
        sort_direction: args.sortDirection,
        additional: DEFAULT_ADDITIONAL,
        filetype: args.onlyFolders ? "dir" : "all",
        pattern: args.filterExtensions?.length
          ? pathParam(args.filterExtensions.map((ext) => `*.${ext.replace(/^\./, "")}`))
          : undefined,
      });

      return {
        folder,
        total: data.total,
        returned: (data.files ?? []).length,
        files: (data.files ?? []).map(summarizeEntry),
      };
    },
  }),

  defineTool({
    name: "get_file_info",
    title: "Get file or folder details",
    description:
      "Returns detailed metadata for one or more files or folders: size, timestamps, owner, permissions and MIME type. Use this to confirm a file exists before acting on it.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      paths: z.array(z.string()).min(1).max(100),
    }),
    handler: async (ctx, args) => {
      const paths = ctx.policy.assertPathsAllowed(args.paths);
      const data = await ctx.client.request<{ files: FileEntry[] }>(
        "SYNO.FileStation.List",
        "getinfo",
        { path: pathParam(paths), additional: DEFAULT_ADDITIONAL },
      );
      return { files: (data.files ?? []).map(summarizeEntry) };
    },
  }),

  defineTool({
    name: "search_files",
    title: "Search for files",
    description:
      "Searches a folder tree by filename pattern, extension, size or modified time with a File Station background search. DSM walks the folders on the NAS itself, so it is cheaper than listing them recursively through this server, but large trees can take a while. Returns once the search finishes or the timeout elapses, with partial results if it is still running.",
    readOnly: true,
    schema: z.object({
      path: z.string().describe("Folder to search under, e.g. /Documents"),
      pattern: z
        .string()
        .optional()
        .describe("Filename pattern; substrings match, e.g. 'invoice'"),
      extensions: z
        .array(z.string())
        .optional()
        .describe("Restrict to these file extensions, e.g. ['pdf']"),
      fileType: z.enum(["file", "dir", "all"]).default("all"),
      modifiedAfter: z
        .string()
        .optional()
        .describe("ISO date; only return items modified at or after this time"),
      minSizeBytes: z.number().int().min(0).optional(),
      maxSizeBytes: z.number().int().min(0).optional(),
      recursive: z.boolean().default(true),
      limit: z.number().int().min(1).max(500).default(100),
      timeoutSeconds: z.number().int().min(2).max(60).default(20),
    }),
    handler: async (ctx, args) => {
      const folder = ctx.policy.assertPathAllowed(args.path);

      // DSM search is asynchronous: start it, poll, then always clean up the
      // task so repeated searches do not accumulate on the NAS.
      const started = await ctx.client.request<{ taskid: string }>(
        "SYNO.FileStation.Search",
        "start",
        {
          folder_path: folder,
          recursive: args.recursive,
          pattern: args.pattern,
          extension: args.extensions?.length
            ? args.extensions.map((e) => e.replace(/^\./, "")).join(",")
            : undefined,
          filetype: args.fileType,
          size_from: args.minSizeBytes,
          size_to: args.maxSizeBytes,
          mtime_from: args.modifiedAfter
            ? Math.floor(new Date(args.modifiedAfter).getTime() / 1000)
            : undefined,
        },
      );

      const taskId = started.taskid;
      const deadline = Date.now() + args.timeoutSeconds * 1000;

      try {
        let finished = false;
        let result: { files: FileEntry[]; total: number } = {
          files: [],
          total: 0,
        };

        while (Date.now() < deadline) {
          const page = await ctx.client.request<{
            finished: boolean;
            files: FileEntry[];
            total: number;
          }>("SYNO.FileStation.Search", "list", {
            taskid: taskId,
            offset: 0,
            limit: args.limit,
            additional: DEFAULT_ADDITIONAL,
          });

          result = { files: page.files ?? [], total: page.total ?? 0 };
          finished = page.finished === true;
          if (finished) break;
          await new Promise((resolve) => setTimeout(resolve, 700));
        }

        return {
          searchRoot: folder,
          complete: finished,
          total: result.total,
          returned: result.files.length,
          note: finished
            ? undefined
            : "The DSM search was still running when the timeout elapsed; these are partial results. Narrow the pattern or raise timeoutSeconds.",
          files: result.files.map(summarizeEntry),
        };
      } finally {
        await ctx.client
          .request("SYNO.FileStation.Search", "stop", { taskid: taskId })
          .catch(() => undefined);
      }
    },
  }),

  defineTool({
    name: "read_file",
    title: "Read a text file",
    description:
      "Downloads a text file from the NAS and returns its contents. Intended for documents, notes, configs, CSV and code. Binary files are rejected, and the size is capped by SYNOLOGY_MAX_READ_BYTES so a large file cannot flood the conversation.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      path: z.string().describe("Full file path, e.g. /Documents/notes.md"),
      encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Override the read cap, still bounded by the server limit"),
    }),
    handler: async (ctx, args) => {
      const path = ctx.policy.assertPathAllowed(args.path);
      const cap = Math.min(
        args.maxBytes ?? ctx.policy.maxReadBytes,
        ctx.policy.maxReadBytes,
      );

      // Check the size first so an oversized file is refused before transfer.
      const info = await ctx.client.request<{ files: FileEntry[] }>(
        "SYNO.FileStation.List",
        "getinfo",
        { path: pathParam([path]), additional: pathParam(["size"]) },
      );
      const entry = info.files?.[0];
      if (!entry) throw new Error(`No such file on the NAS: ${path}`);
      if (entry.isdir) throw new Error(`${path} is a folder, not a file.`);

      const size = entry.additional?.size ?? 0;
      if (size > cap) {
        throw new Error(
          `${path} is ${humanBytes(size)}, which exceeds the read limit of ${humanBytes(cap)}. Raise SYNOLOGY_MAX_READ_BYTES or use create_sharing_link to hand the file over directly.`,
        );
      }

      const { bytes } = await ctx.client.requestBinary(
        "SYNO.FileStation.Download",
        "download",
        { path: pathParam([path]), mode: "download" },
      );

      if (args.encoding === "base64") {
        return {
          path,
          bytes: bytes.length,
          encoding: "base64",
          content: Buffer.from(bytes).toString("base64"),
        };
      }

      const text = Buffer.from(bytes).toString("utf-8");
      // A replacement character in the first block means this is not text.
      if (text.slice(0, 4096).includes("\uFFFD")) {
        throw new Error(
          `${path} does not appear to be UTF-8 text. Read it with encoding "base64", or share it with create_sharing_link.`,
        );
      }

      return {
        path,
        bytes: bytes.length,
        encoding: "utf-8",
        content: text,
      };
    },
  }),

  defineTool({
    name: "get_folder_size",
    title: "Calculate folder size",
    description:
      "Recursively calculates the total size and item count of one or more folders. Useful for finding what is consuming storage. This runs as a DSM background job and is polled until it completes.",
    readOnly: true,
    schema: z.object({
      paths: z.array(z.string()).min(1).max(20),
      timeoutSeconds: z.number().int().min(2).max(120).default(30),
    }),
    handler: async (ctx, args) => {
      const paths = ctx.policy.assertPathsAllowed(args.paths);
      const started = await ctx.client.request<{ taskid: string }>(
        "SYNO.FileStation.DirSize",
        "start",
        { path: pathParam(paths) },
      );

      const deadline = Date.now() + args.timeoutSeconds * 1000;
      let retried = false;
      try {
        while (Date.now() < deadline) {
          const status = await statusOrEvicted(
            ctx.client.request<{
              finished: boolean;
              num_dir: number;
              num_file: number;
              total_size: number;
            }>("SYNO.FileStation.DirSize", "status", { taskid: started.taskid }),
          );

          if (!status && !retried) {
            retried = true;
            await new Promise((resolve) => setTimeout(resolve, EVICTION_RETRY_MS));
            continue;
          }
          if (!status) {
            let folders = 0;
            let files = 0;
            let totalBytes = 0;
            let complete = true;
            for (const dir of paths) {
              const sub = await folderSizeByListing(ctx.client, dir, deadline);
              folders += sub.folders;
              files += sub.files;
              totalBytes += sub.totalSize;
              complete &&= sub.complete;
            }
            return {
              paths,
              folders,
              files,
              totalBytes,
              totalSize: humanBytes(totalBytes),
              method: "listing",
              ...(complete
                ? {}
                : {
                    complete: false,
                    note: "DSM evicted the size task and the listing walk hit the timeout, so these totals are partial. Raise timeoutSeconds for very large folders.",
                  }),
            };
          }

          if (status.finished) {
            return {
              paths,
              folders: status.num_dir,
              files: status.num_file,
              totalBytes: status.total_size,
              totalSize: humanBytes(status.total_size),
              method: "dsm",
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        return {
          paths,
          complete: false,
          note: "The size calculation was still running when the timeout elapsed. Raise timeoutSeconds for very large folders.",
        };
      } finally {
        await ctx.client
          .request("SYNO.FileStation.DirSize", "stop", {
            taskid: started.taskid,
          })
          .catch(() => undefined);
      }
    },
  }),

  defineTool({
    name: "get_file_checksum",
    title: "Compute a file checksum",
    description:
      "Computes the MD5 checksum of a file on the NAS with a DSM background task, for verifying an upload or comparing two copies. Waits up to waitSeconds; if DSM is still hashing (large files), returns status \"running\" and a taskid to pass to get_file_checksum_result, while DSM keeps working. If DSM loses the task at start, it is restarted a limited number of times.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      path: z.string(),
      // Kept well below the 60 s at which MCP clients commonly abort a call.
      waitSeconds: z.number().int().min(1).max(50).default(20),
    }),
    handler: async (ctx, args) => {
      const path = ctx.policy.assertPathAllowed(args.path);
      const start = async (): Promise<string> =>
        (
          await ctx.client.request<{ taskid: string }>(
            "SYNO.FileStation.MD5",
            "start",
            { file_path: path },
          )
        ).taskid;
      const stop = (taskid: string): Promise<unknown> =>
        ctx.client
          .request("SYNO.FileStation.MD5", "stop", { taskid })
          .catch(() => undefined);

      const deadline = Date.now() + args.waitSeconds * 1000;
      let taskid = await start();
      let attempts = 1;
      for (;;) {
        const status = await pollMd5(ctx.client, taskid);
        if (!status) {
          await stop(taskid);
          if (attempts > MAX_MD5_RESTARTS) {
            throw new Error(
              `DSM lost the checksum task for ${path} on all ${attempts} attempts, so no checksum was produced. Retry the call; DSM's task usually succeeds on a later try.`,
            );
          }
          taskid = await start();
          attempts += 1;
          continue;
        }
        if (status.finished) {
          return { path, status: "done", md5: status.md5, attempts };
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }

      // Still hashing: leave the task running and hand back its id.
      if (pendingChecksums.size >= MAX_PENDING_CHECKSUMS) {
        const oldest = pendingChecksums.keys().next().value;
        if (oldest !== undefined) pendingChecksums.delete(oldest);
      }
      pendingChecksums.set(taskid, path);
      return {
        path,
        status: "running",
        taskid,
        attempts,
        note: "DSM is still hashing this file. Call get_file_checksum_result with this taskid in 15-30 seconds, and again until status is done.",
      };
    },
  }),

  defineTool({
    name: "get_file_checksum_result",
    title: "Get a pending file checksum",
    description:
      "Checks a checksum started by get_file_checksum that returned status \"running\". Returns status done with the MD5, running (check again later), or lost (DSM dropped the task; call get_file_checksum again).",
    readOnly: true,
    schema: z.object({
      taskid: z.string().describe("The taskid returned by get_file_checksum"),
    }),
    handler: async (ctx, args) => {
      const path = pendingChecksums.get(args.taskid);
      if (!path) {
        throw new Error(
          `Unknown checksum task "${args.taskid}". It was already reported, or the server restarted since it was started. Call get_file_checksum again.`,
        );
      }

      const status = await pollMd5(ctx.client, args.taskid);
      if (!status) {
        pendingChecksums.delete(args.taskid);
        return {
          path,
          status: "lost",
          note: "DSM dropped the task before it finished. Call get_file_checksum again.",
        };
      }
      if (status.finished) {
        pendingChecksums.delete(args.taskid);
        return { path, status: "done", md5: status.md5 };
      }
      return {
        path,
        status: "running",
        note: "Still hashing. Check again in 15-30 seconds.",
      };
    },
  }),
];
