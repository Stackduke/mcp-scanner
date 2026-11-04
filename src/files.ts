import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
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

/** The folder a source's snapshots are saved in, under `base`. */
export function snapshotFolder(source: string, base = path.join("data", "snapshots")): string {
  const name = source.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9.@-]+/g, "_").slice(0, 120);
  return path.join(base, name);
}

/** The most recent snapshot saved for a source, or null when none was saved or it cannot be read. */
export async function latestSnapshot(source: string, base?: string): Promise<Snapshot | null> {
  const directory = snapshotFolder(source, base);
  let names: string[];
  try { names = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort(); } catch { return null; }
  // File names are the time each was taken, so the last in order is the latest.
  for (const name of names.reverse()) {
    const snapshot = await readSnapshot(path.join(directory, name));
    if (snapshot && snapshot.source === source) return snapshot;
  }
  return null;
}

export async function save(snapshot: Snapshot, base?: string): Promise<string> {
  const directory = snapshotFolder(snapshot.source, base);
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

