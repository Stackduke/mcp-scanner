/**
 * Builds the lookup connector's data from the tracker's published data (the `data` branch).
 *
 * The connector never fetches anything at run time except these files, which are deployed with
 * it as static assets. So every answer comes from data Stackduke published and deploys itself.
 *
 *   node scripts/build-data.ts --data <folder holding the data branch> [--out build/data]
 *   node scripts/build-data.ts --git-ref origin/data [--out build/data]
 *
 * What it writes:
 *   meta.json   when the data was made, counts, and the catalog's servers the connector says nothing about
 *   s/<xx>.json the servers whose id starts with <xx> (the id is the tracker's: sha256 of the address, 12 hex)
 *   n/<xx>.json names to server ids, for names whose sha256 starts with <xx>
 *
 * Only identifiers, counts, kinds, field names, outcomes and timestamps are kept. The tracker's data
 * holds no tool descriptions or schemas, only fingerprints of them, and those are not copied either.
 * Tool and registry names are the servers' own words, so each is kept only when it looks like an
 * identifier; anything else is dropped and counted.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { catalog } from "../../src/catalog.ts";
import { keptOffSites } from "../../src/track.ts";
import { kinds, nameKey, namespaceHost, onSite, registryNamePattern, toolNamePattern } from "../src/shared.ts";
import type { ChangeRecord, Kind, Meta, NameEntry, ServerRecord } from "../src/shared.ts";

const changedFields = ["title", "description", "inputSchema", "outputSchema", "annotations"] as const;
const outcomes = ["listed", "sign-in-required", "not-usable", "unreachable", "no-token"] as const;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const idPattern = /^[0-9a-f]{12}$/;

/** Most names kept for one kind on one server; the count always has the full number. */
const namesPerKind = 200;
/** Most server ids kept under one name. A short name such as "mcp" can match thousands. */
export const idsPerName = 25;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isTimestamp = (value: unknown): value is string => typeof value === "string" && timestampPattern.test(value);
const isKind = (value: unknown): value is Kind => typeof value === "string" && (kinds as readonly string[]).includes(value);

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface BuildResult { meta: Meta; servers: Map<string, ServerRecord>; names: Map<string, string[]> }

