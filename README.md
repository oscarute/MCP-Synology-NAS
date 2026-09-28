# mcp-server-synology

An MCP server that exposes a Synology NAS through the official DSM WebAPI.

It covers File Station, Download Station, Synology Photos, Container Manager
and DSM system management with purpose-built tools, and reaches everything else
through a guarded generic bridge to the raw DSM WebAPI.

## Why the generic bridge exists

DSM exposes several hundred APIs and Synology publicly documents only a
fraction of them. Shipping one tool per API is neither possible nor useful, so
this server takes a two-layer approach:

- **Curated tools** for the things you actually do every day. They validate
  input, resolve DSM's asynchronous background tasks, translate numeric error
  codes into sentences, and enforce the path allowlist.
- **`list_dsm_apis` + `call_dsm_api`** for everything else: Surveillance
  Station, Hyper Backup, certificates, users and groups, the firewall,
  Synology Drive, task scheduler, and any API a future DSM version adds.

The bridge is not a privilege escalation. Every call still runs as the DSM
account you configured and is bounded by that account's permissions. It is
gated behind a separate switch only because it bypasses the path allowlist and
the read-only heuristics the curated tools apply.

## Tools

### File Station — browse and read

| Tool | Purpose |
| --- | --- |
| `list_shared_folders` | Discover the shared folders the account can reach |
| `list_files` | List a folder with paging, sorting and extension filters |
| `get_file_info` | Size, timestamps, owner and permissions for specific items |
| `search_files` | Indexed DSM search by name, extension, size or modified time |
| `read_file` | Read a text file inline, size-capped and binary-safe |
| `get_folder_size` | Recursive size and item count of folders |
| `get_file_checksum` | MD5 of a file without downloading it |

### File Station — write, archive and share

| Tool | Purpose |
| --- | --- |
| `create_folder` | Create folders, optionally with parents |
| `write_file` | Upload text or base64 content to a file |
| `rename_file` | Rename in place |
| `move_files` / `copy_files` | Relocate or duplicate, waiting for completion |
| `delete_files` | Permanent delete, separately gated |
| `compress_files` | Create a ZIP or 7z archive, optionally encrypted |
| `extract_archive` | Extract ZIP, 7z, RAR, TAR or GZ |
| `list_archive_contents` | Inspect an archive without extracting it |
| `create_sharing_link` | Public link with optional expiry and password |
| `list_sharing_links` / `delete_sharing_link` | Audit and revoke public links |

### Download Station

| Tool | Purpose |
| --- | --- |
| `list_download_tasks` | All tasks with progress and speed |
| `get_download_task` | Full detail for specific tasks |
| `create_download_task` | Queue HTTP, FTP or magnet downloads |
| `control_download_task` | Pause, resume or remove tasks |
| `get_download_station_info` | Version, throughput and schedule |

### Synology Photos

| Tool | Purpose |
| --- | --- |
| `list_photo_albums` | Albums in the personal or shared space |
| `list_photos` | Photos and videos with EXIF, location and tags |
| `list_photo_folders` | Navigate the Photos folder tree |
| `search_photos` | Search by subject, place, person or filename |

### Container Manager

| Tool | Purpose |
| --- | --- |
| `list_containers` | Containers with state, CPU and memory |
| `get_container_details` | Ports, mounts, environment, network |
| `control_container` | Start, stop or restart |
| `list_container_images` | Stored images and their size |

### System

| Tool | Purpose |
| --- | --- |
| `get_system_info` | Model, DSM version, serial, uptime, temperature |
| `get_resource_usage` | Live CPU, memory, disk I/O and network |
| `get_storage_info` | Volumes, disks, free space and SMART health |
| `list_installed_packages` | Which DSM packages exist and are running |
| `list_shares_admin` | Shared folder configuration and encryption |
| `list_active_connections` | Who is connected and over which protocol |
| `control_system_power` | Reboot or shut down the NAS |

### Generic bridge

| Tool | Purpose |
| --- | --- |
| `list_dsm_apis` | Discover every API this DSM exposes |
| `call_dsm_api` | Invoke any DSM WebAPI method |

## Security model

The server assumes it is being driven by an AI client, so the defaults are the
safe ones and every dangerous capability is opt-in.

**Layer 1 — the DSM account.** Create a dedicated non-administrator user in
DSM and grant it only the shared folders it needs. Nothing this server does can
exceed what that account is allowed to do. Never point it at an admin account.

**Layer 2 — the policy switches.** Independent of DSM permissions:

