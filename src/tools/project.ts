import { hostname } from "node:os";
import { z } from "zod";
import type { DsmClient } from "../client.js";
import { defineTool, humanBytes, type ToolContext } from "../tool.js";

/**
 * Container Manager projects (Docker Compose) on DSM 7.2. These APIs are not
 * in Synology's published guides; method names and behaviour were verified on
 * a live NAS. Project "start" only resumes the existing containers, so an
 * image update needs "build", which recreates the containers whose image
 * changed.
 */

type Project = {
  id: string;
  name: string;
  status: string;
  path: string;
  containerIds: string[];
};

type Container = {
  id: string;
  name: string;
  image: string;
  ImageID: string;
  status: string;
  Labels?: Record<string, string>;
};

type Image = {
  id: string;
  repository: string;
  tags: string[];
  size: number;
  upgradable: boolean;
};

// Compose up/down on a slow NAS takes a few seconds, but waiting on a healthy
// dependency can take longer than the default request timeout.
const PROJECT_TIMEOUT_MS = 55_000;

async function listProjects(client: DsmClient): Promise<Project[]> {
  const data = await client.request<Record<string, Project>>(
    "SYNO.Docker.Project",
    "list",
  );
  return Object.values(data ?? {});
}

async function listAllContainers(client: DsmClient): Promise<Container[]> {
  const data = await client.request<{ containers: Container[] }>(
    "SYNO.Docker.Container",
    "list",
    { offset: 0, limit: 200, type: "all" },
  );
  return data.containers ?? [];
}

async function listImages(client: DsmClient): Promise<Image[]> {
  const data = await client.request<{ images: Image[] }>(
    "SYNO.Docker.Image",
    "list",
    { offset: 0, limit: -1, show_dsm: false },
  );
  return data.images ?? [];
}

function projectContainers(project: Project, containers: Container[]): Container[] {
  return containers.filter(
    (container) =>
      container.Labels?.["com.docker.compose.project"] === project.name ||
      project.containerIds?.includes(container.id),
  );
}

/** Docker sets a container's hostname to its short id unless told otherwise. */
function isOwnProject(project: Project): boolean {
  const self = hostname();
  return (project.containerIds ?? []).some((id) => id.startsWith(self));
}

/** "n8nio/n8n:latest" -> ["n8nio/n8n", "latest"]; a registry port is not a tag. */
function splitReference(reference: string): [string, string] {
  const slash = reference.lastIndexOf("/");
  const colon = reference.lastIndexOf(":");
  if (colon > slash) return [reference.slice(0, colon), reference.slice(colon + 1)];
  return [reference, "latest"];
}

function taggedImage(images: Image[], reference: string): Image | undefined {
  const [repository, tag] = splitReference(reference);
  return images.find((image) => image.repository === repository && image.tags.includes(tag));
}

/**
 * A container needs an update when Container Manager flags its image, or when
 * its tag already points at a newer image that the container does not run
 * yet (because another project pulled it).
 */
function needsUpdate(container: Container, images: Image[]): boolean {
  const image = images.find((candidate) => candidate.id === container.ImageID);
  if (image?.upgradable) return true;
  const current = taggedImage(images, container.image);
  return current !== undefined && current.id !== container.ImageID;
}

async function findProject(client: DsmClient, name: string): Promise<Project> {
  const projects = await listProjects(client);
  const project = projects.find((candidate) => candidate.name === name);
  if (!project) {
    const known = projects.map((candidate) => candidate.name).join(", ");
    throw new Error(`No Container Manager project named "${name}". Known projects: ${known || "none"}.`);
  }
  return project;
}

/**
 * One image to refresh. "pull" downloads it with pull_start while the
 * projects keep running. "upgrade" hands it to Container Manager's image
 * update, which is the only way to recreate standalone containers: it runs
 * after every affected project is stopped, so it never recreates a
 * container of a running project.
 */
type PendingImage = {
  repository: string;
  tag: string;
  via: "pull" | "upgrade";
  /** Empty until started, or for a newer image that is already downloaded. */
  taskId: string;
  oldImageId: string;
  finished: boolean;
  /** When polling started, to detect a task DSM never reports on. */
  since: number;
  sawStatus: boolean;
};

type PendingUpdate = {
  project: Project;
  images: PendingImage[];
  phase: "download" | "upgrade";
  /** Projects stopped before the upgrade phase, rebuilt at the end. */
  affected?: Project[];
  allowDelete: boolean;
};

