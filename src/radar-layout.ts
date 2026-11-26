import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { signedInServers } from "./signed-in.ts";

/**
 * Where Radar's history lives in object storage (the `radar` bucket, served at https://data.stackduke.com), and
 * what one scan becomes there. docs/data-layout.md is the contract for readers; this file is its code.
 *
 *   latest.json                              the one mutable object, written last: which scan is current
 *   scans/<scan-id>/scan.json                what the scan is, and the sha256 of each of its files
 *   scans/<scan-id>/endpoints.jsonl.gz       every endpoint as the scan left it
 *   scans/<scan-id>/lists.jsonl.gz           every current tool list, one per line
 *   scans/<scan-id>/{feed,servers,lookup,registry}.json
 *   scans/<scan-id>/manifest.json            the scan's manifest and, when signed, manifest.sigstore.json
 *   lists/<endpoint-id>/<sha256>.json        each version of an endpoint's tool list, by the sha256 of its bytes
 *   evidence/<endpoint-id>/<sha256>.json     reserved for raw responses, the same way
 *
 * Every key but latest.json is immutable: written once, never overwritten. Nothing about a server tracked
 * privately is ever planned: a scan that holds any is refused whole.
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

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

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
export const listKey = (endpointId: string, hash: string) => `lists/${endpointId}/${hash}.json`;
export const evidenceKey = (endpointId: string, hash: string) => `evidence/${endpointId}/${hash}.json`;

/** The files of a scan's folder, under scans/<scan-id>/. */
export const scanFiles = ["scan.json", "endpoints.jsonl.gz", "lists.jsonl.gz", "feed.json", "servers.json", "lookup.json", "registry.json", "manifest.json", "manifest.sigstore.json"] as const;
const keyPattern = new RegExp(`^(latest\\.json|scans/\\d{4}-\\d{2}-\\d{2}T\\d{6}Z/(${scanFiles.map((name) => name.replace(/\./g, "\\.")).join("|")})|(lists|evidence)/[0-9a-f]{12}/[0-9a-f]{64}\\.json)$`);
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

/** The vendors whose signed-in data is published. Every other signed-in vendor is tracked privately. */
export const publishedVendors = (servers = signedInServers) => new Set(Object.entries(servers).filter(([, server]) => server.publish === true).map(([vendor]) => vendor));

/**
 * Whether a record (an endpoint, a feed entry, a servers row) is about a server tracked privately. Only fields the
 * scanner writes itself are read (`signedIn`, and an id of the form signed-in-<vendor>); a server's own text never
 * decides it, so no server can block an upload by naming a tool after a vendor.
 */
export function isPrivateRecord(record: unknown, published: ReadonlySet<string>): boolean {
  if (typeof record !== "object" || record === null) return false;
  const { id, signedIn } = record as { id?: unknown; signedIn?: unknown };
  if (signedIn !== undefined && !(typeof signedIn === "string" && published.has(signedIn))) return true;
  return typeof id === "string" && id.startsWith("signed-in-") && !published.has(id.slice("signed-in-".length));
}

export type ScanSource =
  | { kind: "track"; scanStartedAt: string; scannerCommit: string; methodVersion?: string; run?: { id: string; attempt: string; repository: string } }
  | { kind: "data-branch"; commit: string; committedAt: string };

/** One scan's files, wherever they came from: a scan's data folder, or a commit of the data branch. */
export interface ScanInput {
  id: string;
  source: ScanSource;
  /** The data folder's own files by name: endpoints.jsonl (required), feed.json, servers.json, lookup.json, registry.json. */
  files: Map<string, Buffer>;
  /** Every tool list in the folder, by its path there (lists/ab/<host>-<id>.json). */
  lists: Map<string, Buffer>;
  /** The lists this scan wrote: each becomes a lists/<endpoint-id>/<sha256>.json object. */
  newLists: ReadonlySet<string>;
  /** Raw responses this scan wrote, by path (evidence/<endpoint-id>/<name>.json). */
  evidence?: Map<string, Buffer>;
  manifest?: Buffer;
  signature?: Buffer;
  /** For tests: the vendors published. Default from the catalog. */
  published?: ReadonlySet<string>;
}

export interface ScanRecord {
  layout: number;
  id: string;
  source: ScanSource;
  /** Whether manifest.sigstore.json is among the files. */
  signed: boolean;
  /** Every file under scans/<id>/ but this one, with the sha256 and size of its content (before compression for .gz). */
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
  /** List files no endpoint names, left out. */
  orphanLists: number;
}

const topFiles = ["feed.json", "servers.json", "lookup.json", "registry.json"] as const;

