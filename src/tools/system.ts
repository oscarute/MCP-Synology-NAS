import { z } from "zod";
import { defineTool, humanBytes, isoTime } from "../tool.js";

export const systemTools = [
  defineTool({
    name: "get_system_info",
    title: "Get NAS system information",
    description:
      "Returns the NAS model, DSM version, serial number, uptime and temperature. Use this for a general health check of the Synology.",
    readOnly: true,
    idempotent: true,
    schema: z.object({}),
    handler: async (ctx) => {
      const info = await ctx.client.request<Record<string, any>>(
        "SYNO.Core.System",
        "info",
        {},
        { version: 1 },
      );

      const uptimeSeconds = Number(info.up_time ?? 0);
      return {
        model: info.model,
        dsmVersion: info.firmware_ver,
        serial: info.serial,
        cpu: info.cpu_clock_speed
          ? `${info.cpu_series ?? ""} ${info.cpu_clock_speed}MHz x${info.cpu_cores ?? "?"}`.trim()
          : info.cpu_series,
        totalMemory: info.ram_size ? `${info.ram_size} MB` : undefined,
        temperature: info.sys_temp ? `${info.sys_temp} C` : undefined,
        temperatureWarning: info.temperature_warning,
        uptime:
          typeof info.up_time === "string"
            ? info.up_time
            : uptimeSeconds
              ? `${Math.floor(uptimeSeconds / 86400)}d ${Math.floor((uptimeSeconds % 86400) / 3600)}h`
              : undefined,
        time: info.time,
      };
    },
  }),

  defineTool({
    name: "get_resource_usage",
    title: "Get live CPU, memory, disk and network load",
    description:
      "Returns current CPU, memory, disk I/O and network throughput for the NAS. Use this to answer why the NAS feels slow or what is consuming resources.",
    readOnly: true,
    schema: z.object({}),
    handler: async (ctx) => {
      const data = await ctx.client.request<Record<string, any>>(
        "SYNO.Core.System.Utilization",
        "get",
        { type: "current" },
      );

      const cpu = data.cpu ?? {};
      const memory = data.memory ?? {};
      const network = Array.isArray(data.network) ? data.network : [];

      const cpuTotal =
        Number(cpu.user_load ?? 0) +
        Number(cpu.system_load ?? 0) +
        Number(cpu.other_load ?? 0);

      return {
        cpu: {
          totalPercent: cpuTotal,
          userPercent: cpu.user_load,
          systemPercent: cpu.system_load,
          loadAverage1min: cpu["1min_load"],
          loadAverage5min: cpu["5min_load"],
        },
        memory: {
          usedPercent: memory.real_usage,
          totalMemory: humanBytes(Number(memory.total_real ?? 0) * 1024),
          available: humanBytes(Number(memory.avail_real ?? 0) * 1024),
          cached: humanBytes(Number(memory.cached ?? 0) * 1024),
        },
        network: network.map((iface: Record<string, unknown>) => ({
          device: iface.device,
          receive: `${humanBytes(Number(iface.rx ?? 0))}/s`,
          transmit: `${humanBytes(Number(iface.tx ?? 0))}/s`,
        })),
        disks: Array.isArray(data.disk?.disk)
          ? data.disk.disk.map((disk: Record<string, unknown>) => ({
              device: disk.device,
              readBytesPerSecond: disk.read_byte,
              writeBytesPerSecond: disk.write_byte,
              utilizationPercent: disk.utilization,
            }))
          : undefined,
      };
    },
  }),

  defineTool({
    name: "get_storage_info",
    title: "Get volumes, disks and storage health",
    description:
      "Returns storage pools, volumes and physical disks with capacity, free space and SMART health status. Use this to check whether the NAS is running out of space or has a failing drive.",
    readOnly: true,
    idempotent: true,
    schema: z.object({}),
    handler: async (ctx) => {
      const data = await ctx.client.request<Record<string, any>>(
        "SYNO.Storage.CS.Storage",
        "load_info",
      );

      const volumes = (data.volumes ?? []).map((volume: any) => {
        const total = Number(volume.size?.total ?? 0);
        const used = Number(volume.size?.used ?? 0);
        return {
          name: volume.id,
          description: volume.display_name ?? volume.desc,
          fileSystem: volume.fs_type,
          status: volume.status,
          total: humanBytes(total),
          used: humanBytes(used),
          free: humanBytes(total - used),
          usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
          raidType: volume.raid_type,
        };
      });

      const disks = (data.disks ?? []).map((disk: any) => ({
        slot: disk.id,
        model: disk.model,
        vendor: disk.vendor,
        capacity: humanBytes(Number(disk.size_total ?? 0)),
        temperature: disk.temp ? `${disk.temp} C` : undefined,
        smartStatus: disk.smart_status,
        health: disk.status,
        badSectors: disk.num_bad_sector,
      }));

      return {
        volumes,
        disks,
        warnings: volumes
          .filter((volume: any) => volume.usedPercent >= 85)
          .map(
            (volume: any) =>
              `${volume.name} is ${volume.usedPercent}% full (${volume.free} free).`,
          ),
      };
    },
  }),

  defineTool({
    name: "list_installed_packages",
    title: "List installed DSM packages",
    description:
      "Lists the packages installed on the NAS with their version and running state. Use this to check whether Download Station, Photos or Container Manager are available before calling their tools.",
    readOnly: true,
    idempotent: true,
    schema: z.object({
      onlyRunning: z.boolean().default(false),
    }),
    handler: async (ctx, args) => {
      const data = await ctx.client.request<{ packages: any[] }>(
        "SYNO.Core.Package",
        "list",
        { additional: '["status","installed_info"]' },
      );

      const packages = (data.packages ?? [])
        .map((pkg: any) => ({
          id: pkg.id,
          name: pkg.name ?? pkg.dname,
          version: pkg.version ?? pkg.installed_info?.version,
          status: pkg.additional?.status ?? pkg.status,
        }))
        .filter((pkg: any) => !args.onlyRunning || pkg.status === "running");

      return { total: packages.length, packages };
    },
  }),

  defineTool({
    name: "list_shares_admin",
    title: "List shared folder configuration",
    description:
      "Lists the shared folders defined on the NAS with their volume, encryption state and recycle-bin settings. This is the administrative view, unlike list_shared_folders which shows what is browsable.",
    readOnly: true,
    idempotent: true,
    schema: z.object({}),
    handler: async (ctx) => {
      const data = await ctx.client.request<{ shares: any[] }>(
        "SYNO.Core.Share",
        "list",
        { additional: '["encryption","recyclebin","quota"]' },
      );
      return {
        shares: (data.shares ?? []).map((share: any) => ({
          name: share.name,
          path: share.vol_path ?? share.path,
          description: share.desc,
          encrypted: share.encryption === 1 || share.enc === true,
          recycleBin: share.additional?.recyclebin?.enable_recycle_bin,
          hidden: share.hidden,
        })),
      };
    },
  }),

  defineTool({
    name: "list_active_connections",
    title: "List active user connections",
    description:
      "Shows who is currently connected to the NAS and over which protocol (SMB, AFP, FTP, DSM web, SFTP). Useful for spotting unexpected access.",
    readOnly: true,
    schema: z.object({}),
    handler: async (ctx) => {
      const data = await ctx.client.request<{ items: any[] }>(
        "SYNO.Core.CurrentConnection",
        "list",
        { offset: 0, limit: 200 },
      );
      return {
        connections: (data.items ?? []).map((item: any) => ({
          user: item.username,
          from: item.from,
          protocol: item.type,
          since: isoTime(Number(item.time) || undefined),
        })),
      };
    },
  }),

  defineTool({
    name: "control_system_power",
    title: "Reboot or shut down the NAS",
    description:
      "Reboots or shuts down the Synology NAS. Every service on it goes offline, and a shutdown cannot be undone remotely because the NAS must be powered on physically. Requires SYNOLOGY_ALLOW_SYSTEM_CONTROL=true.",
    destructive: true,
    schema: z.object({
      action: z.enum(["reboot", "shutdown"]),
      confirm: z
        .literal(true)
        .describe("Must be true; confirms the NAS may go offline"),
    }),
    handler: async (ctx, args) => {
      ctx.policy.assertSystemControl(`control_system_power(${args.action})`);
      await ctx.client.request(
        "SYNO.Core.System",
        args.action,
        {},
        { method: "POST" },
      );
      return {
        action: args.action,
        note:
          args.action === "reboot"
            ? "The NAS is rebooting and will be unreachable for a few minutes."
            : "The NAS is shutting down and must be powered on physically.",
      };
    },
  }),
];