const pendingUpdates = new Map<string, PendingUpdate>();
const MAX_PENDING_UPDATES = 20;
// DSM answers a task's status with no data while it sets the task up. A task
// that never reports anything is treated as stuck after this long.
const SILENT_TASK_LIMIT_MS = 5 * 60_000;

/**
 * Polls the pending tasks of one kind. Returns false while any is running and
 * throws when DSM reports an error or a task stays silent for too long.
 */
async function pollTasks(
  client: DsmClient,
  entries: PendingImage[],
  method: "pull_status" | "upgrade_status",
): Promise<boolean> {
  for (const entry of entries) {
    if (entry.finished || !entry.taskId) continue;
    const status = await client.request<{ finished?: boolean } | undefined>(
      "SYNO.Docker.Image",
      method,
      { task_id: entry.taskId },
      { version: 1 },
    );
    if (status) entry.sawStatus = true;
    entry.finished = status?.finished === true;
    if (!entry.sawStatus && Date.now() - entry.since > SILENT_TASK_LIMIT_MS) {
      throw new Error(
        `DSM never reported on the ${method === "pull_status" ? "download" : "update"} of ${entry.repository}:${entry.tag}. Check Container Manager, and Docker Hub's pull rate limit.`,
      );
    }
  }
  return entries.every((entry) => entry.finished);
}

/** Stops and rebuilds one project, as Container Manager does for a build. */
async function rebuildProject(client: DsmClient, project: Project): Promise<string> {
  const stop = await client.request<{ log?: string }>(
    "SYNO.Docker.Project",
    "stop",
    { id: project.id },
    { method: "POST", timeoutMs: PROJECT_TIMEOUT_MS },
  );
  const build = await client.request<{ log?: string }>(
    "SYNO.Docker.Project",
    "build",
    { id: project.id },
    { method: "POST", timeoutMs: PROJECT_TIMEOUT_MS },
  );
  return `${stop.log ?? ""}${build.log ?? ""}`;
}

/** The requested project plus every project running one of the old images. */
async function affectedProjects(client: DsmClient, update: PendingUpdate): Promise<Project[]> {
  const oldIds = new Set(update.images.map((entry) => entry.oldImageId));
  const [projects, containers] = await Promise.all([listProjects(client), listAllContainers(client)]);
  return [
    update.project,
    ...projects.filter(
      (candidate) =>
        candidate.id !== update.project.id &&
        projectContainers(candidate, containers).some((container) => oldIds.has(container.ImageID)),
    ),
  ];
}

/**
 * Upgrade phase: stops every affected project, then lets Container Manager
 * download the images and recreate the containers on them. Project
 * containers are rebuilt with Compose afterwards anyway.
 */
async function startUpgradePhase(client: DsmClient, update: PendingUpdate) {
  update.affected = await affectedProjects(client, update);
  for (const target of update.affected) {
    if (isOwnProject(target)) continue;
    await client.request(
      "SYNO.Docker.Project",
      "stop",
      { id: target.id },
      { method: "POST", timeoutMs: PROJECT_TIMEOUT_MS },
    );
  }
  for (const entry of update.images) {
    if (entry.via !== "upgrade") continue;
    const { task_id } = await client.request<{ task_id: string }>(
      "SYNO.Docker.Image",
      "upgrade_start",
      { repository: entry.repository },
      { method: "POST", version: 1 },
    );
    entry.taskId = task_id;
    entry.since = Date.now();
  }
  update.phase = "upgrade";
}

/**
 * Rebuilds every affected project, each fully stopped before its build, so no
 * project is left on an old image next to an updated one. Then checks that
 * the containers switched and removes the previous images once unused.
 */
