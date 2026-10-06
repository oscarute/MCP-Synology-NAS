import { z } from "zod";
import { defineTool, humanBytes } from "../tool.js";

type DownloadTask = {
  id: string;
  type: string;
  username: string;
  title: string;
  size: number;
  status: string;
  status_extra?: Record<string, unknown>;
  additional?: {
    detail?: {
      destination?: string;
      uri?: string;
      create_time?: string;
      completed_time?: string;
    };
    transfer?: {
      size_downloaded?: number;
      size_uploaded?: number;
      speed_download?: number;
      speed_upload?: number;
    };
  };
};

function summarizeTask(task: DownloadTask) {
  const transfer = task.additional?.transfer ?? {};
  const detail = task.additional?.detail ?? {};
  const downloaded = transfer.size_downloaded ?? 0;
  const percent =
    task.size > 0 ? Math.round((downloaded / task.size) * 1000) / 10 : 0;

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    size: humanBytes(task.size),
    progress: `${percent}%`,
    downloadSpeed: `${humanBytes(transfer.speed_download ?? 0)}/s`,
    uploadSpeed: `${humanBytes(transfer.speed_upload ?? 0)}/s`,
    destination: detail.destination,
    source: detail.uri,
  };
}

const TASK_ADDITIONAL = "detail,transfer,file";

export const downloadStationTools = [
  defineTool({
    name: "list_download_tasks",
    title: "List download tasks",
    description:
      "Lists every Download Station task with its status, progress and speed. Covers BitTorrent, HTTP, FTP, NZB and eMule downloads. Requires the Download Station package to be installed on the NAS.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
      statusFilter: z
        .enum([
          "all",
          "downloading",
          "paused",
          "finished",
          "seeding",
          "error",
          "waiting",
        ])
        .default("all"),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{
        tasks: DownloadTask[];
        total: number;
      }>("SYNO.DownloadStation.Task", "list", {
        offset: args.offset,
        limit: args.limit,
        additional: TASK_ADDITIONAL,
      });

      const tasks = (data.tasks ?? []).map(summarizeTask);
      const filtered =
        args.statusFilter === "all"
          ? tasks
          : tasks.filter((task) => task.status === args.statusFilter);

      return { total: data.total, returned: filtered.length, tasks: filtered };
    },
  }),

  defineTool({
    name: "get_download_task",
    title: "Get download task details",
    description:
      "Returns full details for specific Download Station tasks, including per-file progress and peer information.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      taskIds: z.array(z.string()).min(1).max(50),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{ tasks: DownloadTask[] }>(
        "SYNO.DownloadStation.Task",
        "getinfo",
        { id: args.taskIds.join(","), additional: TASK_ADDITIONAL },
      );
      return { tasks: (data.tasks ?? []).map(summarizeTask) };
    },
  }),

  defineTool({
    name: "create_download_task",
    title: "Start a download",
    description:
      "Queues a new download on the NAS from one or more URLs. Accepts HTTP, HTTPS, FTP and magnet links. The NAS downloads directly, so nothing transits this server.",
    schema: z.object({
      urls: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe("Download URLs or magnet links"),
      destination: z
        .string()
        .optional()
        .describe(
          "Shared-folder path to save into, e.g. Downloads. Omit to use the Download Station default.",
        ),
      username: z
        .string()
        .optional()
        .describe("Credential for a source that requires login"),
      password: z.string().optional(),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertWritable("create_download_task");
      if (args.destination) {
        // Destination is share-relative here, so normalize with a leading slash.
        ctx.policy.assertPathAllowed(
          args.destination.startsWith("/")
            ? args.destination
            : `/${args.destination}`,
        );
      }

      await ctx.client.request(
        "SYNO.DownloadStation.Task",
        "create",
        {
          uri: args.urls.join(","),
          destination: args.destination?.replace(/^\//, ""),
          username: args.username,
          password: args.password,
        },
        { method: "POST" },
      );

      return {
        queued: args.urls.length,
        urls: args.urls,
        destination: args.destination ?? "Download Station default",
        note: "Use list_download_tasks to watch progress.",
      };
    },
  }),

  defineTool({
    name: "control_download_task",
    title: "Pause, resume or remove downloads",
    description:
      "Pauses, resumes or deletes Download Station tasks. Deleting a task can optionally leave the already downloaded data on the NAS. Deletion requires SYNOLOGY_ALLOW_DELETE=true.",
    destructive: true,
    schema: z.object({
      taskIds: z.array(z.string()).min(1).max(50),
      titles: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe(
          "Title of each task, in the same order as taskIds, exactly as list_download_tasks shows it. Shown to the user when they approve the call, and checked against DSM before acting.",
        ),
      action: z.enum(["pause", "resume", "delete"]),
      keepDownloadedData: z
        .boolean()
        .default(true)
        .describe("Only used with delete; keeps partially downloaded files"),
    }),
    handler: async (ctx, args) => {
      const ids = args.taskIds.join(",");

      // The titles are what the user sees when approving the call, so refuse
      // to act unless they really name the tasks being changed.
      if (args.titles.length !== args.taskIds.length) {
        throw new Error("titles must list one title per task id, in the same order.");
      }
      const current = await ctx.client.request<{ tasks: DownloadTask[] }>(
        "SYNO.DownloadStation.Task",
        "getinfo",
        { id: ids },
      );
      const titleById = new Map((current.tasks ?? []).map((task) => [task.id, task.title]));
      const mismatched = args.taskIds.filter((id, index) => titleById.get(id) !== args.titles[index]);
      if (mismatched.length > 0) {
        throw new Error(
          `Refused: the titles do not match DSM for ${mismatched.map((id) => `${id} (DSM: ${titleById.get(id) ?? "no such task"})`).join(", ")}. Call list_download_tasks and retry with the exact titles.`,
        );
      }

      if (args.action === "delete") {
        ctx.policy.assertDeletable("control_download_task(delete)");
        const result = await ctx.client.request(
          "SYNO.DownloadStation.Task",
          "delete",
          { id: ids, force_complete: args.keepDownloadedData },
        );
        return { action: "delete", taskIds: args.taskIds, titles: args.titles, result };
      }

      ctx.policy.assertWritable(`control_download_task(${args.action})`);
      const result = await ctx.client.request(
        "SYNO.DownloadStation.Task",
        args.action,
        { id: ids },
      );
      return { action: args.action, taskIds: args.taskIds, titles: args.titles, result };
    },
  }),

  defineTool({
    name: "get_download_station_info",
    title: "Download Station status",
    description:
      "Returns Download Station version, global transfer statistics and the current schedule configuration, including whether downloads are throttled right now.",
    readOnly: true,
    idempotent: true,
    schema: z.object({}),
    handler: async (ctx) => {
      const [info, stats, schedule] = await Promise.all([
        ctx.client
          .request<Record<string, unknown>>(
            "SYNO.DownloadStation.Info",
            "getinfo",
          )
          .catch(() => null),
        ctx.client
          .request<Record<string, number>>(
            "SYNO.DownloadStation.Statistic",
            "getinfo",
          )
          .catch(() => null),
        ctx.client
          .request<Record<string, unknown>>(
            "SYNO.DownloadStation.Schedule",
            "getconfig",
          )
          .catch(() => null),
      ]);

      return {
        version: info?.version_string ?? info?.version,
        managerEnabled: info?.is_manager,
        currentDownloadSpeed: humanBytes(stats?.speed_download ?? 0) + "/s",
        currentUploadSpeed: humanBytes(stats?.speed_upload ?? 0) + "/s",
        schedule,
      };
    },
  }),
];
