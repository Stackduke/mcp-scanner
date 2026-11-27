import { createHmac } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { manifestName, readManifest, signatureName, verifyManifest } from "./manifest.ts";
import type { RunCosign } from "./manifest.ts";
import { PrivateDataError, isLayoutKey, nextPointer, pointerKey, pointerObject, readPointer, scanIdOf, sha256, sourceSha256Of } from "./radar-layout.ts";
import type { PlannedObject, Pointer, ScanInput, ScanPlan, ScanSource } from "./radar-layout.ts";

/**
 * Puts a planned scan where readers find it: an S3-compatible bucket (Cloudflare R2), or a local folder laid
 * out the same way. The rules are the same for both:
 * - an immutable key already there is left alone when its content has the same sha256, and stops the run
 *   when it differs, so history is never rewritten (R2 enforces this too: each write is create-only);
 * - latest.json is written last, once every other object is in, so a reader never sees a scan half there;
 * - latest.json is replaced only if it is still the version just read (its ETag), so two runs that overlap
 *   cannot move it back or drop each other's scan: the one that loses reads it again and retries.
 */
export interface Store {
  /** The content sha256 recorded for the object at the key; "" when it has none; null when there is no object. */
  head(key: string): Promise<string | null>;
  /** Writes the object only if the key is free. False when something was there already. */
  putNew(object: PlannedObject): Promise<boolean>;
  /** latest.json and its version (ETag), or null when there is none. */
  getPointer(): Promise<{ body: Buffer; etag: string } | null>;
  /**
   * Writes latest.json only if it is still the version read: the one with that ETag, or none at all when
   * `expected` is null. False when it changed in between.
   */
  putPointer(object: PlannedObject, expected: string | null): Promise<boolean>;
}

export interface PublishReport {
  written: number;
  /** Already there with the same content. */
  present: number;
  pointer: Pointer;
}

/** Runs the work a few items at a time; after a failure no new item starts, and the first failure is thrown. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++] as T;
      try { await work(item); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
}

/** How many times latest.json is read again and rewritten when other runs keep changing it. */
const pointerAttempts = 5;

export async function publish(plan: ScanPlan, store: Store, { concurrency = 8, now = () => new Date() }: { concurrency?: number; now?: () => Date } = {}): Promise<PublishReport> {
  // Read first: a pointer that cannot be read, or that withdrew this scan, stops the run before anything is written.
  if (readPointer((await store.getPointer())?.body ?? null)?.withdrawn.includes(plan.id)) throw new Error(`Scan ${plan.id} was withdrawn from ${pointerKey}, so it is not published again.`);
  let written = 0, present = 0;
  const conflict = (key: string) => new Error(`${key} is already in the bucket with different content. Objects there are never overwritten, so this run stopped: latest.json was not moved.`);
  await eachLimited(plan.objects, concurrency, async (object) => {
    let found = await store.head(object.key);
    if (found === null) {
      if (await store.putNew(object)) { written += 1; return; }
      // Someone wrote the key between the look and the write: compare with what they wrote.
      found = await store.head(object.key);
    }
    if (found !== object.sourceSha256) throw conflict(object.key);
    present += 1;
  });
  // Read again just before writing: another run may have moved it while the objects went up.
  for (let attempt = 1; attempt <= pointerAttempts; attempt += 1) {
    const current = await store.getPointer();
    const pointer = nextPointer(readPointer(current?.body ?? null), plan.id, now().toISOString());
    if (await store.putPointer(pointerObject(pointer), current?.etag ?? null)) return { written, present, pointer };
  }
  throw new Error(`${pointerKey} changed under this run ${pointerAttempts} times in a row, so it was left as the other runs wrote it. Every object of scan ${plan.id} is in place; run again to list it.`);
}