/** Reads the data folder and returns everything the connector serves. Throws on data in an unknown shape. */
export async function buildData(dataDir: string, builtAt = new Date().toISOString()): Promise<BuildResult> {
  const read = (file: string) => JSON.parse(readFileSync(path.join(dataDir, file), "utf8")) as unknown;

  const feed = read("feed.json");
  if (!isRecord(feed) || feed.version !== 1 || !isTimestamp(feed.generatedAt) || !Array.isArray(feed.watched)) throw new Error("feed.json is not in the shape this build knows");
  const serverList = read("servers.json");
  if (!Array.isArray(serverList)) throw new Error("servers.json is not a list");

  // The catalog's servers the connector says nothing about.
  const forbiddenSites = [...keptOffSites()].sort();
  const forbidden = catalog.servers.filter((server) => !server.tracker.publish && "forbidden" in server.tracker && server.tracker.forbidden === true);
  const unpublished = catalog.servers.filter((server) => !server.tracker.publish && !forbidden.includes(server));
  const keptOff = (url: string, names: string[]) => {
    try {
      if (onSite(new URL(url).hostname, forbiddenSites)) return true;
    } catch {
      return true;
    }
    return names.some((name) => {
      const host = namespaceHost(name);
      return host !== null && onSite(host, forbiddenSites);
    });
  };

  const featuredByUrl = new Map<string, { id: string; name: string; site: string }>();
  for (const entry of feed.watched) {
    if (!isRecord(entry) || typeof entry.url !== "string" || typeof entry.vendor !== "string") continue;
    if (typeof entry.name !== "string" || typeof entry.site !== "string") continue;
    featuredByUrl.set(entry.url, { id: entry.vendor, name: entry.name, site: entry.site });
  }

  let withheldTotal = 0;
  const servers = new Map<string, ServerRecord>();
  for (const item of serverList) {
    if (!isRecord(item) || typeof item.id !== "string" || !idPattern.test(item.id) || typeof item.url !== "string") continue;
    const allNames = Array.isArray(item.names) ? item.names.filter((name): name is string => typeof name === "string") : [];
    if (keptOff(item.url, allNames)) continue;
    let withheld = 0;
    const registryNames = allNames.filter((name) => (registryNamePattern.test(name) ? true : (withheld += 1, false)));
    const record: ServerRecord = { id: item.id, url: item.url, registry_names: registryNames, kind_counts: {}, tools_by_kind: {}, changes: [], names_withheld: withheld };
    const featured = featuredByUrl.get(item.url);
    if (featured) record.featured = featured;
    if (isTimestamp(item.firstSeen)) record.first_seen = item.firstSeen;
    if (isTimestamp(item.lastChecked)) record.last_checked = item.lastChecked;
    if (isTimestamp(item.lastListed)) record.last_listed = item.lastListed;
    if (typeof item.outcome === "string" && (outcomes as readonly string[]).includes(item.outcome)) record.latest_outcome = item.outcome;
    if (isCount(item.tools)) record.tool_count = item.tools;
    if (isCount(item.changesIn30Days)) record.changes_last_30_days = item.changesIn30Days;
    if (isTimestamp(item.lastChange)) record.last_change = item.lastChange;
    if (isRecord(item.watchIn30Days)) {
      if (isCount(item.watchIn30Days.checks)) record.checks_last_30_days = item.watchIn30Days.checks;
      if (isCount(item.watchIn30Days.listed)) record.listed_last_30_days = item.watchIn30Days.listed;
    }
    if (isRecord(item.kinds)) for (const kind of kinds) if (isCount(item.kinds[kind]) && item.kinds[kind] > 0) record.kind_counts[kind] = item.kinds[kind];
    servers.set(item.id, record);
  }

  // Change history, the server's own annotations, and where each tool list is kept.
  const listFiles = new Map<string, string>();
  const lines = createInterface({ input: createReadStream(path.join(dataDir, "endpoints.jsonl")), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const endpoint = JSON.parse(line) as unknown;
    if (!isRecord(endpoint) || typeof endpoint.id !== "string") continue;
    const record = servers.get(endpoint.id);
    if (!record || endpoint.url !== record.url) continue;
    if (typeof endpoint.file === "string" && /^lists\/[0-9a-f]{2}\/[A-Za-z0-9.-]+\.json$/.test(endpoint.file)) listFiles.set(record.id, endpoint.file);
    if (isRecord(endpoint.labels)) {
      const { readOnly, changes, destructive, none } = endpoint.labels;
      if (isCount(readOnly) && isCount(changes) && isCount(destructive) && isCount(none)) record.server_annotations = { read_only: readOnly, changes, destructive, none };
    }
    if (Array.isArray(endpoint.changes)) {
      for (const change of endpoint.changes) {
        const parsed = readChange(change, () => (record.names_withheld += 1));
        if (parsed) record.changes.push(parsed);
      }
      record.changes.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    }
  }

  // Each tool's name and the kind the scanner guessed for it.
  for (const [id, file] of listFiles) {
    const record = servers.get(id) as ServerRecord;
    const full = path.join(dataDir, file);
    if (!existsSync(full)) continue;
    const list = JSON.parse(readFileSync(full, "utf8")) as unknown;
    if (!isRecord(list) || !Array.isArray(list.tools)) continue;
    for (const tool of list.tools) {
      if (!isRecord(tool) || !isKind(tool.kind)) continue;
      if (typeof tool.name !== "string" || !toolNamePattern.test(tool.name)) {
        record.names_withheld += 1;
        continue;
      }
      const names = (record.tools_by_kind[tool.kind] ??= []);
      if (names.length < namesPerKind) names.push(tool.name);
    }
  }

  // Names to ids: full registry names, the part after the slash, and featured servers' id and name.
  const names = new Map<string, string[]>();
  const file = (name: string, id: string) => {
    const key = nameKey(name);
    if (!key) return;
    const ids = names.get(key) ?? [];
    if (!ids.includes(id)) ids.push(id);
    names.set(key, ids);
  };
  for (const record of servers.values()) {
    withheldTotal += record.names_withheld;
    for (const name of record.registry_names) {
      file(name, record.id);
      const short = name.slice(name.lastIndexOf("/") + 1);
      if (short && short !== name) file(short, record.id);
    }
    if (record.featured) {
      file(record.featured.id, record.id);
      file(record.featured.name, record.id);
    }
  }
  // Featured servers first under a shared name, then by id, so the order is stable from one build to the next.
  for (const ids of names.values()) ids.sort((a, b) => Number(Boolean(servers.get(b)?.featured)) - Number(Boolean(servers.get(a)?.featured)) || (a < b ? -1 : 1));

  const meta: Meta = {
    version: 1,
    generated_at: feed.generatedAt,
    built_at: builtAt,
    servers: servers.size,
    featured: [...servers.values()].filter((record) => record.featured).length,
    names_withheld: withheldTotal,
    forbidden_sites: forbiddenSites,
    forbidden_names: [...new Set(forbidden.flatMap((server) => [server.id, server.name].map(nameKey)))].sort(),
    unpublished_urls: unpublished.map((server) => server.url).sort(),
    unpublished_names: [...new Set(unpublished.flatMap((server) => [server.id, server.name].map(nameKey)))].sort(),
  };
  return { meta, servers, names };
}

function readChange(change: unknown, withhold: () => void): ChangeRecord | null {
  if (!isRecord(change) || !isTimestamp(change.at) || !isTimestamp(change.since)) return null;
  const identifiers = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((name): name is string => (typeof name === "string" && toolNamePattern.test(name) ? true : (withhold(), false)));
  };
  const changed = Array.isArray(change.changed)
    ? change.changed.flatMap((tool) => {
        if (!isRecord(tool)) return [];
        if (typeof tool.name !== "string" || !toolNamePattern.test(tool.name)) return (withhold(), []);
        const fields = Array.isArray(tool.fields) ? tool.fields.filter((field): field is string => typeof field === "string" && (changedFields as readonly string[]).includes(field)) : [];
        return [{ name: tool.name, fields: [...new Set(fields)] }];
      })
    : [];
  const moreSerious = Array.isArray(change.moreSerious)
    ? change.moreSerious.flatMap((tool) => {
        if (!isRecord(tool) || !isKind(tool.kind)) return [];
        if (typeof tool.name !== "string" || !toolNamePattern.test(tool.name)) return (withhold(), []);
        return [{ name: tool.name, kind: tool.kind }];
      })
    : [];
  const counts = isRecord(change.counts) ? change.counts : {};
  const added = identifiers(change.added), removed = identifiers(change.removed);
  return {
    at: change.at,
    since: change.since,
    added,
    removed,
    changed,
    more_serious: moreSerious,
    // A count never falls below what is shown.
    counts: {
      added: Math.max(isCount(counts.added) ? counts.added : 0, added.length),
      removed: Math.max(isCount(counts.removed) ? counts.removed : 0, removed.length),
      changed: Math.max(isCount(counts.changed) ? counts.changed : 0, changed.length),
      more_serious: Math.max(isCount(counts.moreSerious) ? counts.moreSerious : 0, moreSerious.length),
    },
  };
}

