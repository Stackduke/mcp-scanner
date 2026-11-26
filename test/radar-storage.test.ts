import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { radarMain } from "../src/radar-cli.ts";
import { PrivateDataError, isLayoutKey, isPrivateRecord, listKey, nextPointer, planScan, publishedVendors, scanIdOf } from "../src/radar-layout.ts";
import { encodeKey, folderStore, publish, s3Store, scanInputFromFolder, signV4 } from "../src/radar-publish.ts";
import type { Store } from "../src/radar-publish.ts";
import { endpointId } from "../src/tracker.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const temporary: string[] = [];
after(async () => { for (const folder of temporary) await rm(folder, { recursive: true, force: true }); });
async function folder(): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), "radar-"));
  temporary.push(made);
  return made;
}

const urlA = "https://a.example.com/mcp";
const idA = endpointId(urlA);
const listA = `lists/${idA.slice(0, 2)}/a.example.com-${idA}.json`;
const started = "2026-11-25T14:29:08.123Z";
const scanId = "2026-11-25T142908Z";
/** A clock just after the scan, for the CLI: it refuses scans dated in the future or over a week ago. */
const soon = () => new Date("2026-11-25T15:00:00Z");

interface ScanOptions {
  extraEndpoints?: object[];
  feed?: object;
  servers?: object[];
  manifestExtra?: Record<string, string>;
  listText?: string;
}

