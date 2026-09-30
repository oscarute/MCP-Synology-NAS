import { hostname } from "node:os";
import { z } from "zod";
import type { DsmClient } from "../client.js";
import { defineTool, humanBytes } from "../tool.js";

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

/** Returns false while any pull is still downloading. Throws if one failed. */
async function pollPulls(client: DsmClient, pulls: PendingPull[]): Promise<boolean> {
  for (const pull of pulls) {
    if (pull.finished) continue;
    const status = await client.request<{ finished: boolean }>(
      "SYNO.Docker.Image",
      "pull_status",
      { task_id: pull.taskId },
    );
    pull.finished = status.finished === true;
  }
  return pulls.every((pull) => pull.finished);
}

/**
 * Recreates the project's containers on the freshly pulled images, checks
 * that they switched, and removes the previous images once nothing uses them.
 */
async function finishUpdate(client: DsmClient, update: PendingUpdate) {
  const { project, pulls } = update;
  const build = await client.request<{ log?: string }>(
    "SYNO.Docker.Project",
    "build",
    { id: project.id },
    { method: "POST", timeoutMs: PROJECT_TIMEOUT_MS },
  );

  const containers = await listAllContainers(client);
  const images = await listImages(client);
  const inUse = new Set(containers.map((container) => container.ImageID));
  const members = projectContainers(project, containers);

  const updated = [];
  for (const pull of pulls) {
    const current = images.find(
      (image) => image.repository === pull.repository && image.tags.includes(pull.tag),
    );
    const recreated = members.some(
      (container) =>
        container.image === `${pull.repository}:${pull.tag}` &&
        container.ImageID === current?.id,
    );
    const changed = current !== undefined && current.id !== pull.oldImageId;

    let oldImage: string;
    if (!changed) {
      oldImage = "no newer image was downloaded";
    } else if (inUse.has(pull.oldImageId)) {
      oldImage = "kept, a container still uses it";
    } else if (!update.allowDelete) {
      oldImage = "kept, SYNOLOGY_ALLOW_DELETE is false";
    } else {
      oldImage = await deleteImage(client, pull.oldImageId, images);
    }

    updated.push({
      image: `${pull.repository}:${pull.tag}`,
      changed,
      recreated,
      oldImage,
    });
  }

  return {
    project: project.name,
    status: "done",
    images: updated,
    log: build.log,
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
          containers: projectContainers(project, containers).map((container) => {
            const image = images.find((candidate) => candidate.id === container.ImageID);
            return {
              name: container.name,
              status: container.status,
              image: container.image,
              updateAvailable: image?.upgradable ?? false,
            };
          }),
        })),
      };
    },
  }),

  defineTool({
    name: "control_project",
    title: "Start, stop or update a project",
    description:
      "Starts or stops a Container Manager project, or updates it. update downloads newer versions of the project's images while it keeps running, recreates the containers that use them, and removes the previous images once unused (needs SYNOLOGY_ALLOW_DELETE=true for that last step). Downloads can take minutes: if update returns status \"downloading\", poll get_project_update_result with the updateId. The project that runs this server cannot be controlled. Requires SYNOLOGY_ALLOW_SYSTEM_CONTROL=true.",
    destructive: true,
    schema: z.object({
      name: z.string().describe("Project name as shown by list_projects"),
      action: z.enum(["start", "stop", "update"]),
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

      if (args.action !== "update") {
        const result = await ctx.client.request<{ log?: string }>(
          "SYNO.Docker.Project",
          args.action,
          { id: project.id },
          { method: "POST", timeoutMs: PROJECT_TIMEOUT_MS },
        );
        return { project: project.name, action: args.action, ok: true, log: result.log };
      }

      const [containers, images] = await Promise.all([
        listAllContainers(ctx.client),
        listImages(ctx.client),
      ]);
      const pulls: PendingPull[] = [];
      for (const container of projectContainers(project, containers)) {
        const image = images.find((candidate) => candidate.id === container.ImageID);
        if (!image?.upgradable) continue;
        const [repository, tag] = splitReference(container.image);
        if (pulls.some((pull) => pull.repository === repository && pull.tag === tag)) continue;
        const { task_id } = await ctx.client.request<{ task_id: string }>(
          "SYNO.Docker.Image",
          "pull_start",
          { repository, tag },
          { method: "POST" },
        );
        pulls.push({ repository, tag, taskId: task_id, oldImageId: image.id, finished: false });
      }

      if (pulls.length === 0) {
        return {
          project: project.name,
          status: "up_to_date",
          note: "Container Manager reports no newer image for this project's containers.",
        };
      }

      const updateId = pulls[0].taskId;
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
      "Continues an update started by control_project that returned status \"downloading\". Once the images are downloaded it recreates the containers and removes the previous images, then returns status done.",
    destructive: true,
    schema: z.object({
      updateId: z.string().describe("The updateId returned by control_project"),
      waitSeconds: z.number().int().min(1).max(30).default(20),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertSystemControl("get_project_update_result");
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
