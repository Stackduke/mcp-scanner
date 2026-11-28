import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { folderDigest, insideFolder, manifestName, readManifest, signatureName } from "./manifest.ts";
import { isLayoutKey, layoutVersion, listVerdict, readPointer, scanKey, sha256, snapshotKey } from "./radar-layout.ts";
import type { ScanRecord } from "./radar-layout.ts";
import { encodeKey } from "./radar-publish.ts";
import { dataAttributes } from "./track.ts";

/**
 * Rebuilds the tracker's data folder from the latest scan in the bucket, with no key: what the Track job will
 * start from once it no longer reads the data branch (docs/decisions/0001-radar-storage-r2.md, "Restoring the
 * data folder"). Everything is downloaded and checked against the scan's scan.json (each file's sha256 and
 * size) and each list against its own sha256 before anything is written, so a folder is written only from
 * files that are exactly the scan's. A list on a kept-off site, or whose address cannot be read, is skipped.
 */
export interface RestoreReport {
  scan: string;
  /** The data folder's own files written: endpoints.jsonl, the top files, the manifest and its signature. */
  files: number;
  lists: number;
  /** Lists left out: on a kept-off site, or with an address that cannot be read. Counted, never named. */
  skipped: number;
  /** Whether the folder digests to the scan's manifest `tree`; null when the scan has no manifest. */
  matchesManifest: boolean | null;
}

/** The data folder's name for each of a scan's files in the bucket. */
const folderNames: Record<string, string> = {
  "endpoints.jsonl.gz": "endpoints.jsonl",
  "feed.json": "feed.json",
  "servers.json": "servers.json",
  "lookup.json": "lookup.json",
  "registry.json": "registry.json",
  "hosts.json": "hosts.json",
};