/** A scan's data folder as the Track job leaves it: its files, and a manifest of those it wrote. */
async function writeScan(dir: string, options: ScanOptions = {}): Promise<void> {
  const files: Record<string, string> = {
    "endpoints.jsonl": [{ id: idA, url: urlA, names: ["com.example/a"], firstSeen: started, inRegistry: true, checks: [`${started} L`], changes: [], file: listA }, { id: endpointId("https://b.example.com/mcp"), url: "https://b.example.com/mcp", names: [], firstSeen: started, inRegistry: true, checks: [], changes: [] }, ...(options.extraEndpoints ?? [])].map((record) => JSON.stringify(record)).join("\n") + "\n",
    [listA]: options.listText ?? `${JSON.stringify({ source: urlA, takenAt: started, tools: [{ name: "read_thing", kind: "read" }] })}\n`,
    "feed.json": `${JSON.stringify(options.feed ?? { version: 1, generatedAt: started, watched: [{ id: idA, vendor: "example" }], changes: [] })}\n`,
    "servers.json": `${JSON.stringify(options.servers ?? [{ id: idA, url: urlA, tools: 1 }])}\n`,
    "lookup.json": `${JSON.stringify({ version: 1, generatedAt: started, rows: [["com.example/a", urlA, 1]] })}\n`,
    "registry.json": `${JSON.stringify({ readAt: started })}\n`,
    ...options.manifestExtra,
  };
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await writeFile(path.join(dir, relative), text);
  }
  const manifest = {
    version: 1, methodVersion: "1.0.0", scanStartedAt: started, generatedAt: started, scanner: { commit: "a".repeat(40) },
    run: { id: "123", attempt: "1", repository: "Stackduke/mcp-scanner" }, registry: { readAt: started, attemptedAt: started, attemptOk: true },
    files: Object.entries(files).map(([relative, text]) => ({ path: relative, sha256: sha(text), bytes: Buffer.byteLength(text) })).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** A local stand-in for R2's S3 API: checks each request's signature, and keeps objects in memory. */
async function fakeS3(options: { failPut?: string } = {}) {
  const objects = new Map<string, { body: Buffer; headers: Record<string, string> }>();
  const requests: Array<{ method: string; key: string }> = [];
  const credentials = { accessKeyId: "test-key-id", secretAccessKey: "test-secret" };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const key = decodeURIComponent(url.pathname.replace(/^\/radar\//, ""));
      requests.push({ method: request.method ?? "", key });
      // The signature is recomputed from what arrived: a header changed on the way, or the wrong body, fails it.
      const auth = /SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(String(request.headers.authorization));
      const names = (auth?.[1] ?? "").split(";").filter((name) => !["host", "x-amz-date", "x-amz-content-sha256"].includes(name));
      const amzDate = String(request.headers["x-amz-date"]);
      const date = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
      const expected = signV4({ method: request.method ?? "", url, headers: Object.fromEntries(names.map((name) => [name, String(request.headers[name])])), payloadHash: sha(body), credentials, region: "auto", service: "s3", date });
      if (!url.pathname.startsWith("/radar/") || request.headers["x-amz-content-sha256"] !== sha(body) || expected.authorization !== request.headers.authorization) { response.writeHead(403).end("SignatureDoesNotMatch"); return; }
      const stored = objects.get(key);
      if (request.method === "HEAD" || request.method === "GET") {
        if (!stored) { response.writeHead(404).end(); return; }
        response.writeHead(200, stored.headers).end(request.method === "GET" ? stored.body : undefined);
        return;
      }
      if (request.method === "PUT") {
        if (options.failPut === key) { response.writeHead(500).end("InternalError"); return; }
        if (request.headers["if-none-match"] === "*" && stored) { response.writeHead(412).end("PreconditionFailed"); return; }
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "cache-control", "x-amz-meta-source-sha256"]) if (request.headers[name]) headers[name] = String(request.headers[name]);
        objects.set(key, { body, headers });
        response.writeHead(200).end();
        return;
      }
      response.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { objects, requests, endpoint, store: s3Store({ endpoint, bucket: "radar", credentials }) };
}

test("SigV4 signs as AWS's published examples do", () => {
  const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const date = new Date("2013-05-24T00:00:00Z");
  const get = signV4({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { range: "bytes=0-9" }, payloadHash: sha(""), credentials, region: "us-east-1", service: "s3", date });
  assert.match(get.authorization as string, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  const put = signV4({ method: "PUT", url: new URL(`https://examplebucket.s3.amazonaws.com/${encodeKey("test$file.text")}`), headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, payloadHash: sha("Welcome to Amazon S3."), credentials, region: "us-east-1", service: "s3", date });
  assert.match(put.authorization as string, /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});

test("keys follow the layout: scan ids from the start time, content-addressed lists, nothing else", () => {
  assert.equal(scanIdOf(started), scanId);
  assert.equal(scanIdOf("2026-10-18T13:35:49+02:00"), "2026-10-18T113549Z");
  assert.throws(() => scanIdOf("yesterday"));
  assert.equal(listKey(idA, "f".repeat(64)), `lists/${idA}/${"f".repeat(64)}.json`);
  for (const key of ["latest.json", `scans/${scanId}/scan.json`, `scans/${scanId}/endpoints.jsonl.gz`, `lists/${idA}/${"0".repeat(64)}.json`, `evidence/${idA}/${"0".repeat(64)}.json`]) assert.ok(isLayoutKey(key), key);
  for (const key of ["latest.json.bak", `scans/${scanId}/other.json`, "scans/2026-11-25/scan.json", `lists/signed-in-stripe/${"0".repeat(64)}.json`, `lists/${idA}/../latest.json`, "watched/stripe.json"]) assert.ok(!isLayoutKey(key), key);
});

test("a scan folder becomes exactly the layout's objects, with the right types and cache headers", async () => {
  const dir = await folder();
  await writeScan(dir);
  const plan = planScan(await scanInputFromFolder(dir));
  const listBytes = await readFile(path.join(dir, listA));
  assert.deepEqual(plan.objects.map((object) => object.key).sort(), [
    listKey(idA, sha(listBytes)),
    ...["endpoints.jsonl.gz", "feed.json", "lists.jsonl.gz", "lookup.json", "manifest.json", "registry.json", "scan.json", "servers.json"].map((name) => `scans/${scanId}/${name}`),
  ].sort());
  for (const object of plan.objects) {
    assert.equal(object.contentType, object.key.endsWith(".gz") ? "application/gzip" : "application/json", object.key);
    assert.equal(object.cacheControl, "public, max-age=31536000, immutable", object.key);
  }
  const bundle = plan.objects.find((object) => object.key.endsWith("lists.jsonl.gz"));
  const line = JSON.parse(gunzipSync(bundle?.body as Buffer).toString("utf8").trim());
  assert.deepEqual(line, { id: idA, path: listA, sha256: sha(listBytes), list: JSON.parse(listBytes.toString("utf8")) });
  assert.equal(plan.record.source.kind, "track");
  assert.deepEqual(plan.record.lists, { current: 1, written: [listKey(idA, sha(listBytes))] });
  assert.equal(plan.record.signed, false);
  // A list the scan did not rewrite is in the bundle, but gets no object of its own: an earlier scan wrote it.
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  manifest.files = manifest.files.filter((file: { path: string }) => file.path !== listA);
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  const again = planScan(await scanInputFromFolder(dir));
  assert.equal(again.objects.filter((object) => object.key.startsWith("lists/")).length, 0);
  assert.equal(again.record.lists.current, 1);
});

test("a file that does not match the manifest, or one the manifest leaves out, stops the plan", async () => {
  const dir = await folder();
  await writeScan(dir);
  await writeFile(path.join(dir, "feed.json"), "{}\n");
  await assert.rejects(scanInputFromFolder(dir), /feed\.json does not match its sha256/);
  const other = await folder();
  await writeScan(other, { manifestExtra: { "notes.json": "{}\n" } });
  await assert.rejects(scanInputFromFolder(other), /notes\.json has no place in the layout/);
  await rm(path.join(other, "manifest.json"));
  await assert.rejects(scanInputFromFolder(other), /no manifest\.json/);
  await assert.rejects(scanInputFromFolder(dir, { requireSignature: true }), /signature was required/);
});

test("publishing writes every object, then latest.json last, with metadata a re-run can compare", async () => {
  const dir = await folder();
  await writeScan(dir);
  const plan = planScan(await scanInputFromFolder(dir));
  const s3 = await fakeS3();
  const report = await publish(plan, s3.store, { now: () => new Date("2026-11-25T15:00:00Z") });
  assert.equal(report.written, plan.objects.length);
  const puts = s3.requests.filter((request) => request.method === "PUT");
  assert.equal(puts.length, plan.objects.length + 1);
  assert.equal(puts.at(-1)?.key, "latest.json");
  const pointer = JSON.parse(s3.objects.get("latest.json")?.body.toString("utf8") as string);
  assert.deepEqual(pointer, { layout: 1, scan: scanId, record: `scans/${scanId}/scan.json`, scans: [scanId], updatedAt: "2026-11-25T15:00:00.000Z" });
  assert.equal(s3.objects.get("latest.json")?.headers["cache-control"], "public, max-age=60");
  const endpoints = s3.objects.get(`scans/${scanId}/endpoints.jsonl.gz`);
  assert.equal(gunzipSync(endpoints?.body as Buffer).toString("utf8"), await readFile(path.join(dir, "endpoints.jsonl"), "utf8"));
  assert.equal(endpoints?.headers["content-type"], "application/gzip");
  assert.equal(endpoints?.headers["x-amz-meta-source-sha256"], sha(await readFile(path.join(dir, "endpoints.jsonl"))));

  // The same scan again: nothing is rewritten, and the pointer stays on it.
  s3.requests.length = 0;
  const rerun = await publish(planScan(await scanInputFromFolder(dir)), s3.store);
  assert.deepEqual([rerun.written, rerun.present], [0, plan.objects.length]);
  assert.deepEqual(s3.requests.filter((request) => request.method === "PUT").map((request) => request.key), ["latest.json"]);
});

test("an immutable key already there with other content is never overwritten, and the pointer does not move", async () => {
  const dir = await folder();
  await writeScan(dir);
  const plan = planScan(await scanInputFromFolder(dir));
  const s3 = await fakeS3();
  const feedKey = `scans/${scanId}/feed.json`;
  s3.objects.set(feedKey, { body: Buffer.from("{\"other\":true}\n"), headers: { "x-amz-meta-source-sha256": sha("{\"other\":true}\n") } });
  await assert.rejects(publish(plan, s3.store, { concurrency: 1 }), new RegExp(`${feedKey} is already in the bucket with different content`));
  assert.equal(s3.objects.get(feedKey)?.body.toString("utf8"), "{\"other\":true}\n");
  assert.ok(!s3.objects.has("latest.json"));
  assert.ok(!s3.requests.some((request) => request.method === "PUT" && request.key === feedKey));
  // An object with no recorded hash is not taken on trust either.
  const bare = await fakeS3();
  bare.objects.set(feedKey, { body: Buffer.from("{}"), headers: {} });
  await assert.rejects(publish(plan, bare.store), /already in the bucket with different content/);
});

test("a key written by someone else between the look and the write is compared, not overwritten", async () => {
  const dir = await folder();
  await writeScan(dir);
  const plan = planScan(await scanInputFromFolder(dir));
  const looks = new Map<string, number>();
  const racing = (sameContent: boolean): Store => ({
    async head(key) { const seen = (looks.get(key) ?? 0) + 1; looks.set(key, seen); return seen === 1 ? null : sameContent ? (plan.objects.find((object) => object.key === key)?.sourceSha256 ?? "") : "0".repeat(64); },
    async putNew() { return false; },
    async putPointer() { throw new Error("pointer written"); },
    async get() { return null; },
  });
  await assert.rejects(publish(plan, racing(true)), /pointer written/);
  looks.clear();
  await assert.rejects(publish(plan, racing(false)), /different content/);
});

test("when any object fails to upload, latest.json is not written", async () => {
  const dir = await folder();
  await writeScan(dir);
  const s3 = await fakeS3({ failPut: `scans/${scanId}/servers.json` });
  await assert.rejects(publish(planScan(await scanInputFromFolder(dir)), s3.store), /PUT scans\/.*servers\.json answered 500/);
  assert.ok(!s3.requests.some((request) => request.key === "latest.json" && request.method === "PUT"));
});

test("the pointer never moves back to an older scan, and lists every scan", async () => {
  const newer = { layout: 1, scan: "2026-11-26T040000Z", record: "scans/2026-11-26T040000Z/scan.json", scans: ["2026-11-26T040000Z"], updatedAt: "x" };
  const pointer = nextPointer(newer, scanId, "now");
  assert.equal(pointer.scan, "2026-11-26T040000Z");
  assert.deepEqual(pointer.scans, ["2026-11-26T040000Z", scanId]);
  const dir = await folder();
  await writeScan(dir);
  const s3 = await fakeS3();
  s3.objects.set("latest.json", { body: Buffer.from("not json"), headers: {} });
  await assert.rejects(publish(planScan(await scanInputFromFolder(dir)), s3.store), /latest\.json in the bucket is not valid JSON/);
  assert.deepEqual(s3.requests.map((request) => request.method), ["GET"]);
});

test("--dry-run prints the plan and makes no network call, even with a bucket's keys set", async () => {
  const dir = await folder();
  await writeScan(dir);
  let calls = 0;
  const lines: string[] = [];
  const code = await radarMain(["publish", `--data=${dir}`, "--dry-run"], {
    env: { R2_ACCOUNT_ID: "0".repeat(32), R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" },
    fetchImpl: (async () => { calls += 1; throw new Error("no network in a dry run"); }) as unknown as typeof fetch,
    log: (line) => lines.push(line),
    now: soon,
  });
  assert.equal(code, 0);
  assert.equal(calls, 0);
  assert.match(lines.join("\n"), new RegExp(`scans/${scanId}/endpoints\\.jsonl\\.gz`));
  assert.match(lines.join("\n"), /latest\.json {2}last/);
  // A target must be named, and only one.
  assert.equal(await radarMain(["publish", `--data=${dir}`], { log: () => undefined }), 2);
  assert.equal(await radarMain(["publish", `--data=${dir}`, "--dry-run", `--to-folder=${dir}`], { log: () => undefined }), 2);
});

test("the CLI uploads to a bucket with the keys from the environment", async () => {
  const dir = await folder();
  await writeScan(dir);
  const s3 = await fakeS3();
  const code = await radarMain(["publish", `--data=${dir}`, "--bucket=radar", `--endpoint=${s3.endpoint}`], { env: { R2_ACCESS_KEY_ID: "test-key-id", R2_SECRET_ACCESS_KEY: "test-secret" }, log: () => undefined, now: soon });
  assert.equal(code, 0);
  assert.ok(s3.objects.has(`scans/${scanId}/scan.json`));
  assert.equal(await radarMain(["publish", `--data=${dir}`, "--bucket=radar"], { env: {}, log: () => undefined }), 2);
  // The stand-in checks signatures for real: a wrong secret is turned away.
  await assert.rejects(radarMain(["publish", `--data=${dir}`, "--bucket=radar", `--endpoint=${s3.endpoint}`], { env: { R2_ACCESS_KEY_ID: "test-key-id", R2_SECRET_ACCESS_KEY: "wrong" }, log: () => undefined, now: soon }), /answered 403/);
  // A scan dated in the future (or long ago) is refused before anything is sent: the pointer never moves back, so it would stick.
  const before = s3.requests.length;
  for (const clock of ["2026-11-20T00:00:00Z", "2026-12-10T00:00:00Z"]) {
    assert.equal(await radarMain(["publish", `--data=${dir}`, "--bucket=radar", `--endpoint=${s3.endpoint}`], { env: { R2_ACCESS_KEY_ID: "test-key-id", R2_SECRET_ACCESS_KEY: "test-secret" }, log: () => undefined, now: () => new Date(clock) }), 1, clock);
  }
  assert.equal(s3.requests.length, before);
});

test("a local folder store keeps the same rules", async () => {
  const dir = await folder();
  await writeScan(dir);
  const out = await folder();
  const plan = planScan(await scanInputFromFolder(dir));
  assert.equal((await publish(plan, folderStore(out))).written, plan.objects.length);
  assert.equal((await publish(plan, folderStore(out))).present, plan.objects.length);
  await writeFile(path.join(out, "scans", scanId, "lookup.json"), "{}\n");
  await assert.rejects(publish(plan, folderStore(out)), /lookup\.json is already in the bucket with different content/);
});

test("nothing about a server tracked privately is ever planned", async () => {
  // The catalog's own settings: every signed-in vendor is tracked privately today.
  assert.equal(publishedVendors().has("github"), false);
  const privateEndpoint = { id: "signed-in-github", url: "https://api.githubcopilot.com/mcp/", names: [], signedIn: "github", firstSeen: started, inRegistry: false, checks: [], changes: [], file: "lists/si/api.githubcopilot.com-signed-in-github.json" };
  const cases: Array<[string, ScanOptions]> = [
    ["an endpoint record", { extraEndpoints: [privateEndpoint] }],
    ["an endpoint record with only the signedIn field", { extraEndpoints: [{ ...privateEndpoint, id: "000000000000" }] }],
    ["a feed entry", { feed: { version: 1, watched: [{ id: "signed-in-stripe", vendor: "stripe" }], changes: [] } }],
    ["a feed change", { feed: { version: 1, watched: [], changes: [{ id: "signed-in-linear" }] } }],
    ["a servers row", { servers: [{ id: "signed-in-supabase" }] }],
    ["a list file", { manifestExtra: { "lists/si/mcp.stripe.com-signed-in-stripe.json": "{}\n" } }],
    ["a watched file", { manifestExtra: { "watched/linear.json": "{}\n" } }],
  ];
  for (const [what, options] of cases) {
    const dir = await folder();
    await writeScan(dir, options);
    const error = await (async () => { try { planScan(await scanInputFromFolder(dir)); } catch (caught) { return caught; } return null; })();
    assert.ok(error instanceof PrivateDataError, `${what} was not refused`);
    // The refusal names no vendor: the log it lands in is public.
    assert.doesNotMatch((error as Error).message, /github|stripe|linear|supabase/i, what);
  }
  // Only the scanner's own fields decide: a public server naming a tool after a vendor is published as usual.
  const dir = await folder();
  await writeScan(dir, { listText: `${JSON.stringify({ source: urlA, takenAt: started, tools: [{ name: "signed-in-github", kind: "read" }] })}\n` });
  assert.ok(planScan(await scanInputFromFolder(dir)).objects.length > 0);
  // A vendor the catalog publishes would be allowed.
  assert.equal(isPrivateRecord({ id: "signed-in-github", signedIn: "github" }, new Set(["github"])), false);
  assert.equal(isPrivateRecord({ id: "signed-in-github", signedIn: "github" }, new Set()), true);
});