/** What a run would do, for --dry-run. It reads nothing and writes nothing. */
export function describePlan(plan: ScanPlan): string {
  const lines = [`Scan ${plan.id} (${plan.record.source.kind === "track" ? "a Track run" : `data branch commit ${plan.record.source.commit.slice(0, 12)}`}${plan.record.signed ? ", signed" : ", not signed"}):`];
  const lists = plan.objects.filter((object) => object.key.startsWith("lists/"));
  const evidence = plan.objects.filter((object) => object.key.startsWith("evidence/"));
  for (const object of plan.objects.filter((each) => each.key.startsWith("scans/") || each.key.startsWith("snapshots/"))) {
    lines.push(`  ${object.key}  ${object.body.length} bytes, ${object.contentType}, ${object.cacheControl}`);
  }
  const total = (objects: PlannedObject[]) => objects.reduce((sum, object) => sum + object.body.length, 0);
  lines.push(`  lists/<endpoint-id>/<sha256>.json  ${lists.length} new versions, ${total(lists)} bytes; ${plan.record.lists.current} lists in the bundle${plan.orphanLists ? `, ${plan.orphanLists} of them named by no endpoint` : ""}${plan.leftOutLists ? `; ${plan.leftOutLists} list files with no endpoint id left out` : ""}`);
  if (evidence.length) lines.push(`  evidence/<endpoint-id>/<sha256>.json  ${evidence.length} objects, ${total(evidence)} bytes`);
  lines.push(`  ${pointerKey}  last, pointing at ${plan.id} unless the bucket already holds a newer scan`);
  lines.push(`  ${plan.objects.length + 1} objects, ${total(plan.objects)} bytes. Each immutable key is written only if absent; one present with other content stops the run.`);
  return lines.join("\n");
}

// --- S3 (Cloudflare R2) ---------------------------------------------------------------------------------------

const hmac = (key: Buffer | string, text: string) => createHmac("sha256", key).update(text).digest();
const encodeSegment = (segment: string) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** A key as it goes in a URL path: each segment percent-encoded the way SigV4 expects. */
export const encodeKey = (key: string) => key.split("/").map(encodeSegment).join("/");

export interface Credentials { accessKeyId: string; secretAccessKey: string }

/**
 * Signs a request with AWS Signature Version 4, the scheme R2's S3 API takes. The URL's path must already be
 * encoded (encodeKey). Returns the headers to send: those given, x-amz-date, x-amz-content-sha256 and
 * authorization. Host is signed but not returned: fetch sets it from the URL.
 */