async function finishUpdate(client: DsmClient, update: PendingUpdate) {
  const { project } = update;
  const oldIds = new Set(update.images.map((entry) => entry.oldImageId));
  const affected = update.affected ?? (await affectedProjects(client, update));

  const rebuilt = [];
  const skipped = [];
  for (const target of affected) {
    if (isOwnProject(target)) {
      skipped.push(`${target.name} (runs this MCP server; rebuild it from Container Manager)`);
      continue;
    }
    rebuilt.push({ project: target.name, log: await rebuildProject(client, target) });
  }

  const [projects, containers, images] = await Promise.all([
    listProjects(client),
    listAllContainers(client),
    listImages(client),
  ]);
  const inUse = new Set(containers.map((container) => container.ImageID));
  const standaloneLeft = containers
    .filter(
      (container) =>
        oldIds.has(container.ImageID) &&
        !projects.some((candidate) => projectContainers(candidate, [container]).length > 0),
    )
    .map((container) => container.name);

  const updated = [];
  for (const entry of update.images) {
    const reference = `${entry.repository}:${entry.tag}`;
    const current = taggedImage(images, reference);
    const changed = current !== undefined && current.id !== entry.oldImageId;
    const stillOld = containers
      .filter((container) => container.ImageID === entry.oldImageId)
      .map((container) => container.name);

    let oldImage: string;
    if (!changed) {
      oldImage = "no newer image was downloaded";
    } else if (inUse.has(entry.oldImageId)) {
      oldImage = `kept, still used by ${stillOld.join(", ")}`;
    } else if (!images.some((image) => image.id === entry.oldImageId)) {
      oldImage = entry.via === "upgrade" ? "removed by Container Manager" : "already removed";
    } else if (!update.allowDelete) {
      oldImage = "kept, SYNOLOGY_ALLOW_DELETE is false";
    } else {
      oldImage = await deleteImage(client, entry.oldImageId, images);
    }

    updated.push({ image: reference, changed, via: entry.via, oldImage });
  }

  return {
    project: project.name,
    status: "done",
    rebuiltProjects: rebuilt,
    ...(skipped.length > 0 ? { skippedProjects: skipped } : {}),
    ...(standaloneLeft.length > 0
      ? {
          standaloneContainersOnOldImage: standaloneLeft,
          standaloneNote: "These containers are not part of a project and still run the previous image. Recreate them from Container Manager.",
        }
      : {}),
    images: updated,
  };
}

/** Deletes one image by id and confirms it is gone. */
async function deleteImage(client: DsmClient, imageId: string, images: Image[]): Promise<string> {
  const image = images.find((candidate) => candidate.id === imageId);
  if (!image) return "already removed";
  await client.request(
    "SYNO.Docker.Image",
    "delete",
    { images: [{ identity: image.id }] },
    { method: "POST" },
  );
  const remaining = await listImages(client);
  return remaining.some((candidate) => candidate.id === imageId)
    ? "kept, DSM did not remove it"
    : `removed (${humanBytes(image.size)} freed)`;
}

/**
 * Container Manager's image "Update": pulls the repository's latest tag,
 * recreates every container on the previous image with the same settings and
 * deletes that image. It recreates project containers one by one without
 * stopping their project, so control_container only uses it when no project
 * shares the image; control_project stops the projects before using it.
 */
type PendingUpgrade = {
  repository: string;
  taskId: string;
  containers: string[];
  oldImageId: string;
  since: number;
  sawStatus: boolean;
};

const pendingUpgrades = new Map<string, PendingUpgrade>();

async function startUpgrade(
  client: DsmClient,
  repository: string,
  containers: string[],
  oldImageId: string,
): Promise<string> {
  const { task_id } = await client.request<{ task_id: string }>(
    "SYNO.Docker.Image",
    "upgrade_start",
    { repository },
    { method: "POST", version: 1 },
  );
  if (pendingUpgrades.size >= MAX_PENDING_UPDATES) {
    const oldest = pendingUpgrades.keys().next().value;
    if (oldest !== undefined) pendingUpgrades.delete(oldest);
  }
  pendingUpgrades.set(task_id, {
    repository,
    taskId: task_id,
    containers,
    oldImageId,
    since: Date.now(),
    sawStatus: false,
  });
  return task_id;
}

