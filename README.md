# MCP-Synology-NAS

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
| `control_container` | Start, stop, restart, or update a standalone container |
| `list_container_images` | Stored images, their id and size |
| `delete_container_image` | Delete an image no container uses |
| `list_projects` | Projects with their containers and available image updates |
| `control_project` | Start, stop, build, clean or update a project |
| `get_project_update_result` | Continue an update while new images download |

`control_project` `update` downloads newer images while the project keeps
running, then stops the whole project and rebuilds it, and then deletes
the previous images once unused (needs `SYNOLOGY_ALLOW_DELETE`). When standalone
containers share an outdated `latest` image, the affected projects are stopped
first and Container Manager's own image update downloads it and recreates
those containers; the projects are then rebuilt as usual. It refuses the project that runs this server,
since that would cut the connection.

`control_container` `update` uses Container Manager's image update for a
standalone container on a `latest` tag. It refuses containers in a project,
and images that a project also uses, because Container Manager would recreate
those containers without stopping their project.

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

`get_container_details` redacts values whose names suggest a credential, but
`call_dsm_api` returns DSM's raw responses, container environments included.
Keep `SYNOLOGY_ALLOW_GENERIC_API` off unless you need it.

## Security model

The server assumes it is being driven by an AI client, so the defaults are the
safe ones and every dangerous capability is opt-in.

**Layer 1 — the DSM account.** Create a dedicated non-administrator user in
DSM and grant it only the shared folders it needs. Nothing this server does can
exceed what that account is allowed to do. Never point it at an admin account.
Sign in to DSM once with the new account and open File Station: DSM only
creates a user's File Station profile on its first interactive login, and
until then searches can fail for that account.

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

## Installation

The steps below use only the DSM web interface (File Station and
Container Manager), no command line.

1. On this repository's GitHub page, click **Code → Download ZIP**.
2. In File Station, create a folder named `mcp-synology` inside the `docker`
   shared folder, upload the ZIP into it and extract it there
   (right-click → **Extract → Extract here**).
3. Copy `MCP-Synology-NAS-main/compose.yaml` one level up, into
   `mcp-synology/`. The result should look like this:

   ```
   docker/
   └── mcp-synology/
       ├── compose.yaml                  ← your copy, edited in step 4
       └── MCP-Synology-NAS-main/
           ├── Dockerfile
           ├── compose.yaml
           └── src/
   ```

   Keeping your copy outside the source folder means an update never
   overwrites your settings.
4. Edit `mcp-synology/compose.yaml` (for example with the Text Editor
   package) as described in [Configuration](#configuration).
5. In **Container Manager → Project → Create**, name the project
   `mcp-synology`, set the path to `/docker/mcp-synology` and choose to use
   the existing `compose.yaml`. Container Manager builds the image and starts
   the container.

### Updating

1. Download the ZIP again and replace the `MCP-Synology-NAS-main` folder with
   the new one. Your `compose.yaml` in `mcp-synology/` stays untouched.
2. In **Container Manager → Project**, stop the `mcp-synology` project.
3. Under **Container**, delete `synology-mcp`; then under **Image**, delete
   `mcp-server-synology:latest`. Because `compose.yaml` names the image,
   Container Manager reuses an existing one instead of rebuilding it, so
   without this step the old code keeps running.
4. Back in **Project**, build `mcp-synology`. The build log should show
   `npm install` and `npm run build`.

Connected Claude conversations reconnect on their own after the restart.

## Configuration

Everything is configured in a single file, `compose.yaml`: no `.env` or other
files are needed. Edit the values in its `environment` block;
`SYNOLOGY_URL`, `SYNOLOGY_USER` and `SYNOLOGY_PASSWORD` are required and
everything else has a safe default. Each setting is documented inline.

- `SYNOLOGY_INSECURE_TLS` defaults to `"true"` because `SYNOLOGY_URL` is
  normally a LAN IP, and DSM's certificate never matches an IP. It is scoped
  to this client's connection pool rather than disabling TLS verification for
  the whole process. Set it to `"false"` only when `SYNOLOGY_URL` uses the
  hostname the certificate was issued for.
- A literal `$` in any value must be written as `$$`, or Compose treats it as
  a variable reference.
- Set `SYNOLOGY_MCP_TOKEN` to a long random value: it is the only credential
  the Claude connector sends.
- Once filled in, `compose.yaml` holds credentials: keep it private and never
  publish your filled-in copy.
- `build.context` defaults to `./MCP-Synology-NAS-main`, matching the
  layout above. If `compose.yaml` sits next to the `Dockerfile` (for example
  in a `git clone`), set it to `.`. GitHub names the extracted folder
  `<repository>-<branch>`, so a fork or another branch produces a different
  name: adjust `context` to match it exactly (it is case-sensitive).

The container binds to `127.0.0.1:3020`, so only a reverse proxy running on
the NAS can reach it.

### Local stdio

For a desktop MCP client running on the same machine:

```bash
npm install
npm run build
SYNOLOGY_MCP_TRANSPORT=stdio node dist/index.js
```

## Reaching a NAS that sits behind your home router

Claude connects to the MCP server from Anthropic's infrastructure over HTTPS,
so the server has to be reachable from the internet. The simplest way when it
runs on the NAS is DSM's built-in reverse proxy.

### DSM reverse proxy

**Requirements**

- Your router has a public IP address and is **not** behind CG-NAT.
- The router forwards TCP port 443 (HTTPS) to port 443 of the NAS's local IP
  address.
- A DSM hostname, such as a Synology DDNS name (`mynas.synology.me`), with a
  certificate that covers the subdomain you will use.

All the settings below live in **Control Panel → Login Portal → Advanced**.

**1. Access Control Profile.** Create a profile named `Claude` with these
rules, in this order:

| Action | Source | Purpose |
| --- | --- | --- |
| Allow | `160.79.104.0/21` | Anthropic's outbound range, used by Claude connectors |
| Allow | `192.168.1.0/24` | Your local network; adjust it to your own subnet |
| Deny | All | Everything else |

Anthropic may change its IP ranges; check its documentation if the
connector stops reaching the server.

**2. Reverse Proxy.** Create a rule named `MCP`:

| | Protocol | Hostname | Port |
| --- | --- | --- | --- |
| Source | HTTPS | A subdomain of your choice, e.g. `mcp.mynas.synology.me` | 443 |
| Destination | HTTP | `localhost` | 3020 |

In the source section, set **Access control profile** to `Claude`, then save.
The destination port matches the `ports` entry in `compose.yaml`.

### Alternatives

If you would rather not open port 443, or the MCP server runs on another host
that needs to reach DSM, use a private overlay network or a tunnel instead:

- **Tailscale** — install on the NAS and the host running this server, then use
  the NAS's tailnet address. Simplest option, no router changes.
- **WireGuard** — a manual tunnel if you already run one.
- **frp / Cloudflare Tunnel** — a reverse tunnel initiated from the NAS.

## Claude connector configuration

1. In Claude, open the connector settings and choose **Add custom connector**.
2. Give the connector a name of your choice.
3. Enter the URL of your MCP server as configured in the reverse proxy, for
   example `https://mcp.mynas.synology.me/`.
4. Choose the option without login (no OAuth).
5. Add the header `Authorization: Bearer <token>`, where `<token>` is the
   value of `SYNOLOGY_MCP_TOKEN` in your `compose.yaml`.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST /` or `POST /mcp` | MCP Streamable HTTP endpoint |
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

[MIT](LICENSE). Originally created by [Mrquj](https://github.com/Mrquj/mcp-server-synology).
