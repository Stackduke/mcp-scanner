import { isDeepStrictEqual } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { sha256 } from "./manifest.ts";
import { keptOffSites } from "./track.ts";
import { lookupOf, siteOf } from "./tracker.ts";
import type { FeedServer } from "./tracker.ts";

/**
 * Where Radar's history lives in object storage (the `radar` bucket, served at https://data.stackduke.com), and
 * what one scan becomes there. docs/data-layout.md is the contract for readers; this file is its code.
 *
 *   latest.json                              the one mutable object, written last: which scan is current
 *   scans/<scan-id>/scan.json                what the scan is, and the sha256 of each of its files
 *   scans/<scan-id>/manifest.json            the scan's manifest and, when signed, manifest.sigstore.json
 *   snapshots/<scan-id>/endpoints.jsonl.gz   every endpoint as the scan left it
 *   snapshots/<scan-id>/lists.jsonl.gz       every current tool list, one per line
 *   snapshots/<scan-id>/{feed,servers,lookup,registry,hosts}.json
 *   lists/<endpoint-id>/<sha256>.json        each version of an endpoint's tool list, by the sha256 of its bytes
 *   evidence/<endpoint-id>/<sha256>.json     reserved for raw responses, the same way
 *
 * Every key but latest.json is immutable: written once, never overwritten, never deleted. The bulky copies have
 * their own prefix, snapshots/, apart from the small records under scans/, because a bucket rule (a lock, or a
 * storage class should one ever be worth it) can only match a prefix, and keys cannot be moved once readers use
 * them. Nothing about a server tracked privately is ever planned: a scan that holds any is refused whole.
 */
export const layoutVersion = 1;
export const pointerKey = "latest.json";

const immutableCache = "public, max-age=31536000, immutable";
/** Short, so a reader sees a new scan within a minute; the scan's own files are cached for a year. */
const pointerCache = "public, max-age=60";

export interface PlannedObject {
  key: string;
  /** The bytes as stored. */
  body: Buffer;
  contentType: string;
  cacheControl: string;
  /**
   * The sha256 of the content: of the bytes, or of the bytes before compression for a .gz key, so a retry whose
   * gzip came out differently still counts as the same object. Stored with the object, and compared when the key
   * is already there.
   */
  sourceSha256: string;
  /** The size of that content. */
  sourceBytes: number;
}

export { sha256 };

/** A scan's id: when it started, to the second, in UTC. Sortable, so the newest id is the greatest. */
export function scanIdOf(time: string): string {
  const parsed = new Date(time);
  if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(time)) throw new Error(`Not a time a scan can be named by: ${time}`);
  const iso = parsed.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}
const scanIdPattern = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;
const publicId = /^[0-9a-f]{12}$/;

export const scanKey = (id: string, name: string) => `scans/${id}/${name}`;
export const snapshotKey = (id: string, name: string) => `snapshots/${id}/${name}`;
export const listKey = (endpointId: string, hash: string) => `lists/${endpointId}/${hash}.json`;
export const evidenceKey = (endpointId: string, hash: string) => `evidence/${endpointId}/${hash}.json`;

/** A scan's small records, under scans/<scan-id>/, kept in Standard storage. */
export const recordFiles = ["scan.json", "manifest.json", "manifest.sigstore.json"] as const;
/** A scan's copies of the data folder, under snapshots/<scan-id>/: the bulk of each scan. */
export const snapshotFiles = ["endpoints.jsonl.gz", "lists.jsonl.gz", "feed.json", "servers.json", "lookup.json", "registry.json", "hosts.json"] as const;
const names = (list: readonly string[]) => list.map((name) => name.replace(/\./g, "\\.")).join("|");
const keyPattern = new RegExp(`^(latest\\.json|scans/\\d{4}-\\d{2}-\\d{2}T\\d{6}Z/(${names(recordFiles)})|snapshots/\\d{4}-\\d{2}-\\d{2}T\\d{6}Z/(${names(snapshotFiles)})|(lists|evidence)/[0-9a-f]{12}/[0-9a-f]{64}\\.json)$`);
/** Every key the layout has. Nothing else is ever written. */
export const isLayoutKey = (key: string) => keyPattern.test(key);