async function waitForUpgrade(
  client: DsmClient,
  updateId: string,
  upgrade: PendingUpgrade,
  waitSeconds: number,
) {
  const deadline = Date.now() + waitSeconds * 1000;
  let state = "";
  for (;;) {
    if (!upgrade.sawStatus && Date.now() - upgrade.since > SILENT_TASK_LIMIT_MS) {
      pendingUpgrades.delete(updateId);
      throw new Error(
        `Container Manager never reported on the update of ${upgrade.repository}. Check Container Manager, and Docker Hub's pull rate limit.`,
      );
    }
    const status = await client.request<{ finished?: boolean; state?: string } | undefined>(
      "SYNO.Docker.Image",
      "upgrade_status",
      { task_id: upgrade.taskId },
      { version: 1 },
    );
    if (status) upgrade.sawStatus = true;
    state = status?.state ?? state;
    if (status?.finished) {
      pendingUpgrades.delete(updateId);
      const [containers, images] = await Promise.all([
        listAllContainers(client),
        listImages(client),
      ]);
      return {
        repository: upgrade.repository,
        status: "done",
        containers: upgrade.containers.map((name) => {
          const container = containers.find((candidate) => candidate.name === name);
          return {
            name,
            status: container?.status ?? "missing",
            updated: container !== undefined && container.ImageID !== upgrade.oldImageId,
          };
        }),
        oldImage: images.some((image) => image.id === upgrade.oldImageId)
          ? "still present (Container Manager may still be deleting it)"
          : "removed by Container Manager",
      };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return {
    repository: upgrade.repository,
    status: "updating",
    updateId,
    state,
    note: "Container Manager is downloading the image or recreating the containers. Call get_project_update_result with this updateId in about a minute, and again until status is done.",
  };
}

/** control_container update: standalone containers on a latest tag only. */
export async function updateStandaloneContainer(ctx: ToolContext, name: string, waitSeconds: number) {
  ctx.policy.assertSystemControl("control_container(update)");
  const [projects, containers, images] = await Promise.all([
    listProjects(ctx.client),
    listAllContainers(ctx.client),
    listImages(ctx.client),
  ]);
  const container = containers.find((candidate) => candidate.name === name);
  if (!container) throw new Error(`No container named "${name}".`);
  if (container.id.startsWith(hostname())) {
    throw new Error("Refused: this container runs this MCP server. Update it from Container Manager.");
  }
  const owner = projects.find((project) => projectContainers(project, [container]).length > 0);
  if (owner) {
    throw new Error(
      `Refused: "${name}" belongs to project "${owner.name}". Use control_project with action update, which stops the whole project first.`,
    );
  }
  const [repository, tag] = splitReference(container.image);
  if (tag !== "latest") {
    throw new Error(
      `Refused: "${name}" uses ${container.image}; Container Manager only updates the latest tag.`,
    );
  }
  const inProjects = projects.filter((project) =>
    projectContainers(project, containers).some(
      (member) => member.image === container.image || member.ImageID === container.ImageID,
    ),
  );
  if (inProjects.length > 0) {
    throw new Error(
      `Refused: ${container.image} is also used by project ${inProjects.map((project) => `"${project.name}"`).join(", ")}, and Container Manager would recreate those containers without stopping their project. Run control_project update on it instead; it also reports this container.`,
    );
  }
  if (!needsUpdate(container, images)) {
    return {
      container: name,
      status: "up_to_date",
      note: "Container Manager reports no newer image for this container.",
    };
  }
  const image = images.find((candidate) => candidate.id === container.ImageID);
  if (!image?.upgradable) {
    throw new Error(
      `${container.image} already points at a newer image that "${name}" does not run yet. Container Manager's update only acts while the tag itself is outdated, so recreate "${name}" from Container Manager.`,
    );
  }
  const users = containers
    .filter((candidate) => candidate.ImageID === container.ImageID)
    .map((candidate) => candidate.name);
  const updateId = await startUpgrade(ctx.client, repository, users, container.ImageID);
  return waitForUpgrade(ctx.client, updateId, pendingUpgrades.get(updateId)!, waitSeconds);
}

async function waitForUpdate(
  client: DsmClient,
  updateId: string,
  update: PendingUpdate,
  waitSeconds: number,
) {
  const deadline = Date.now() + waitSeconds * 1000;
  try {
    for (;;) {
      if (update.phase === "download") {
        const pulls = update.images.filter((entry) => entry.via === "pull");
        if (await pollTasks(client, pulls, "pull_status")) {
          if (!update.images.some((entry) => entry.via === "upgrade")) {
            pendingUpdates.delete(updateId);
            return await finishUpdate(client, update);
          }
          await startUpgradePhase(client, update);
        }
      } else {
        const upgrades = update.images.filter((entry) => entry.via === "upgrade");
        if (await pollTasks(client, upgrades, "upgrade_status")) {
          pendingUpdates.delete(updateId);
          return await finishUpdate(client, update);
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } catch (error) {
    pendingUpdates.delete(updateId);
    throw error;
  }
  return {
    project: update.project.name,
    status: update.phase === "download" ? "downloading" : "updating",
    updateId,
    images: update.images.map((entry) => `${entry.repository}:${entry.tag}`),
    note:
      update.phase === "download"
        ? "The project keeps running while the new images download. Call get_project_update_result with this updateId in about a minute, and again until status is done."
        : "The affected projects are stopped while Container Manager downloads the images and recreates the standalone containers. Call get_project_update_result with this updateId in about a minute, and again until status is done.",
  };
}

export const projectTools = [
  defineTool({
    name: "list_projects",
    title: "List Container Manager projects",
    description:
      "Lists the Container Manager projects (Docker Compose) on the NAS with their status, containers and images, and flags images for which Container Manager reports a newer version.",
    readOnly: true,
    idempotent: true,
    schema: z.object({}),
    handler: async (ctx) => {
      const [projects, containers, images] = await Promise.all([
        listProjects(ctx.client),
        listAllContainers(ctx.client),
        listImages(ctx.client),
      ]);
      return {
        total: projects.length,
        projects: projects.map((project) => ({
          name: project.name,
          status: project.status,
          path: project.path,
          managesThisServer: isOwnProject(project),
          containers: projectContainers(project, containers).map((container) => ({
            name: container.name,
            status: container.status,
            image: container.image,
            updateAvailable: needsUpdate(container, images),
          })),
        })),
      };
    },
  }),

  defineTool({
    name: "control_project",
    title: "Start, stop, build, clean or update a project",
    description:
      "Starts or stops a Container Manager project, builds it (stops it and recreates its containers from compose.yaml, like Container Manager's Build), cleans it (stops it and removes its containers, keeping the project files), or updates it. update downloads newer versions of the project's images while it keeps running, then stops and rebuilds the whole project, and every other project that runs the same old images, so all containers use the new images, and removes the previous images once unused (needs SYNOLOGY_ALLOW_DELETE=true for that last step). If standalone containers share an outdated latest image, the affected projects are stopped first and Container Manager's image update downloads it and recreates those containers. Downloads can take minutes: if update returns status \"downloading\", poll get_project_update_result with the updateId. The project that runs this server cannot be controlled. Requires SYNOLOGY_ALLOW_SYSTEM_CONTROL=true.",
    destructive: true,
    schema: z.object({
      name: z.string().describe("Project name as shown by list_projects"),
      action: z.enum(["start", "stop", "build", "clean", "update"]),
      // Kept well below the 60 s at which MCP clients commonly abort a call.
      waitSeconds: z.number().int().min(1).max(30).default(20),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertSystemControl(`control_project(${args.action})`);
      const project = await findProject(ctx.client, args.name);
      if (isOwnProject(project)) {
        throw new Error(
          `Refused: "${project.name}" runs this MCP server, so ${args.action} would cut the connection mid-call. Manage it from Container Manager.`,
        );
      }

      if (args.action === "build") {
        return { project: project.name, action: "build", ok: true, log: await rebuildProject(ctx.client, project) };
      }

      if (args.action !== "update") {
        // Container Manager only offers Clean on a stopped project.
        const stop =
          args.action === "clean"
            ? await ctx.client.request<{ log?: string }>(
                "SYNO.Docker.Project",
                "stop",
                { id: project.id },
                { method: "POST", timeoutMs: PROJECT_TIMEOUT_MS },
              )
            : undefined;
        const result = await ctx.client.request<{ log?: string }>(
          "SYNO.Docker.Project",
          args.action,
          { id: project.id },
          { method: "POST", timeoutMs: PROJECT_TIMEOUT_MS },
        );
        return {
          project: project.name,
          action: args.action,
          ok: true,
          log: `${stop?.log ?? ""}${result.log ?? ""}`,
        };
      }

      // An update already in progress for this project is resumed, not doubled.
      for (const [pendingId, pending] of pendingUpdates) {
        if (pending.project.id === project.id) {
          return waitForUpdate(ctx.client, pendingId, pending, args.waitSeconds);
        }
      }

      const [containers, images] = await Promise.all([
        listAllContainers(ctx.client),
        listImages(ctx.client),
      ]);
      const projects = await listProjects(ctx.client);
      const entries: PendingImage[] = [];
      for (const container of projectContainers(project, containers)) {
        if (!needsUpdate(container, images)) continue;
        const [repository, tag] = splitReference(container.image);
        if (entries.some((entry) => entry.repository === repository && entry.tag === tag)) continue;
        const base = { repository, tag, oldImageId: container.ImageID, since: Date.now(), sawStatus: false };
        const current = taggedImage(images, container.image);
        if (current && current.id !== container.ImageID) {
          // Newer image already on the NAS: rebuild without downloading again.
          entries.push({ ...base, via: "pull", taskId: "", finished: true });
          continue;
        }
        // Standalone containers on the same image can only be recreated by
        // Container Manager's update, which must pull the image itself.
        const standalone = containers.some(
          (other) =>
            other.ImageID === container.ImageID &&
            !projects.some((candidate) => projectContainers(candidate, [other]).length > 0),
        );
        if (standalone && tag === "latest") {
          entries.push({ ...base, via: "upgrade", taskId: "", finished: false });
          continue;
        }
        const { task_id } = await ctx.client.request<{ task_id: string }>(
          "SYNO.Docker.Image",
          "pull_start",
          { repository, tag },
          { method: "POST" },
        );
        entries.push({ ...base, via: "pull", taskId: task_id, finished: false });
      }

      if (entries.length === 0) {
        return {
          project: project.name,
          status: "up_to_date",
          note: "Container Manager reports no newer image for this project's containers.",
        };
      }

      const updateId =
        entries.find((entry) => entry.taskId)?.taskId ?? `local-${project.id}-${Date.now()}`;
      if (pendingUpdates.size >= MAX_PENDING_UPDATES) {
        const oldest = pendingUpdates.keys().next().value;
        if (oldest !== undefined) pendingUpdates.delete(oldest);
      }
      const update: PendingUpdate = {
        project,
        images: entries,
        phase: "download",
        allowDelete: ctx.policy.allowDelete,
      };
      pendingUpdates.set(updateId, update);
      return waitForUpdate(ctx.client, updateId, update, args.waitSeconds);
    },
  }),

  defineTool({
    name: "get_project_update_result",
    title: "Check a project update",
    description:
      "Continues an update started by control_project (status \"downloading\" or \"updating\") or control_container (status \"updating\"). Once the images are downloaded it recreates the containers and removes the previous images, then returns status done.",
    destructive: true,
    schema: z.object({
      updateId: z.string().describe("The updateId returned by control_project or control_container"),
      waitSeconds: z.number().int().min(1).max(30).default(20),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertSystemControl("get_project_update_result");
      const upgrade = pendingUpgrades.get(args.updateId);
      if (upgrade) return waitForUpgrade(ctx.client, args.updateId, upgrade, args.waitSeconds);
      const update = pendingUpdates.get(args.updateId);
      if (!update) {
        throw new Error(
          `Unknown updateId "${args.updateId}". It may have finished already, or the server restarted; check list_projects and run control_project update again if needed.`,
        );
      }
      return waitForUpdate(ctx.client, args.updateId, update, args.waitSeconds);
    },
  }),

  defineTool({
    name: "delete_container_image",
    title: "Delete an unused Docker image",
    description:
      "Deletes a Docker image that no container uses, such as the untagged (<none>) image left behind by an update. Identify it by the id shown in list_container_images. Requires SYNOLOGY_ALLOW_DELETE=true.",
    destructive: true,
    schema: z.object({
      id: z.string().describe("Image id, e.g. sha256:c7615c3171b6… (a unique prefix is enough)"),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertDeletable(`delete_container_image(${args.id})`);
      const [containers, images] = await Promise.all([
        listAllContainers(ctx.client),
        listImages(ctx.client),
      ]);
      const wanted = args.id.startsWith("sha256:") ? args.id : `sha256:${args.id}`;
      const matches = images.filter((image) => image.id.startsWith(wanted));
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? `No image with id ${args.id}.`
            : `Image id ${args.id} is ambiguous; give more characters.`,
        );
      }
      const [image] = matches;
      const users = containers.filter((container) => container.ImageID === image.id);
      if (users.length > 0) {
        throw new Error(
          `Refused: image ${image.id} is used by ${users.map((container) => container.name).join(", ")}.`,
        );
      }
      return {
        image: image.id,
        repository: image.repository,
        tags: image.tags,
        result: await deleteImage(ctx.client, image.id, images),
      };
    },
  }),
];
