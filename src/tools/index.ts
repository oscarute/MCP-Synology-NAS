import type { ToolDef } from "../tool.js";
import { containerTools } from "./container.js";
import { downloadStationTools } from "./download.js";
import { fileStationReadTools } from "./filestation.js";
import { fileStationWriteTools } from "./filestation-write.js";
import { genericTools } from "./generic.js";
import { photoTools } from "./photos.js";
import { projectTools } from "./project.js";
import { systemTools } from "./system.js";

/** Every tool the server can expose, before policy filtering. */
export const allTools: ToolDef[] = [
  ...fileStationReadTools,
  ...fileStationWriteTools,
  ...downloadStationTools,
  ...photoTools,
  ...containerTools,
  ...projectTools,
  ...systemTools,
  ...genericTools,
];

/** Fails fast at boot if two modules ever claim the same tool name. */
export function buildToolIndex(tools: ToolDef[]): Map<string, ToolDef> {
  const index = new Map<string, ToolDef>();
  for (const tool of tools) {
    if (index.has(tool.name)) {
      throw new Error(`Duplicate tool name registered: ${tool.name}`);
    }
    index.set(tool.name, tool);
  }
  return index;
}