export function signV4({ method, url, headers, payloadHash, credentials, region, service, date }: {
  method: string; url: URL; headers: Record<string, string>; payloadHash: string; credentials: Credentials; region: string; service: string; date: Date;
}): Record<string, string> {
  const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const day = amzDate.slice(0, 8);
  const signed: Record<string, string> = { host: url.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  for (const [name, value] of Object.entries(headers)) signed[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  const names = Object.keys(signed).sort();
  const query = [...url.searchParams].map(([name, value]) => `${encodeSegment(name)}=${encodeSegment(value)}`).sort().join("&");
  const canonical = [method, url.pathname, query, names.map((name) => `${name}:${signed[name]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _host, ...sent } = signed;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/** The metadata header that holds an object's content sha256. */
const shaHeader = "x-amz-meta-source-sha256";

export interface S3Options {
  /** https://<account id>.r2.cloudflarestorage.com, or a local test server on 127.0.0.1. */
  endpoint: string;
  bucket: string;
  credentials: Credentials;
  region?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function s3Store({ endpoint, bucket, credentials, region = "auto", fetchImpl = fetch, now = () => new Date() }: S3Options): Store {
  const base = new URL(endpoint);
  if (!(base.protocol === "https:" || (base.protocol === "http:" && base.hostname === "127.0.0.1")) || base.pathname !== "/" || base.search) throw new Error("The endpoint must be an https origin, such as https://<account id>.r2.cloudflarestorage.com.");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error(`Not a bucket name: ${bucket}`);
  if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error("No credentials for the bucket.");

  async function send(method: string, key: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Response> {
    if (!isLayoutKey(key)) throw new Error(`Not a key of the layout: ${key}`);
    const url = new URL(`/${bucket}/${encodeKey(key)}`, base);
    const payload = body ?? Buffer.alloc(0);
    const signedHeaders = signV4({ method, url, headers, payloadHash: sha256(payload), credentials, region, service: "s3", date: now() });
    return fetchImpl(url, { method, headers: signedHeaders, ...(body ? { body: new Uint8Array(body) } : {}), signal: AbortSignal.timeout(120_000) });
  }
  // The answer's text may be an error from the store; only its first line, cut short, reaches the log.
  const failed = async (what: string, response: Response) => new Error(`${what} answered ${response.status}: ${(await response.text().catch(() => "")).replace(/[^\x20-\x7e]+/g, " ").slice(0, 200)}`);

  const put = (object: PlannedObject, condition: Record<string, string>) => send("PUT", object.key, object.body, {
    "content-type": object.contentType, "cache-control": object.cacheControl, [shaHeader]: object.sourceSha256, ...condition,
  });
  return {
    async head(key) {
      const response = await send("HEAD", key);
      if (response.status === 404) return null;
      if (!response.ok) throw await failed(`HEAD ${key}`, response);
      return response.headers.get(shaHeader) ?? "";
    },
    async putNew(object) {
      const response = await put(object, { "if-none-match": "*" });
      if (response.status === 412) return false;
      // Under a bucket lock R2 checks the lock first, so a key already there answers 409 ObjectLockedByBucketPolicy.
      if (response.status === 409) {
        const text = await response.text().catch(() => "");
        if (text.includes("ObjectLockedByBucketPolicy")) return false;
        throw new Error(`PUT ${object.key} answered 409: ${text.replace(/[^\x20-\x7e]+/g, " ").slice(0, 200)}`);
      }
      if (!response.ok) throw await failed(`PUT ${object.key}`, response);
      return true;
    },
    async getPointer() {
      // fetch asks for gzip unless told otherwise, and Cloudflare makes the ETag of a compressed answer weak (W/"…").
      // If-Match compares ETags strongly, so a weak one never matches: ask for the bytes as stored.
      const response = await send("GET", pointerKey, undefined, { "accept-encoding": "identity" });
      if (response.status === 404) return null;
      if (!response.ok) throw await failed(`GET ${pointerKey}`, response);
      const etag = response.headers.get("etag");
      if (!etag) throw new Error(`GET ${pointerKey} answered without an ETag, so it cannot be replaced safely.`);
      if (etag.startsWith("W/")) throw new Error(`GET ${pointerKey} answered a weak ETag (${etag.slice(0, 100)}), so it cannot be replaced safely.`);
      return { body: Buffer.from(await response.arrayBuffer()), etag };
    },
    async putPointer(object, expected) {
      // A conditional PUT is checked and applied in one step by the store: only one of two racing writes wins.
      const response = await put(object, expected === null ? { "if-none-match": "*" } : { "if-match": expected });
      if (response.status === 412) return false;
      if (!response.ok) throw await failed(`PUT ${object.key}`, response);
      return true;
    },
  };
}

// --- A local folder, keys as paths -----------------------------------------------------------------------------

export function folderStore(folder: string): Store {
  const file = (key: string) => {
    if (!isLayoutKey(key)) throw new Error(`Not a key of the layout: ${key}`);
    return path.join(folder, ...key.split("/"));
  };
  const read = (key: string) => readFile(file(key)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  return {
    async head(key) {
      const bytes = await read(key);
      return bytes === null ? null : sourceSha256Of(key, bytes);
    },
    async putNew(object) {
      const target = file(object.key);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.partial`;
      await writeFile(temporary, object.body);
      // A hard link is created only if the name is free, so an object is never replaced, even by a run alongside.
      try { await link(temporary, target); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
      finally { await unlink(temporary).catch(() => undefined); }
    },
    async getPointer() {
      const body = await read(pointerKey);
      return body === null ? null : { body, etag: sha256(body) };
    },
    // The same check as a bucket's, but not atomic: a folder is for one run at a time (tests, local builds).
    async putPointer(object, expected) {
      const target = file(object.key);
      const body = await read(pointerKey);
      if ((body === null ? null : sha256(body)) !== expected) return false;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(`${target}.partial`, object.body);
      await rename(`${target}.partial`, target);
      return true;
    },
  };
}

// --- A scan's data folder, checked against its manifest --------------------------------------------------------

/** The data folder's own files that the layout publishes. */
const topNames = new Set(["endpoints.jsonl", "feed.json", "servers.json", "lookup.json", "registry.json", "hosts.json"]);
/**
 * Files in a scan's folder that are not data: checked against the manifest like the rest, never published.
 * .gitattributes is the scanner's own constant (track.ts, dataAttributes); README.md is the data branch's.
 */
const notPublished = new Set([".gitattributes", "README.md"]);

async function filesUnder(folder: string, relative: string): Promise<string[]> {
  const entries = await readdir(path.join(folder, relative), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const found: string[] = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(folder, child)));
    else if (entry.isFile() && entry.name.endsWith(".json")) found.push(child);
  }
  return found;
}

export interface FolderOptions {
  /** Check manifest.sigstore.json with cosign: signed by the repository's Track workflow, at the scanner commit the manifest names. */
  requireSignature?: boolean;
  /** The repository whose Track workflow must have signed it. Default Stackduke/mcp-scanner. */
  repository?: string;
  /** For tests: what runs cosign. */
  cosign?: RunCosign;
}

/**
 * Reads a scan's data folder (the Track job's output) for publishing, checked with the scanner's own manifest
 * check (manifest.ts): the whole folder must match the manifest's digest of it and every file the manifest
 * lists must match its sha256, so every file published, the lists the scan did not rewrite included, is the
 * folder that scan left. With requireSignature, the signature must verify too. A manifest naming a file the
 * layout has no place for stops the run, and one naming a file of a server tracked privately is refused
 * before anything about it can reach a log.
 */
export async function scanInputFromFolder(folder: string, { requireSignature = false, repository, cosign }: FolderOptions = {}): Promise<ScanInput> {
  const manifestBytes = await readFile(path.join(folder, manifestName)).catch(() => { throw new Error(`There is no ${manifestName} in ${folder}: a scan is published only with its manifest.`); });
  let parsed: unknown;
  try { parsed = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new Error(`${manifestName} is not valid JSON.`); }
  const manifest = readManifest(parsed);
  if (typeof manifest === "string") throw new Error(`${manifestName} cannot be used: ${manifest}.`);
  if (Number.isNaN(Date.parse(manifest.scanStartedAt))) throw new Error(`${manifestName} has no usable start time.`);

  // Where each file goes, decided before any check whose message could name a path.
  const top = new Set<string>(), newLists = new Set<string>(), evidencePaths = new Set<string>();
  for (const { path: relative } of manifest.files) {
    if (topNames.has(relative)) top.add(relative);
    else if (relative.startsWith("lists/")) newLists.add(relative);
    else if (relative.startsWith("evidence/")) evidencePaths.add(relative);
    else if (notPublished.has(relative)) continue;
    // Layout 1 has no place for a server watched with a sign-in, so its definitions are treated as private.
    else if (relative.startsWith("watched/")) throw new PrivateDataError("Refused: manifest.json lists a watched/ file of a server watched with a sign-in. Layout 1 publishes nothing about such a server, so nothing was planned.");
    else throw new Error(`${relative} has no place in the layout; add one before publishing it.`);
  }

  const check = await verifyManifest(folder, { hashesOnly: !requireSignature, thisScanOnly: true, ...(repository ? { repository } : {}), ...(cosign ? { cosign } : {}) });
  if (!check.ok) {
    // A path outside the manifest (a file that is not a plain one) is counted, not named.
    const shown = check.problems.filter((problem) => !/not a plain file$/.test(problem));
    throw new Error(`The folder does not match its signed scan, so nothing was planned: ${[...shown, ...(shown.length < check.problems.length ? [`${check.problems.length - shown.length} entries that are not plain files`] : [])].join("; ")}`);
  }
  const signature = await readFile(path.join(folder, signatureName)).catch(() => undefined);

  // Read again for planning, and held to the manifest once more: what is uploaded is what was checked, even if
  // something wrote to the folder after the check.
  const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  const read = async (relative: string) => {
    const bytes = await readFile(path.join(folder, relative));
    const want = relative === manifestName ? sha256(manifestBytes) : expected.get(relative);
    if (want !== undefined && sha256(bytes) !== want) throw new Error(`${relative} changed after the folder was checked, so nothing was planned.`);
    return bytes;
  };
  await read(manifestName);
  const files = new Map<string, Buffer>();
  for (const name of topNames) {
    const bytes = await read(name).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (bytes) files.set(name, bytes);
  }
  const evidence = new Map<string, Buffer>();
  for (const relative of evidencePaths) evidence.set(relative, await read(relative));
  const lists = new Map<string, Buffer>();
  for (const relative of await filesUnder(folder, "lists")) lists.set(relative, await read(relative));

  const source: ScanSource = {
    kind: "track",
    scanStartedAt: manifest.scanStartedAt,
    scannerCommit: manifest.scanner.commit,
    methodVersion: manifest.methodVersion,
    ...(manifest.run ? { run: manifest.run } : {}),
  };
  return { id: scanIdOf(manifest.scanStartedAt), source, files, lists, newLists, evidence, manifest: manifestBytes, ...(signature ? { signature } : {}) };
}
