import { createHash } from "node:crypto";
import type { Snapshot, SnapshotTool, ToolDefinition } from "./types.ts";

/**
 * JSON with object keys in sorted order, so two definitions that mean the same thing produce
 * the same text whatever order a server happened to send their fields in. Array order is kept:
 * in a schema it can carry meaning.
 */
export function canonical(value: unknown, depth = 0): string {
  // A definition nested this deeply is not a real schema, and following it would exhaust the stack.
  if (depth > 200) throw new Error("a tool definition is nested too deeply to read");
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprint(tool: ToolDefinition): string {
  const { name, title, description, inputSchema, outputSchema, annotations } = tool;
  return createHash("sha256").update(canonical({ name, title, description, inputSchema, outputSchema, annotations })).digest("hex");
}

/** What a definition is matched by across snapshots: its tool name, and its variant when it has one. */
export const toolKey = (tool: { name: string; variant?: string }): string => (tool.variant ? `${tool.name}#${tool.variant}` : tool.name);

/** A snapshot with its tools sorted by name, so two snapshots of the same server line up. */
export function takeSnapshot(source: string, tools: Array<ToolDefinition & { variant?: string }>, server?: Snapshot["server"], takenAt: string = new Date().toISOString()): Snapshot {
  const seen = new Set<string>();
  const kept: SnapshotTool[] = [];
  for (const { variant, ...tool } of tools) {
    // A server that lists one name twice is offering one tool; the first definition is the one a client would use.
    const key = toolKey({ name: tool.name, ...(variant ? { variant } : {}) });
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...tool, hash: fingerprint(tool), ...(variant ? { variant } : {}) });
  }
  kept.sort((a, b) => { const x = toolKey(a), y = toolKey(b); return x < y ? -1 : x > y ? 1 : 0; });
  return { source, takenAt, ...(server && (server.name || server.version) ? { server } : {}), tools: kept };
}