function parseJson(name: string, bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${name} is not valid JSON.`); }
}

const refused = (where: string) => new PrivateDataError(`Refused: ${where} holds data about a server tracked privately. Nothing from such a server may reach the public bucket, so nothing was planned.`);

/** Builds everything one scan becomes in the bucket, or throws before anything is written. */
export function planScan(input: ScanInput): ScanPlan {
  const { id, source } = input;
  if (!scanIdPattern.test(id)) throw new Error(`Not a scan id: ${id}`);
  const published = input.published ?? publishedVendors();

  const endpointsText = input.files.get("endpoints.jsonl");
  if (!endpointsText) throw new Error("The scan has no endpoints.jsonl.");
  /** Each public endpoint's list file, to the endpoint's id. */
  const listOwner = new Map<string, string>();
  const endpointIds = new Set<string>();
  endpointsText.toString("utf8").split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const record = parseJson(`endpoints.jsonl line ${index + 1}`, Buffer.from(line));
    if (isPrivateRecord(record, published)) throw refused(`endpoints.jsonl line ${index + 1}`);
    const { id: endpointId, file } = (record ?? {}) as { id?: unknown; file?: unknown };
    if (typeof endpointId !== "string") throw new Error(`endpoints.jsonl line ${index + 1} has no id.`);
    endpointIds.add(endpointId);
    if (typeof file === "string") listOwner.set(file, endpointId);
  });

  const feed = input.files.get("feed.json");
  if (feed) {
    const parsed = parseJson("feed.json", feed) as { watched?: unknown; changes?: unknown };
    for (const field of ["watched", "changes"] as const) {
      const entries = parsed?.[field];
      if (Array.isArray(entries) && entries.some((entry) => isPrivateRecord(entry, published))) throw refused(`feed.json (${field})`);
    }
  }
  const servers = input.files.get("servers.json");
  if (servers) {
    const rows = parseJson("servers.json", servers);
    if (Array.isArray(rows) && rows.some((row) => isPrivateRecord(row, published))) throw refused("servers.json");
  }

  // Every current list, in one file a reader can take whole, and each version first seen here on its own.
  const bundle: string[] = [];
  const objects: PlannedObject[] = [];
  const written: string[] = [];
  let orphanLists = 0;
  for (const [listPath, bytes] of [...input.lists].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const owner = listOwner.get(listPath);
    if (owner === undefined) {
      if (listPath.includes("signed-in-")) throw refused(listPath.slice(0, listPath.lastIndexOf("/") + 1));
      if (input.newLists.has(listPath)) throw new Error(`${listPath} was written by the scan, but no endpoint names it.`);
      orphanLists += 1;
      continue;
    }
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
    planned(scanKey(id, "endpoints.jsonl.gz"), endpointsText),
    planned(scanKey(id, "lists.jsonl.gz"), Buffer.from(bundle.length ? `${bundle.join("\n")}\n` : "")),
    ...topFiles.flatMap((name) => { const bytes = input.files.get(name); return bytes ? [planned(scanKey(id, name), bytes)] : []; }),
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
  return { id, record, objects, orphanLists };
}

/** latest.json: the scan a reader should take, and every scan there is, newest first. */
export interface Pointer {
  layout: number;
  /** The newest scan. Its files are under scans/<scan>/. */
  scan: string;
  /** The newest scan's scan.json. */
  record: string;
  scans: string[];
  updatedAt: string;
}

/** latest.json as found in the bucket, or null when there is none. Anything else stops the run: it is not overwritten blind. */
export function readPointer(bytes: Buffer | null): Pointer | null {
  if (bytes === null) return null;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${pointerKey} in the bucket is not valid JSON; it was left alone and nothing was uploaded.`); }
  const pointer = value as Partial<Pointer>;
  if (pointer?.layout !== layoutVersion || typeof pointer.scan !== "string" || !Array.isArray(pointer.scans) || !pointer.scans.every((id) => typeof id === "string" && scanIdPattern.test(id))) {
    throw new Error(`${pointerKey} in the bucket is not a layout ${layoutVersion} pointer; it was left alone and nothing was uploaded.`);
  }
  return pointer as Pointer;
}

/** The pointer once this scan is in: it moves to the scan only if no newer scan is there already, and the scan is listed either way. */
export function nextPointer(previous: Pointer | null, id: string, updatedAt: string): Pointer {
  const scans = [...new Set([id, ...(previous?.scans ?? [])])].sort().reverse();
  const scan = scans[0] as string;
  return { layout: layoutVersion, scan, record: scanKey(scan, "scan.json"), scans, updatedAt };
}

export const pointerObject = (pointer: Pointer) => planned(pointerKey, Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`));
