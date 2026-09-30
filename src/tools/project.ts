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

type PendingPull = {
  repository: string;
  tag: string;
  /** Empty when the newer image was already downloaded, e.g. by another update. */
  taskId: string;
  oldImageId: string;
  finished: boolean;
};

type PendingUpdate = {
  project: Project;
  pulls: PendingPull[];
  allowDelete: boolean;
};

const pendingUpdates = new Map<string, PendingUpdate>();
const MAX_PENDING_UPDATES = 20;

/**
 * Returns false while any pull is still downloading. Throws if one failed.
 * Right after pull_start DSM can answer with no data at all while the task
 * is still being set up; that counts as not finished yet.
 */
async function pollPulls(client: DsmClient, pulls: PendingPull[]): Promise<boolean> {
  for (const pull of pulls) {
    if (pull.finished || !pull.taskId) continue;
    const status = await client.request<{ finished?: boolean } | undefined>(
      "SYNO.Docker.Image",
      "pull_status",
      { task_id: pull.taskId },
    );
    pull.finished = status?.finished === true;
  }
  return pulls.every((pull) => pull.finished);
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

/**
 * Rebuilds every project that runs one of the replaced images, not only the
 * requested one, so no project is left on an old image next to an updated
 * one. Each project is fully stopped before its build. Then checks that the
 * containers switched and removes the previous images once nothing uses them.
 */
async function finishUpdate(client: DsmClient, update: PendingUpdate) {
  const { project, pulls } = update;
  const oldIds = new Set(pulls.map((pull) => pull.oldImageId));
  const [projects, before] = await Promise.all([
    listProjects(client),
    listAllContainers(client),
  ]);
  const affected = [
    project,
    ...projects.filter(
      (candidate) =>
        candidate.id !== project.id &&
        projectContainers(candidate, before).some((container) => oldIds.has(container.ImageID)),
    ),
  ];

  const rebuilt = [];
  const skipped = [];
  for (const target of affected) {
    if (isOwnProject(target)) {
      skipped.push(`${target.name} (runs this MCP server; rebuild it from Container Manager)`);
      continue;
    }
    rebuilt.push({ project: target.name, log: await rebuildProject(client, target) });
  }

  const containers = await listAllContainers(client);
  const images = await listImages(client);
  const inUse = new Set(containers.map((container) => container.ImageID));
  const standalone = containers.filter(
    (container) =>
      oldIds.has(container.ImageID) &&
      !projects.some((candidate) => projectContainers(candidate, [container]).length > 0),
  );

  // Once every project is rebuilt, Container Manager's own update can
  // recreate the standalone containers left on a replaced latest image.
  const standaloneUpdates = [];
  const standaloneLeft = [];
  for (const pull of pulls) {
    const onOld = containers.filter((container) => container.ImageID === pull.oldImageId);
    const solo = onOld.filter((container) => standalone.includes(container));
    if (solo.length === 0) continue;
    const onlyStandalone = solo.length === onOld.length && !solo.some((c) => c.id.startsWith(hostname()));
    if (pull.tag === "latest" && onlyStandalone) {
      const updateId = await startUpgrade(
        client,
        pull.repository,
        solo.map((container) => container.name),
        pull.oldImageId,
      );
      standaloneUpdates.push({ updateId, containers: solo.map((container) => container.name) });
    } else {
      standaloneLeft.push(...solo.map((container) => container.name));
    }
  }

  const updated = [];
  for (const pull of pulls) {
    const reference = `${pull.repository}:${pull.tag}`;
    const current = taggedImage(images, reference);
    const changed = current !== undefined && current.id !== pull.oldImageId;
    const stillOld = containers
      .filter((container) => container.ImageID === pull.oldImageId)
      .map((container) => container.name);

    let oldImage: string;
    if (!changed) {
      oldImage = "no newer image was downloaded";
    } else if (standaloneUpdates.some((u) => pendingUpgrades.get(u.updateId)?.oldImageId === pull.oldImageId)) {
      oldImage = "Container Manager deletes it after updating the standalone containers";
    } else if (inUse.has(pull.oldImageId)) {
      oldImage = `kept, still used by ${stillOld.join(", ")}`;
    } else if (!update.allowDelete) {
      oldImage = "kept, SYNOLOGY_ALLOW_DELETE is false";
    } else {
      oldImage = await deleteImage(client, pull.oldImageId, images);
    }

    updated.push({ image: reference, changed, oldImage });
  }

  return {
    project: project.name,
    status: "done",
    rebuiltProjects: rebuilt,
    ...(skipped.length > 0 ? { skippedProjects: skipped } : {}),
    ...(standaloneUpdates.length > 0
      ? {
          standaloneUpdates,
          note: "Container Manager is now updating the standalone containers that ran the previous image, and will delete that image. Poll get_project_update_result with each updateId until status is done.",
        }
      : {}),
    ...(standaloneLeft.length > 0
      ? {
          standaloneContainersOnOldImage: standaloneLeft,
          standaloneNote: "These containers are not part of a project and could not be updated automatically (not a latest tag), so they still run the previous image.",
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
 * stopping their project, so it is only used for standalone containers.
 */
type PendingUpgrade = {
  repository: string;
  taskId: string;
  containers: string[];
  oldImageId: string;
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
  pendingUpgrades.set(task_id, { repository, taskId: task_id, containers, oldImageId });
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
    const status = await client.request<{ finished?: boolean; state?: string } | undefined>(
      "SYNO.Docker.Image",
      "upgrade_status",
      { task_id: upgrade.taskId },
      { version: 1 },
    );
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
  for (;;) {
    if (await pollPulls(client, update.pulls)) {
      pendingUpdates.delete(updateId);
      return finishUpdate(client, update);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return {
    project: update.project.name,
    status: "downloading",
    updateId,
    images: update.pulls.map((pull) => `${pull.repository}:${pull.tag}`),
    note: "The project keeps running while the new images download. Call get_project_update_result with this updateId in about a minute, and again until status is done.",
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
      "Starts or stops a Container Manager project, builds it (stops it and recreates its containers from compose.yaml, like Container Manager's Build), cleans it (stops it and removes its containers, keeping the project files), or updates it. update downloads newer versions of the project's images while it keeps running, then stops and rebuilds the whole project, and every other project that runs the same old images, so all containers use the new images, and removes the previous images once unused (needs SYNOLOGY_ALLOW_DELETE=true for that last step). Downloads can take minutes: if update returns status \"downloading\", poll get_project_update_result with the updateId. The project that runs this server cannot be controlled. Requires SYNOLOGY_ALLOW_SYSTEM_CONTROL=true.",
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

      const [containers, images] = await Promise.all([
        listAllContainers(ctx.client),
        listImages(ctx.client),
      ]);
      const pulls: PendingPull[] = [];
      for (const container of projectContainers(project, containers)) {
        if (!needsUpdate(container, images)) continue;
        const [repository, tag] = splitReference(container.image);
        if (pulls.some((pull) => pull.repository === repository && pull.tag === tag)) continue;
        const current = taggedImage(images, container.image);
        if (current && current.id !== container.ImageID) {
          // Newer image already on the NAS: rebuild without downloading again.
          pulls.push({ repository, tag, taskId: "", oldImageId: container.ImageID, finished: true });
          continue;
        }
        const { task_id } = await ctx.client.request<{ task_id: string }>(
          "SYNO.Docker.Image",
          "pull_start",
          { repository, tag },
          { method: "POST" },
        );
        pulls.push({ repository, tag, taskId: task_id, oldImageId: container.ImageID, finished: false });
      }

      if (pulls.length === 0) {
        return {
          project: project.name,
          status: "up_to_date",
          note: "Container Manager reports no newer image for this project's containers.",
        };
      }

      const updateId = pulls.find((pull) => pull.taskId)?.taskId ?? `local-${project.id}-${Date.now()}`;
      if (pendingUpdates.size >= MAX_PENDING_UPDATES) {
        const oldest = pendingUpdates.keys().next().value;
        if (oldest !== undefined) pendingUpdates.delete(oldest);
      }
      const update = { project, pulls, allowDelete: ctx.policy.allowDelete };
      pendingUpdates.set(updateId, update);
      return waitForUpdate(ctx.client, updateId, update, args.waitSeconds);
    },
  }),

  defineTool({
    name: "get_project_update_result",
    title: "Check a project update",
    description:
      "Continues an update started by control_project (status \"downloading\") or control_container (status \"updating\"), or a standaloneUpdates entry. Once the images are downloaded it recreates the containers and removes the previous images, then returns status done.",
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
