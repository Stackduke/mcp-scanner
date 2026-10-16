import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readTool } from "./client.ts";
import { takeSnapshot } from "./snapshot.ts";
import type { Snapshot, ToolDefinition } from "./types.ts";

/** Writes a file whole or not at all, so a run stopped halfway leaves the old file in place. */
export async function writeWhole(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.partial`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

export const snapshotText = (snapshot: Snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`;

export async function save(snapshot: Snapshot): Promise<string> {
  const name = snapshot.source.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9.@-]+/g, "_").slice(0, 120);
  const directory = path.join("data", "snapshots", name);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${snapshot.takenAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return file;
}

/** A saved snapshot read back with nothing taken on trust: the file may have been made by hand. */
export async function readSnapshot(file: string): Promise<Snapshot | null> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { source, takenAt, server, tools } = parsed as Record<string, unknown>;
  if (typeof source !== "string" || typeof takenAt !== "string" || !Array.isArray(tools)) return null;
  const seen = new Map<string, number>();
  const read = tools.map((tool) => {
    const definition = readTool(tool);
    if (!definition) return null;
    const given = (tool as { variant?: unknown }).variant;
    // A source may give several definitions of one tool, as named variants or by repeating the name.
    // Each is kept, because the serious one may not be the first.
    const base = typeof given === "string" && given ? `${definition.name}#${given}` : definition.name;
    const times = (seen.get(base) ?? 0) + 1;
    seen.set(base, times);
    const variant = [typeof given === "string" ? given : "", times > 1 ? `repeat-${times}` : ""].filter(Boolean).join("-");
    return variant ? { ...definition, variant } : definition;
  });
  if (read.some((tool) => tool === null)) return null;
  const name = typeof server === "object" && server !== null ? (server as { name?: unknown }).name : undefined;
  return takeSnapshot(source, read as Array<ToolDefinition & { variant?: string }>, typeof name === "string" ? { name } : undefined, takenAt);
}