export const contentTypeOf = (key: string) => (key.endsWith(".gz") ? "application/gzip" : "application/json");

function planned(key: string, content: Buffer): PlannedObject {
  if (!isLayoutKey(key)) throw new Error(`Not a key of layout ${layoutVersion}: ${key}`);
  const body = key.endsWith(".gz") ? gzipSync(content, { level: 9 }) : content;
  return { key, body, contentType: contentTypeOf(key), cacheControl: key === pointerKey ? pointerCache : immutableCache, sourceSha256: sha256(content), sourceBytes: content.length };
}

/** The content sha256 of an object as stored: of its bytes, or of what they decompress to for a .gz key. */
export const sourceSha256Of = (key: string, body: Buffer) => sha256(key.endsWith(".gz") ? gunzipSync(body) : body);

/** Thrown when a scan holds anything about a server tracked privately. Its message names no server: logs are public. */
export class PrivateDataError extends Error {}

/**
 * Whether a record (an endpoint, a feed entry, a servers row) is about a server watched with a sign-in. Layout 1
 * has no place for those (their ids are not 12 hex characters, and watched/ has no key), so every one is treated
 * as tracked privately, even a vendor the catalog marks `publish: true`: such a scan is refused until the layout
 * gives them a place. Only fields the scanner writes itself are read (`signedIn`, and an id of the form
 * signed-in-<vendor>); a server's own text never decides it, so no server can block an upload by naming a tool
 * after a vendor.
 */
export function isPrivateRecord(record: unknown): boolean {
  if (typeof record !== "object" || record === null) return false;
  const { id, signedIn } = record as { id?: unknown; signedIn?: unknown };
  return signedIn !== undefined || (typeof id === "string" && id.startsWith("signed-in-"));
}

const keptOff = keptOffSites();
/**
 * Whether an address is on the site of a vendor whose terms forbid publishing about it (`forbidden` in the
 * catalog, the tracker's keptOffSites). The tracker never checks or keeps such an address; this is the uploader's
 * own check, so a slip in the tracker still cannot publish one.
 */
export function isKeptOff(url: unknown, sites: ReadonlySet<string> = keptOff): boolean {
  if (typeof url !== "string") return false;
  try { return sites.has(siteOf(url)); } catch { return false; }
}
/** The host in a list file's name (lists/ab/<host>-<id>.json), as an address. */
export const listFileUrl = (listPath: string) => {
  const host = /^lists\/[^/]+\/(.+)-[^-/]+\.json$/.exec(listPath)?.[1];
  return host ? `https://${host}/` : undefined;
};

export type ScanSource =
  | { kind: "track"; scanStartedAt: string; scannerCommit: string; methodVersion?: string; run?: { id: string; attempt: string; repository: string } }
  | { kind: "data-branch"; commit: string; committedAt: string; scanStartedAt?: string };

/** One scan's files, wherever they came from: a scan's data folder, or a commit of the data branch. */
export interface ScanInput {
  id: string;
  source: ScanSource;
  /** The data folder's own files by name: endpoints.jsonl (required), feed.json, servers.json, lookup.json, registry.json, hosts.json. */
  files: Map<string, Buffer>;
  /** Every tool list in the folder, by its path there (lists/ab/<host>-<id>.json). */
  lists: Map<string, Buffer>;
  /** The lists this scan wrote: each becomes a lists/<endpoint-id>/<sha256>.json object. */
  newLists: ReadonlySet<string>;
  /** Raw responses this scan wrote, by path (evidence/<endpoint-id>/<name>.json). */
  evidence?: Map<string, Buffer>;
  manifest?: Buffer;
  signature?: Buffer;
}

export interface ScanRecord {
  layout: number;
  id: string;
  source: ScanSource;
  /** Whether manifest.sigstore.json is among the files. */
  signed: boolean;
  /** Every other file of the scan (its manifest and snapshot), with the sha256 and size of its content (before compression for .gz). */
  files: Array<{ key: string; sha256: string; bytes: number }>;
  /** How many lists the scan holds, and the keys of the versions first seen in it. */
  lists: { current: number; written: string[] };
  evidence: string[];
}