/** Writes the build to `outDir`: meta.json, s/<xx>.json and n/<xx>.json. */
export async function writeData({ meta, servers, names }: BuildResult, outDir: string): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "s"), { recursive: true });
  await mkdir(path.join(outDir, "n"), { recursive: true });
  const serverShards = new Map<string, Record<string, ServerRecord>>();
  for (const record of servers.values()) {
    const shard = record.id.slice(0, 2);
    (serverShards.get(shard) ?? serverShards.set(shard, {}).get(shard) as Record<string, ServerRecord>)[record.id] = record;
  }
  const nameShards = new Map<string, Record<string, NameEntry>>();
  for (const [key, ids] of names) {
    const shard = sha256(key).slice(0, 2);
    (nameShards.get(shard) ?? nameShards.set(shard, {}).get(shard) as Record<string, NameEntry>)[key] = { ids: ids.slice(0, idsPerName), total: ids.length };
  }
  // Every shard exists, empty or not, so a missing file always means a broken build.
  for (let i = 0; i < 256; i += 1) {
    const shard = i.toString(16).padStart(2, "0");
    await writeFile(path.join(outDir, "s", `${shard}.json`), JSON.stringify(serverShards.get(shard) ?? {}));
    await writeFile(path.join(outDir, "n", `${shard}.json`), JSON.stringify(nameShards.get(shard) ?? {}));
  }
  await writeFile(path.join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(argument("--out") ?? path.join(here, "..", "build", "data"));
  let dataDir = argument("--data");
  let cleanup: string | undefined;
  if (!dataDir) {
    const ref = argument("--git-ref") ?? "origin/data";
    if (!/^[A-Za-z0-9_./-]{1,100}$/.test(ref)) throw new Error("--git-ref must be a plain branch or commit name");
    cleanup = dataDir = mkdtempSync(path.join(tmpdir(), "lookup-data-"));
    const archive = execFileSync("git", ["archive", ref], { maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", dataDir], { input: archive });
  }
  try {
    const result = await buildData(path.resolve(dataDir));
    await writeData(result, outDir);
    console.log(`Wrote ${result.meta.servers} servers (${result.meta.featured} featured, ${result.names.size} names, ${result.meta.names_withheld} names withheld) from data made at ${result.meta.generated_at} to ${outDir}`);
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
