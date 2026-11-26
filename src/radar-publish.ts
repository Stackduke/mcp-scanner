import { createHmac } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrivateDataError, isLayoutKey, nextPointer, pointerKey, pointerObject, readPointer, scanIdOf, sha256, sourceSha256Of } from "./radar-layout.ts";
import type { PlannedObject, Pointer, ScanInput, ScanPlan, ScanSource } from "./radar-layout.ts";
import { signedInServers } from "./signed-in.ts";

/**
 * Puts a planned scan where readers find it: an S3-compatible bucket (Cloudflare R2), or a local folder laid
 * out the same way. The rules are the same for both:
 * - an immutable key already there is left alone when its content has the same sha256, and stops the run
 *   when it differs, so history is never rewritten (R2 enforces this too: each write is create-only);
 * - latest.json is written last, once every other object is in, so a reader never sees a scan half there.
 */
export interface Store {
  /** The content sha256 recorded for the object at the key; "" when it has none; null when there is no object. */
  head(key: string): Promise<string | null>;
  /** Writes the object only if the key is free. False when something was there already. */
  putNew(object: PlannedObject): Promise<boolean>;
  /** Writes the pointer, replacing the one there. */
  putPointer(object: PlannedObject): Promise<void>;
  get(key: string): Promise<Buffer | null>;
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

export async function publish(plan: ScanPlan, store: Store, { concurrency = 8, now = () => new Date() }: { concurrency?: number; now?: () => Date } = {}): Promise<PublishReport> {
  // Read first: a pointer that cannot be read stops the run before anything is written.
  const previous = readPointer(await store.get(pointerKey));
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
  const pointer = nextPointer(previous, plan.id, now().toISOString());
  await store.putPointer(pointerObject(pointer));
  return { written, present, pointer };
}

/** What a run would do, for --dry-run. It reads nothing and writes nothing. */
export function describePlan(plan: ScanPlan): string {
  const lines = [`Scan ${plan.id} (${plan.record.source.kind === "track" ? "a Track run" : `data branch commit ${plan.record.source.commit.slice(0, 12)}`}${plan.record.signed ? ", signed" : ", not signed"}):`];
  const lists = plan.objects.filter((object) => object.key.startsWith("lists/"));
  const evidence = plan.objects.filter((object) => object.key.startsWith("evidence/"));
  for (const object of plan.objects.filter((each) => each.key.startsWith("scans/"))) {
    lines.push(`  ${object.key}  ${object.body.length} bytes, ${object.contentType}, ${object.cacheControl}`);
  }
  const total = (objects: PlannedObject[]) => objects.reduce((sum, object) => sum + object.body.length, 0);
  lines.push(`  lists/<endpoint-id>/<sha256>.json  ${lists.length} new versions, ${total(lists)} bytes; ${plan.record.lists.current} lists in the bundle${plan.orphanLists ? `, ${plan.orphanLists} list files no endpoint names left out` : ""}`);
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

  const put = (object: PlannedObject, onlyIfAbsent: boolean) => send("PUT", object.key, object.body, {
    "content-type": object.contentType, "cache-control": object.cacheControl, [shaHeader]: object.sourceSha256, ...(onlyIfAbsent ? { "if-none-match": "*" } : {}),
  });
  return {
    async head(key) {
      const response = await send("HEAD", key);
      if (response.status === 404) return null;
      if (!response.ok) throw await failed(`HEAD ${key}`, response);
      return response.headers.get(shaHeader) ?? "";
    },
    async putNew(object) {
      const response = await put(object, true);
      if (response.status === 412) return false;
      if (!response.ok) throw await failed(`PUT ${object.key}`, response);
      return true;
    },
    async putPointer(object) {
      const response = await put(object, false);
      if (!response.ok) throw await failed(`PUT ${object.key}`, response);
    },
    async get(key) {
      const response = await send("GET", key);
      if (response.status === 404) return null;
      if (!response.ok) throw await failed(`GET ${key}`, response);
      return Buffer.from(await response.arrayBuffer());
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
    async putPointer(object) {
      const target = file(object.key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(`${target}.partial`, object.body);
      await rename(`${target}.partial`, target);
    },
    get: read,
  };
}

// --- A scan's data folder, checked against its manifest --------------------------------------------------------

/** The data folder's own files that the layout publishes. */
const topNames = new Set(["endpoints.jsonl", "feed.json", "servers.json", "lookup.json", "registry.json"]);
const insideFolder = (relative: string) =>
  relative !== "" && !relative.startsWith("/") && !relative.includes("\\") && relative.split("/").every((part) => part !== "" && part !== "." && part !== "..");

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

/**
 * Reads a scan's data folder (the Track job's output) for publishing. manifest.json must be there, and every file it
 * lists must match its sha256: the manifest is what the sign job signed, so this ties the upload to the signed scan.
 * Every file published must be in the manifest, except the lists the scan did not rewrite, which earlier
 * manifests cover. A manifest naming a file the layout has no place for stops the run.
 */
export async function scanInputFromFolder(folder: string, { requireSignature = false } = {}): Promise<ScanInput> {
  const manifestBytes = await readFile(path.join(folder, "manifest.json")).catch(() => { throw new Error(`There is no manifest.json in ${folder}: a scan is published only with its manifest.`); });
  const manifest = (() => { try { return JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>; } catch { throw new Error("manifest.json is not valid JSON."); } })();
  const files = manifest.files;
  if (manifest.version !== 1 || typeof manifest.scanStartedAt !== "string" || !Array.isArray(files)) throw new Error("manifest.json is not a version 1 scan manifest.");
  const signature = await readFile(path.join(folder, "manifest.sigstore.json")).catch(() => undefined);
  if (requireSignature && !signature) throw new Error("There is no manifest.sigstore.json, and a signature was required.");

  const top = new Map<string, Buffer>();
  const newLists = new Set<string>();
  const evidence = new Map<string, Buffer>();
  for (const entry of files as unknown[]) {
    const { path: relative, sha256: hash, bytes: size } = (entry ?? {}) as Record<string, unknown>;
    if (typeof relative !== "string" || !insideFolder(relative) || typeof hash !== "string" || typeof size !== "number") throw new Error("manifest.json lists a file with no usable path, sha256 or size.");
    const bytes = await readFile(path.join(folder, relative)).catch(() => { throw new Error(`${relative} is in manifest.json but not in the folder.`); });
    if (sha256(bytes) !== hash || bytes.length !== size) throw new Error(`${relative} does not match its sha256 in manifest.json; nothing was planned.`);
    if (topNames.has(relative)) top.set(relative, bytes);
    else if (relative.startsWith("lists/")) newLists.add(relative);
    else if (relative.startsWith("evidence/")) evidence.set(relative, bytes);
    else if (relative.startsWith("watched/")) {
      const vendor = relative.slice("watched/".length).replace(/\.json$/, "");
      if (signedInServers[vendor]?.publish !== true) throw new PrivateDataError("Refused: manifest.json lists a watched/ file of a server tracked privately. Nothing from such a server may reach the public bucket, so nothing was planned.");
      throw new Error(`${relative} has no place in the layout.`);
    } else throw new Error(`${relative} has no place in the layout; add one before publishing it.`);
  }
  for (const name of topNames) {
    const there = await readFile(path.join(folder, name)).then(() => true, () => false);
    if (there && !top.has(name)) throw new Error(`${name} is in the folder but not in manifest.json, so it is not the file this scan wrote.`);
  }
  const lists = new Map<string, Buffer>();
  for (const relative of await filesUnder(folder, "lists")) lists.set(relative, await readFile(path.join(folder, relative)));

  const run = manifest.run as { id?: unknown; attempt?: unknown; repository?: unknown } | undefined;
  const source: ScanSource = {
    kind: "track",
    scanStartedAt: manifest.scanStartedAt,
    scannerCommit: typeof (manifest.scanner as { commit?: unknown } | undefined)?.commit === "string" ? (manifest.scanner as { commit: string }).commit : "unknown",
    ...(typeof manifest.methodVersion === "string" ? { methodVersion: manifest.methodVersion } : {}),
    ...(run && typeof run.id === "string" ? { run: { id: run.id, attempt: String(run.attempt ?? "1"), repository: String(run.repository ?? "") } } : {}),
  };
  return { id: scanIdOf(manifest.scanStartedAt), source, files: top, lists, newLists, evidence, manifest: manifestBytes, ...(signature ? { signature } : {}) };
}