export interface ScanPlan {
  id: string;
  record: ScanRecord;
  /** Every immutable object of the scan. latest.json is not among them: it is written last, from what is in the bucket. */
  objects: PlannedObject[];
  /** List files no endpoint names, kept under the endpoint id in their file name. */
  orphanLists: number;
  /** List files no endpoint names and with no endpoint id in their name, left out. */
  leftOutLists: number;
}

const topFiles = ["feed.json", "servers.json", "lookup.json", "registry.json", "hosts.json"] as const;

/**
 * The fields each top file may have, from the tracker's own types (Feed, RegistryState, HostsFile and the lookup
 * file). Anything else stops the scan: a field added later is published only once the layout knows it holds
 * public data alone.
 */
const knownFields: Record<string, ReadonlySet<string>> = {
  "feed.json": new Set(["version", "generatedAt", "registry", "coverage", "watched", "changes", "changesTotal", "trackingSince", "across"]),
  "registry.json": new Set(["readAt", "complete", "entries", "endpoints", "attemptedAt", "attemptOk"]),
  "lookup.json": new Set(["version", "generatedAt", "rows"]),
  "hosts.json": new Set(["version", "hosts"]),
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** The 12-hex endpoint id at the end of a list file's name: lists/ab/<host>-<id>.json. */
const listFileId = (listPath: string) => /-([0-9a-f]{12})\.json$/.exec(listPath)?.[1];

function parseJson(name: string, bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${name} is not valid JSON.`); }
}

const refused = (where: string) => new PrivateDataError(`Refused: ${where} holds data about a server tracked privately. Nothing from such a server may reach the public bucket, so nothing was planned.`);
const keptOffRefused = (where: string) => new PrivateDataError(`Refused: ${where} holds data about a site whose terms forbid publishing about it. Nothing about such a site may reach the public bucket, so nothing was planned.`);

/** Builds everything one scan becomes in the bucket, or throws before anything is written. */
export function planScan(input: ScanInput): ScanPlan {
  const { id, source } = input;
  if (!scanIdPattern.test(id)) throw new Error(`Not a scan id: ${id}`);

  const endpointsText = input.files.get("endpoints.jsonl");
  if (!endpointsText) throw new Error("The scan has no endpoints.jsonl.");
  /** Each public endpoint's list file, to the endpoint's id. */
  const listOwner = new Map<string, string>();
  const endpointIds = new Set<string>();
  endpointsText.toString("utf8").split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const record = parseJson(`endpoints.jsonl line ${index + 1}`, Buffer.from(line));
    if (isPrivateRecord(record)) throw refused(`endpoints.jsonl line ${index + 1}`);
    const { id: endpointId, url, file } = (record ?? {}) as { id?: unknown; url?: unknown; file?: unknown };
    if (typeof endpointId !== "string") throw new Error(`endpoints.jsonl line ${index + 1} has no id.`);
    endpointIds.add(endpointId);
    if (isKeptOff(url)) throw keptOffRefused(`endpoints.jsonl line ${index + 1}`);
    if (typeof file === "string") listOwner.set(file, endpointId);
  });

  // Each top file holds only fields the layout knows, and its rows are about endpoints of this scan.
  const parsedTop = new Map<string, unknown>();
  for (const [name, fields] of Object.entries(knownFields)) {
    const bytes = input.files.get(name);
    if (!bytes) continue;
    const parsed = parseJson(name, bytes);
    if (!isObject(parsed)) throw new Error(`${name} is not an object.`);
    const unknown = Object.keys(parsed).filter((field) => !fields.has(field));
    if (unknown.length) throw new Error(`${name} has fields layout ${layoutVersion} does not know (${unknown.join(", ")}), so nothing was planned.`);
    parsedTop.set(name, parsed);
  }
  const feed = parsedTop.get("feed.json") as Record<string, unknown> | undefined;
  for (const field of ["watched", "changes"] as const) {
    const entries = feed?.[field];
    if (Array.isArray(entries) && entries.some((entry) => isPrivateRecord(entry))) throw refused(`feed.json (${field})`);
    if (Array.isArray(entries) && entries.some((entry) => isKeptOff((entry as { url?: unknown })?.url))) throw keptOffRefused(`feed.json (${field})`);
  }
  const servers = input.files.get("servers.json");
  const serverRows = servers ? parseJson("servers.json", servers) : [];
  if (!Array.isArray(serverRows)) throw new Error("servers.json is not a list.");
  serverRows.forEach((row, index) => {
    if (isPrivateRecord(row)) throw refused("servers.json");
    if (!endpointIds.has((row as { id?: unknown })?.id as string)) throw new Error(`servers.json row ${index + 1} is not an endpoint of this scan.`);
  });
  // lookup.json is made from servers.json alone (tracker.ts, lookupOf), so it must be exactly that.
  const lookup = parsedTop.get("lookup.json") as { rows?: unknown } | undefined;
  if (lookup) {
    const expected = (() => { try { return lookupOf(serverRows as FeedServer[]); } catch { return null; } })();
    if (!servers || !isDeepStrictEqual(lookup.rows, expected)) throw new Error("lookup.json is not the lookup of this scan's servers.json, so nothing was planned.");
  }
  // hosts.json names hosts the public crawl spent its time on; each entry holds two counters and nothing else.
  const hosts = (parsedTop.get("hosts.json") as { hosts?: unknown } | undefined)?.hosts;
  if (parsedTop.has("hosts.json") && (!isObject(hosts) || Object.values(hosts).some((entry) => !isObject(entry) || Object.keys(entry).some((field) => field !== "overBudgetRuns" && field !== "lastOverBudget")))) {
    throw new Error(`hosts.json has fields layout ${layoutVersion} does not know, so nothing was planned.`);
  }
  if (isObject(hosts) && Object.keys(hosts).some((host) => isKeptOff(`https://${host}/`))) throw keptOffRefused("hosts.json");

  // Every current list, in one file a reader can take whole, and each version first seen here on its own.
  const bundle: string[] = [];
  const objects: PlannedObject[] = [];
  const written: string[] = [];
  let orphanLists = 0, leftOutLists = 0;
  for (const [listPath, bytes] of [...input.lists].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // By the host in its name, and by the address it says it was read from.
    if (isKeptOff(listFileUrl(listPath)) || isKeptOff((() => { try { return (JSON.parse(bytes.toString("utf8")) as { source?: unknown })?.source; } catch { return undefined; } })())) throw keptOffRefused("a tool list");
    if (listPath.includes("signed-in-") && !listOwner.has(listPath)) throw refused(listPath.slice(0, listPath.lastIndexOf("/") + 1));
    // A list no endpoint names (its endpoint left the registry, or was kept off) is still public: it is kept
    // under the id in its file name, which the tracker derives from the endpoint's address.
    const owner = listOwner.get(listPath) ?? listFileId(listPath);
    if (owner === undefined) {
      if (input.newLists.has(listPath)) throw new Error(`${listPath} was written by the scan, but no endpoint names it.`);
      leftOutLists += 1;
      continue;
    }
    if (!listOwner.has(listPath)) orphanLists += 1;
    if (!publicId.test(owner)) throw new Error(`An endpoint id that is not part of layout ${layoutVersion} owns ${listPath}.`);
    const text = bytes.toString("utf8").trim();
    if (text.includes("\n")) throw new Error(`${listPath} is not one line of JSON.`);
    parseJson(listPath, Buffer.from(text));
    const hash = sha256(bytes);
    bundle.push(`{"id":${JSON.stringify(owner)},"path":${JSON.stringify(listPath)},"sha256":"${hash}","list":${text}}`);
    if (input.newLists.has(listPath)) {
      objects.push(planned(listKey(owner, hash), bytes));
      written.push(listKey(owner, hash));
    }
  }
  for (const listPath of input.newLists) if (!input.lists.has(listPath)) throw new Error(`${listPath} was written by the scan, but is not in its folder.`);

  const evidence: string[] = [];
  for (const [evidencePath, bytes] of [...(input.evidence ?? [])].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const owner = /^evidence\/([0-9a-f]{12})\/[A-Za-z0-9._-]+\.json$/.exec(evidencePath)?.[1];
    if (!owner || !endpointIds.has(owner)) throw new Error(`${evidencePath} is not evidence for an endpoint of this scan.`);
    parseJson(evidencePath, bytes);
    objects.push(planned(evidenceKey(owner, sha256(bytes)), bytes));
    evidence.push(evidenceKey(owner, sha256(bytes)));
  }

  const scanObjects: PlannedObject[] = [
    planned(snapshotKey(id, "endpoints.jsonl.gz"), endpointsText),
    planned(snapshotKey(id, "lists.jsonl.gz"), Buffer.from(bundle.length ? `${bundle.join("\n")}\n` : "")),
    ...topFiles.flatMap((name) => { const bytes = input.files.get(name); return bytes ? [planned(snapshotKey(id, name), bytes)] : []; }),
    ...(input.manifest ? [planned(scanKey(id, "manifest.json"), input.manifest)] : []),
    ...(input.signature ? [planned(scanKey(id, "manifest.sigstore.json"), input.signature)] : []),
  ];
  const record: ScanRecord = {
    layout: layoutVersion,
    id,
    source,
    signed: Boolean(input.signature),
    files: scanObjects.map((object) => ({ key: object.key, sha256: object.sourceSha256, bytes: object.sourceBytes })),
    lists: { current: bundle.length, written },
    evidence,
  };
  // Content-addressed objects first, the scan's own files next, scan.json after them.
  objects.push(...scanObjects, planned(scanKey(id, "scan.json"), Buffer.from(`${JSON.stringify(record, null, 2)}\n`)));
  const keys = new Set<string>();
  for (const object of objects) {
    if (keys.has(object.key)) throw new Error(`Two objects of the scan share the key ${object.key}.`);
    keys.add(object.key);
  }
  return { id, record, objects, orphanLists, leftOutLists };
}

/** latest.json: the scan a reader should take, and every scan there is, newest first. */
export interface Pointer {
  layout: number;
  /** The newest scan. Its files are under scans/<scan>/. */
  scan: string;
  /** The newest scan's scan.json. */
  record: string;
  scans: string[];
  /**
   * Scans taken back by hand (a bad scan): never current again and not in `scans`, though their files stay.
   * Every upload keeps this list as it found it.
   */
  withdrawn: string[];
  updatedAt: string;
}

/** latest.json as found in the bucket, or null when there is none. Anything else stops the run: it is not overwritten blind. */
export function readPointer(bytes: Buffer | null): Pointer | null {
  if (bytes === null) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${pointerKey} in the bucket is not valid JSON; it was left alone and nothing was uploaded.`); }
  const pointer = value as Partial<Pointer>;
  const ids = (list: unknown) => Array.isArray(list) && list.every((id) => typeof id === "string" && scanIdPattern.test(id));
  if (pointer?.layout !== layoutVersion || typeof pointer.scan !== "string" || !ids(pointer.scans) || !(pointer.withdrawn === undefined || ids(pointer.withdrawn))) {
    throw new Error(`${pointerKey} in the bucket is not a layout ${layoutVersion} pointer; it was left alone and nothing was uploaded.`);
  }
  return { ...pointer, withdrawn: pointer.withdrawn ?? [] } as Pointer;
}

/**
 * The pointer once this scan is in: it moves to the scan only if no newer scan is there already, and the scan is
 * listed either way. A withdrawn scan is never listed or made current again.
 */
export function nextPointer(previous: Pointer | null, id: string, updatedAt: string): Pointer {
  const withdrawn = previous?.withdrawn ?? [];
  if (withdrawn.includes(id)) throw new Error(`Scan ${id} was withdrawn from ${pointerKey}, so it is not published again.`);
  const scans = [...new Set([id, ...(previous?.scans ?? [])])].filter((scan) => !withdrawn.includes(scan)).sort().reverse();
  const scan = scans[0] as string;
  return { layout: layoutVersion, scan, record: scanKey(scan, "scan.json"), scans, withdrawn, updatedAt };
}

export const pointerObject = (pointer: Pointer) => planned(pointerKey, Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`));