| Setting | Default | Effect |
| --- | --- | --- |
| `SYNOLOGY_READONLY` | `true` | Every mutating tool is hidden and refused |
| `SYNOLOGY_ALLOW_DELETE` | `false` | Deletion refused even when writes are on |
| `SYNOLOGY_ALLOW_SYSTEM_CONTROL` | `false` | No reboot, shutdown or container control |
| `SYNOLOGY_ALLOW_GENERIC_API` | `false` | `call_dsm_api` is hidden |
| `SYNOLOGY_ALLOWED_PATHS` | empty | Restrict File Station to specific folders |
| `SYNOLOGY_DENIED_PATHS` | empty | Always-blocked folders |
| `SYNOLOGY_MAX_READ_BYTES` | `1048576` | Cap on inline file reads |

Paths are validated before every File Station call. Traversal segments are
rejected outright rather than resolved, because a resolved path can still
escape an allowlist through a symlink on the NAS.

Tools that can never succeed under the current policy are hidden from the tool
list rather than advertised and then refused, so the model does not keep
retrying them.

**Layer 3 — the transport.** Set `SYNOLOGY_MCP_TOKEN` and every HTTP client
must send `Authorization: Bearer <token>`.

### Suggested rollout

1. **Read-only.** Defaults as shipped. Confirm the tools see what you expect.
2. **Scoped writes.** Set `SYNOLOGY_READONLY=false` and
   `SYNOLOGY_ALLOWED_PATHS` to one or two working folders.
3. **Operations.** Enable delete, system control or the generic bridge only
   once you trust the setup.

## Configuration

Everything is configured in a single file, `compose.yaml`: no `.env` or other
files are needed. Edit the values in its `environment` block;
`SYNOLOGY_URL`, `SYNOLOGY_USER` and `SYNOLOGY_PASSWORD` are required and
everything else has a safe default. Each setting is documented inline.

- If DSM uses a self-signed certificate, set `SYNOLOGY_INSECURE_TLS: "true"`.
  This is scoped to this client's connection pool rather than disabling TLS
  verification for the whole process.
- A literal `$` in any value must be written as `$$`, or Compose treats it as
  a variable reference.
- Once filled in, `compose.yaml` holds credentials: keep it private
  (`chmod 600 compose.yaml`) and never publish your filled-in copy.

## Running

### Docker Compose

```bash
$EDITOR compose.yaml
docker compose up -d --build
docker compose logs -f
```

`build.context` points at the folder holding the `Dockerfile`. If you keep
`compose.yaml` outside the source folder (for example next to an extracted
`mcp-server-synology-main/`), set `context: ./mcp-server-synology-main`.
On Synology, the same file works as a Container Manager project.

The container binds to `127.0.0.1:3020` so only a local reverse proxy can
reach it. Change the `ports` entry to expose it elsewhere.

### Local stdio

```bash
npm install
npm run build
SYNOLOGY_MCP_TRANSPORT=stdio node dist/index.js
```

## Reaching a NAS that sits behind your home router

A hosted MCP server cannot dial into a home LAN directly. Rather than
port-forwarding DSM to the public internet, put both machines on a private
overlay network and point `SYNOLOGY_URL` at the overlay address:

- **Tailscale** — install on the NAS and the host running this server, then use
  the NAS's tailnet address. Simplest option, no router changes.
- **WireGuard** — a manual tunnel if you already run one.
- **frp / Cloudflare Tunnel** — a reverse tunnel initiated from the NAS.

Only the MCP server needs to reach DSM. DSM itself stays unexposed.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP endpoint |
| `GET /healthz` | Liveness, active sessions, exposed tool count, active policy |

`/healthz` reports the policy in force, so the running security posture is
auditable without reading the container environment.

## Behaviour worth knowing

- **Session renewal.** DSM invalidates sessions on idle timeout, duplicate
  login and reboot. The client detects codes 106, 107 and 119, re-authenticates
  once and replays the call, so this never surfaces as a tool failure.
- **API discovery.** Endpoint paths and version ranges are read from
  `SYNO.API.Info` at runtime and cached, so the same build works across DSM 6
  and DSM 7 and against APIs that moved between CGI handlers.
- **Background tasks.** Copy, move, delete, compress, extract, folder size and
  checksum all run asynchronously on the NAS. Each tool polls to completion
  instead of returning a task id, and reports partial progress if the timeout
  elapses.
- **Error messages.** DSM returns numeric codes inside a 200 OK body, and the
  same number means different things per API family. Codes are translated
  against the correct table and phrased as something you can act on.

## Reference

Built against Synology's published *File Station API*, *Download Station API*
and *DSM Login Web API* guides, plus runtime discovery via `SYNO.API.Info`.

## License

MIT