/** One line of lists.jsonl.gz: its fields, and the raw text of its list exactly as it stands in the line. */
export function readBundleLine(line: string, number: number): { id: string; path: string; sha256: string; text: string } {
  const where = `lists.jsonl.gz line ${number}`;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error(`${where} is not valid JSON.`); }
  const { id, path: listPath, sha256: hash } = (parsed ?? {}) as { id?: unknown; path?: unknown; sha256?: unknown };
  if (typeof id !== "string" || typeof listPath !== "string" || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${where} is not a list line of layout ${layoutVersion}.`);
  // The planner writes every line the same way, with `list` last (radar-layout.ts): its text is what follows the
  // prefix, but the closing brace. It is taken as it is, not parsed and written out again, which could change it.
  const prefix = `{"id":${JSON.stringify(id)},"path":${JSON.stringify(listPath)},"sha256":"${hash}","list":`;
  if (!line.startsWith(prefix) || !line.endsWith("}")) throw new Error(`${where} is not a list line of layout ${layoutVersion}.`);
  return { id, path: listPath, sha256: hash, text: line.slice(prefix.length, -1) };
}

export interface RestoreOptions {
  fetchImpl?: typeof fetch;
}

export async function restore(from: string, to: string, { fetchImpl = fetch }: RestoreOptions = {}): Promise<RestoreReport> {
  const base = new URL(from);
  if (!(base.protocol === "https:" || (base.protocol === "http:" && base.hostname === "127.0.0.1")) || base.pathname !== "/" || base.search || base.username) throw new Error("--from must be an https origin, such as https://data.stackduke.com.");
  // Never mixed with files already there: the folder must be new, or empty.
  const existing = await readdir(to).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  if (existing.length) throw new Error(`${to} is not empty; restore writes only into a new or empty folder.`);

  const get = async (key: string): Promise<Buffer | null> => {
    if (!isLayoutKey(key)) throw new Error(`Not a key of the layout: ${key}`);
    const response = await fetchImpl(new URL(encodeKey(key), base), { signal: AbortSignal.timeout(300_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GET ${key} answered ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
  };
  const must = async (key: string) => (await get(key)) ?? (() => { throw new Error(`${key} is not in the bucket.`); })();

  const pointer = readPointer(await get("latest.json"));
  if (!pointer) throw new Error("There is no latest.json: the bucket holds no scan to restore.");
  let record: ScanRecord;
  try { record = JSON.parse((await must(pointer.record)).toString("utf8")) as ScanRecord; } catch (error) { throw error instanceof SyntaxError ? new Error(`${pointer.record} is not valid JSON.`) : error; }
  if (record?.layout !== layoutVersion || record.id !== pointer.scan || pointer.record !== scanKey(record.id, "scan.json") || !Array.isArray(record.files)) throw new Error(`${pointer.record} is not the layout ${layoutVersion} record of scan ${pointer.scan}.`);
  // Evidence is kept by content hash, not by its path in the folder, so it cannot be put back yet.
  if (Array.isArray(record.evidence) && record.evidence.length) throw new Error(`Scan ${record.id} has evidence, which restore cannot put back in the folder yet.`);

  // Every file downloaded and checked first; nothing is written unless all of it is the scan's.
  const contents = new Map<string, Buffer>();
  let bundle: Buffer | null = null;
  /** Where a scan's file goes in the folder: its name there, "" for the list bundle, null when it has no place. */
  const placeOf = (key: unknown): string | null => {
    for (const name of [manifestName, signatureName]) if (key === scanKey(record.id, name)) return name;
    if (key === snapshotKey(record.id, "lists.jsonl.gz")) return "";
    for (const [name, folderName] of Object.entries(folderNames)) if (key === snapshotKey(record.id, name)) return folderName;
    return null;
  };
  for (const file of record.files) {
    const folderName = placeOf(file?.key);
    if (folderName === null) throw new Error(`${pointer.record} names a file restore has no place for.`);
    const key = file.key;
    const body = await must(key);
    let content: Buffer;
    try { content = key.endsWith(".gz") ? gunzipSync(body) : body; } catch { throw new Error(`${key} is not gzip.`); }
    if (sha256(content) !== file.sha256 || content.length !== file.bytes) throw new Error(`${key} does not match its sha256 in ${pointer.record}.`);
    if (folderName === "") bundle = content;
    else contents.set(folderName, content);
  }
  if (!contents.has("endpoints.jsonl") || bundle === null) throw new Error(`Scan ${record.id} has no endpoints.jsonl.gz or lists.jsonl.gz.`);

  const lists = new Map<string, string>();
  let skipped = 0;
  bundle.toString("utf8").split("\n").forEach((line, index) => {
    if (!line) return;
    const { path: listPath, sha256: hash, text } = readBundleLine(line, index + 1);
    if (!/^lists\/[^/]+\/[^/]+\.json$/.test(listPath) || !insideFolder(listPath) || lists.has(listPath)) throw new Error(`lists.jsonl.gz line ${index + 1} has a path restore does not take.`);
    const bytes = `${text}\n`;
    if (sha256(bytes) !== hash) throw new Error(`lists.jsonl.gz line ${index + 1} does not match its sha256.`);
    // As the tracker sweeps them and the uploader refuses them: a vendor kept off since this scan stays off.
    if (listVerdict(listPath, bytes) !== "public") { skipped += 1; return; }
    lists.set(listPath, bytes);
  });

  await mkdir(to, { recursive: true });
  const write = async (relative: string, bytes: Buffer | string) => {
    await mkdir(path.dirname(path.join(to, relative)), { recursive: true });
    await writeFile(path.join(to, relative), bytes, { flag: "wx" });
  };
  for (const [name, bytes] of contents) await write(name, bytes);
  for (const [listPath, bytes] of lists) await write(listPath, bytes);
  // The scanner's own constant, the same in every scan, so the bucket keeps no copy.
  await write(".gitattributes", dataAttributes);

  const manifestBytes = contents.get(manifestName);
  const manifest = manifestBytes ? readManifest((() => { try { return JSON.parse(manifestBytes.toString("utf8")) as unknown; } catch { return null; } })()) : null;
  const matchesManifest = manifest && typeof manifest !== "string" ? (await folderDigest(to)).sha256 === manifest.tree.sha256 : null;
  return { scan: record.id, files: contents.size, lists: lists.size, skipped, matchesManifest };
}
