import { takeSnapshot } from "./snapshot.ts";
import type { Snapshot, ToolDefinition } from "./types.ts";

/**
 * `stackduke.lock.json`: the tools a server is approved to offer, kept in the repository beside
 * its code, so a change to them shows in a pull request like any other change.
 *
 * The file is written to be read in a diff. Tools are sorted by name, each tool's fields come in
 * a fixed order, keys inside schemas and annotations are sorted, and nothing in it depends on
 * when it was written, so the same tools always give the same bytes.
 *
 * A tool may carry `accepted`: findings a person has looked at and approved for that exact
 * definition, as `rule@where`. They are written only by `check --update --accept-findings`.
 */
export const lockfileName = "stackduke.lock.json";
const lockfileVersion = 1;
const about = "The MCP tools this server is approved to offer. Written by stackduke-mcp-scanner check --update. Review a change to this file as you would a change to code.";

export interface LockedTool extends ToolDefinition {
  accepted?: string[];
}

export interface Lockfile {
  tools: LockedTool[];
}

const toolFields = ["name", "title", "description", "annotations", "inputSchema", "outputSchema", "accepted"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A copy with every object's keys in sorted order. Array order is kept: in a schema it can carry meaning. */
function sortedDeep(value: unknown, depth = 0): unknown {
  if (depth > 200) throw new Error("a tool definition is nested too deeply to write");
  if (Array.isArray(value)) return value.map((item) => sortedDeep(item, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, sortedDeep(value[key], depth + 1)]));
  return value;
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The file's text for these tools. The same tools always give the same text. */
export function writeLockfile(tools: LockedTool[]): string {
  const entries = [...tools].sort(byName).map((tool) => {
    const entry: Record<string, unknown> = {};
    for (const field of toolFields) {
      const value = field === "accepted" ? (tool.accepted?.length ? [...new Set(tool.accepted)].sort() : undefined) : tool[field];
      if (value !== undefined) entry[field] = field === "name" ? value : sortedDeep(value);
    }
    return entry;
  });
  return `${JSON.stringify({ lockfileVersion, about, tools: entries }, null, 2)}\n`;
}

export type LockfileRead = { ok: true; lockfile: Lockfile } | { ok: false; reason: string };

/**
 * Reads the file strictly. A field this version does not know is refused, not ignored, so a
 * hand edit with a misspelt field cannot quietly leave a tool unchecked.
 */
export function readLockfile(text: string): LockfileRead {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: "it is not valid JSON" }; }
  if (!isRecord(parsed)) return { ok: false, reason: "it is not a JSON object" };
  if (parsed.lockfileVersion !== lockfileVersion) return { ok: false, reason: `its lockfileVersion is not ${lockfileVersion}` };
  if (!Array.isArray(parsed.tools)) return { ok: false, reason: "it has no tools list" };
  if (Object.keys(parsed).some((key) => !["lockfileVersion", "about", "tools"].includes(key))) return { ok: false, reason: "it has a field this version does not know" };
  const tools: LockedTool[] = [];
  const names = new Set<string>();
  for (const [index, item] of parsed.tools.entries()) {
    const at = `tool ${index + 1}`;
    if (!isRecord(item) || typeof item.name !== "string" || !item.name) return { ok: false, reason: `${at} has no name` };
    const unknown = Object.keys(item).find((key) => !(toolFields as readonly string[]).includes(key));
    if (unknown !== undefined) return { ok: false, reason: `${at} has a field this version does not know` };
    if (names.has(item.name)) return { ok: false, reason: `${at} repeats a name listed before it` };
    names.add(item.name);
    if ((item.title !== undefined && typeof item.title !== "string") || (item.description !== undefined && typeof item.description !== "string")) return { ok: false, reason: `${at} has a title or description that is not text` };
    if (item.annotations !== undefined && !isRecord(item.annotations)) return { ok: false, reason: `${at} has annotations that are not an object` };
    if (item.accepted !== undefined && !(Array.isArray(item.accepted) && item.accepted.every((key) => typeof key === "string"))) return { ok: false, reason: `${at} has an accepted list that is not a list of text` };
    tools.push(item as unknown as LockedTool);
  }
  return { ok: true, lockfile: { tools } };
}

/** The lockfile as a snapshot, so it can be compared with a live list the same way two scans are. */
export function lockSnapshot(lockfile: Lockfile | null): Snapshot {
  const tools = (lockfile?.tools ?? []).map(({ accepted: _accepted, ...tool }) => tool);
  return takeSnapshot(lockfileName, tools, undefined, "");
}
