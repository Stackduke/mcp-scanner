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
import { PrivateDataError, evidenceKey, isLayoutKey, isPrivateRecord, listKey, nextPointer, planScan, scanIdOf } from "../src/radar-layout.ts";
import { encodeKey, folderStore, publish, s3Store, scanInputFromFolder, signV4 } from "../src/radar-publish.ts";
import type { Store } from "../src/radar-publish.ts";
import { buildManifest, writeManifest } from "../src/manifest.ts";
import { signedInServers } from "../src/signed-in.ts";
import { endpointId, lookupOf } from "../src/tracker.ts";
import type { FeedServer } from "../src/tracker.ts";

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

/** A servers.json row as the tracker writes it. */
const serverRow = (id: string, url: string): FeedServer => ({ id, url, names: ["com.example/a"], firstSeen: started, tools: 1, kinds: { read: 1 }, lastChecked: started, lastListed: started, outcome: "listed", changesIn30Days: 0, watchIn30Days: 0 } as unknown as FeedServer);

/** A scan's data folder as the Track job leaves it: its files, and a manifest of those it wrote. */
async function writeScan(dir: string, options: ScanOptions = {}): Promise<void> {
  const servers = options.servers ?? [serverRow(idA, urlA)];
  const files: Record<string, string> = {
    "endpoints.jsonl": [{ id: idA, url: urlA, names: ["com.example/a"], firstSeen: started, inRegistry: true, checks: [`${started} L`], changes: [], file: listA }, { id: endpointId("https://b.example.com/mcp"), url: "https://b.example.com/mcp", names: [], firstSeen: started, inRegistry: true, checks: [], changes: [] }, ...(options.extraEndpoints ?? [])].map((record) => JSON.stringify(record)).join("\n") + "\n",
    [listA]: options.listText ?? `${JSON.stringify({ source: urlA, takenAt: started, tools: [{ name: "read_thing", kind: "read" }] })}\n`,
    "feed.json": `${JSON.stringify(options.feed ?? { version: 1, generatedAt: started, watched: [{ id: idA, vendor: "example" }], changes: [] })}\n`,
    "servers.json": `${JSON.stringify(servers)}\n`,
    "lookup.json": `${JSON.stringify({ version: 1, generatedAt: started, rows: (() => { try { return lookupOf(servers as FeedServer[]); } catch { return []; } })() })}\n`,
    "registry.json": `${JSON.stringify({ readAt: started })}\n`,
    "hosts.json": `${JSON.stringify({ version: 1, hosts: { "a.example.com": { overBudgetRuns: 0 } } })}\n`,
    ...options.manifestExtra,
  };
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await writeFile(path.join(dir, relative), text);
  }
  // The manifest the scanner itself writes: a digest of the whole folder and the sha256 of each file written.
  await writeManifest(dir, await buildManifest({
    dataDir: dir, written: Object.keys(files), scanStartedAt: started, generatedAt: started,
    registry: { readAt: started, attemptedAt: started, attemptOk: true }, previous: { verified: true },
    environment: { GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "Stackduke/mcp-scanner" },
  }));
}

/** A local stand-in for R2's S3 API: checks each request's signature, and keeps objects in memory. */
async function fakeS3(options: { failPut?: string; beforePointerPut?: () => Promise<void>; locked?: boolean } = {}) {
  const objects = new Map<string, { body: Buffer; headers: Record<string, string> }>();
  let pointerPuts = 0;
  const requests: Array<{ method: string; key: string }> = [];
  const credentials = { accessKeyId: "test-key-id", secretAccessKey: "test-secret" };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
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
      // Another run's turn, between this run's last read of latest.json and its write (the first time only).
      if (request.method === "PUT" && key === "latest.json" && (pointerPuts += 1) === 1) await options.beforePointerPut?.();
      const stored = objects.get(key);
      if (request.method === "HEAD" || request.method === "GET") {
        if (!stored) { response.writeHead(404).end(); return; }
        response.writeHead(200, stored.headers).end(request.method === "GET" ? stored.body : undefined);
        return;
      }
      if (request.method === "PUT") {
        if (options.failPut === key) { response.writeHead(500).end("InternalError"); return; }
        // As R2 does under a bucket lock on every prefix but latest.json: the lock is checked before any condition.
        if (options.locked && stored && key !== "latest.json") { response.writeHead(409).end("<Error><Code>ObjectLockedByBucketPolicy</Code></Error>"); return; }
        // As R2 does: If-None-Match: * only if absent, If-Match only if the ETag is the one there now.
        if (request.headers["if-none-match"] === "*" && stored) { response.writeHead(412).end("PreconditionFailed"); return; }
        if (request.headers["if-match"] !== undefined && request.headers["if-match"] !== stored?.headers.etag) { response.writeHead(412).end("PreconditionFailed"); return; }
        const headers: Record<string, string> = { etag: `"${createHash("md5").update(body).digest("hex")}"` };
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
  for (const key of ["latest.json", `scans/${scanId}/scan.json`, `scans/${scanId}/manifest.sigstore.json`, `snapshots/${scanId}/endpoints.jsonl.gz`, `lists/${idA}/${"0".repeat(64)}.json`, `evidence/${idA}/${"0".repeat(64)}.json`]) assert.ok(isLayoutKey(key), key);
  for (const key of ["latest.json.bak", `scans/${scanId}/other.json`, `scans/${scanId}/feed.json`, `snapshots/${scanId}/scan.json`, "scans/2026-11-25/scan.json", `lists/signed-in-stripe/${"0".repeat(64)}.json`, `lists/${idA}/../latest.json`, "watched/stripe.json"]) assert.ok(!isLayoutKey(key), key);
});

test("a scan folder becomes exactly the layout's objects, with the right types and cache headers", async () => {
  const dir = await folder();
  await writeScan(dir);
  const plan = planScan(await scanInputFromFolder(dir));
  const listBytes = await readFile(path.join(dir, listA));
  assert.deepEqual(plan.objects.map((object) => object.key).sort(), [
    listKey(idA, sha(listBytes)),
    ...["manifest.json", "scan.json"].map((name) => `scans/${scanId}/${name}`),
    ...["endpoints.jsonl.gz", "feed.json", "hosts.json", "lists.jsonl.gz", "lookup.json", "registry.json", "servers.json"].map((name) => `snapshots/${scanId}/${name}`),
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

test("the folder must be the one its manifest describes, and a required signature must verify", async () => {
  const dir = await folder();
  await writeScan(dir);
  await writeFile(path.join(dir, "feed.json"), "{}\n");
  await assert.rejects(scanInputFromFolder(dir), /feed\.json: does not match its sha256/);
  // A list the scan did not write is covered too, by the digest of the whole folder.
  const unwritten = await folder();
  await writeScan(unwritten);
  await mkdir(path.join(unwritten, "lists", "00"), { recursive: true });
  await writeFile(path.join(unwritten, "lists", "00", `other-${"0".repeat(12)}.json`), "{}\n");
  await assert.rejects(scanInputFromFolder(unwritten), /does not match the manifest's digest/);
  const other = await folder();
  await writeScan(other, { manifestExtra: { "notes.json": "{}\n" } });
  await assert.rejects(scanInputFromFolder(other), /notes\.json has no place in the layout/);
  await rm(path.join(other, "manifest.json"));
  await assert.rejects(scanInputFromFolder(other), /no manifest\.json/);

  // The scanner's .gitattributes is in the folder and the manifest, and is not published.
  const attributes = await folder();
  await writeScan(attributes, { manifestExtra: { ".gitattributes": "* text eol=lf\n" } });
  assert.ok(planScan(await scanInputFromFolder(attributes)).objects.every((object) => !object.key.includes("gitattributes")));

  const signed = await folder();
  await writeScan(signed);
  await assert.rejects(scanInputFromFolder(signed, { requireSignature: true }), /no manifest\.sigstore\.json/);
  await writeFile(path.join(signed, "manifest.sigstore.json"), "{\"bundle\":true}\n");
  const asked: string[][] = [];
  const input = await scanInputFromFolder(signed, { requireSignature: true, cosign: async (args) => { asked.push(args); return { code: 0, output: "Verified OK" }; } });
  assert.ok(asked[0]?.includes("--certificate-identity"));
  const plan = planScan(input);
  assert.equal(plan.record.signed, true);
  assert.ok(plan.objects.some((object) => object.key === `scans/${scanId}/manifest.sigstore.json`));
  await assert.rejects(scanInputFromFolder(signed, { requireSignature: true, cosign: async () => ({ code: 1, output: "error: invalid signature" }) }), /signature did not verify/);
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
  assert.deepEqual(pointer, { layout: 1, scan: scanId, record: `scans/${scanId}/scan.json`, scans: [scanId], withdrawn: [], updatedAt: "2026-11-25T15:00:00.000Z" });
  assert.equal(s3.objects.get("latest.json")?.headers["cache-control"], "public, max-age=60");
  const endpoints = s3.objects.get(`snapshots/${scanId}/endpoints.jsonl.gz`);
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
  const feedKey = `snapshots/${scanId}/feed.json`;
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
    async getPointer() { return null; },
    async putPointer() { throw new Error("pointer written"); },
  });
  await assert.rejects(publish(plan, racing(true)), /pointer written/);
  looks.clear();
  await assert.rejects(publish(plan, racing(false)), /different content/);
});

test("under a bucket lock, a key someone else wrote first is compared, not a failure", async () => {
  const dir = await folder();
  await writeScan(dir);
  const plan = planScan(await scanInputFromFolder(dir));
  const s3 = await fakeS3({ locked: true });
  await publish(plan, s3.store);
  // The first HEAD of each key says absent, as if the key were written between the look and the write: each PUT meets the lock.
  const blind = (): Store => {
    const seen = new Set<string>();
    return { ...s3.store, head: async (key) => { if (seen.has(key)) return s3.store.head(key); seen.add(key); return null; } };
  };
  const report = await publish(plan, blind());
  assert.deepEqual([report.written, report.present], [0, plan.objects.length]);
  // Other content under the lock still stops the run.
  const feedKey = `snapshots/${scanId}/feed.json`;
  s3.objects.set(feedKey, { body: Buffer.from("{}"), headers: { "x-amz-meta-source-sha256": sha("{}") } });
  await assert.rejects(publish(plan, blind()), /already in the bucket with different content/);
});

test("when any object fails to upload, latest.json is not written", async () => {
  const dir = await folder();
  await writeScan(dir);
  const s3 = await fakeS3({ failPut: `snapshots/${scanId}/servers.json` });
  await assert.rejects(publish(planScan(await scanInputFromFolder(dir)), s3.store), /PUT snapshots\/.*servers\.json answered 500/);
  assert.ok(!s3.requests.some((request) => request.key === "latest.json" && request.method === "PUT"));
});

test("the pointer never moves back to an older scan, and lists every scan", async () => {
  const newer = { layout: 1, scan: "2026-11-26T040000Z", record: "scans/2026-11-26T040000Z/scan.json", scans: ["2026-11-26T040000Z"], withdrawn: [], updatedAt: "x" };
  const pointer = nextPointer(newer, scanId, "now");
  assert.equal(pointer.scan, "2026-11-26T040000Z");
  assert.deepEqual(pointer.scans, ["2026-11-26T040000Z", scanId]);
  const dir = await folder();
  await writeScan(dir);
  const s3 = await fakeS3();
  s3.objects.set("latest.json", { body: Buffer.from("not json"), headers: { etag: "\"0\"" } });
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
  assert.match(lines.join("\n"), new RegExp(`snapshots/${scanId}/endpoints\\.jsonl\\.gz`));
  assert.match(lines.join("\n"), /latest\.json {2}last/);
  // A target must be named, and only one.
  assert.equal(await radarMain(["publish", `--data=${dir}`], { log: () => undefined }), 2);
  assert.equal(await radarMain(["publish", `--data=${dir}`, "--dry-run", `--to-folder=${dir}`], { log: () => undefined }), 2);
});

test("the CLI uploads to a bucket with the keys from the environment", async () => {
  const dir = await folder();
  await writeScan(dir);
  const s3 = await fakeS3();
  const code = await radarMain(["publish", `--data=${dir}`, "--bucket=radar", "--unsigned", `--endpoint=${s3.endpoint}`], { env: { R2_ACCESS_KEY_ID: "test-key-id", R2_SECRET_ACCESS_KEY: "test-secret" }, log: () => undefined, now: soon });
  assert.equal(code, 0);
  assert.ok(s3.objects.has(`scans/${scanId}/scan.json`));
  assert.equal(await radarMain(["publish", `--data=${dir}`, "--bucket=radar", "--unsigned"], { env: {}, log: () => undefined }), 2);
  // The stand-in checks signatures for real: a wrong secret is turned away.
  await assert.rejects(radarMain(["publish", `--data=${dir}`, "--bucket=radar", "--unsigned", `--endpoint=${s3.endpoint}`], { env: { R2_ACCESS_KEY_ID: "test-key-id", R2_SECRET_ACCESS_KEY: "wrong" }, log: () => undefined, now: soon }), /answered 403/);
  // A scan dated in the future (or long ago) is refused before anything is sent: the pointer never moves back, so it would stick.
  const before = s3.requests.length;
  for (const clock of ["2026-11-20T00:00:00Z", "2026-12-10T00:00:00Z"]) {
    assert.equal(await radarMain(["publish", `--data=${dir}`, "--bucket=radar", "--unsigned", `--endpoint=${s3.endpoint}`], { env: { R2_ACCESS_KEY_ID: "test-key-id", R2_SECRET_ACCESS_KEY: "test-secret" }, log: () => undefined, now: () => new Date(clock) }), 1, clock);
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
  await writeFile(path.join(out, "snapshots", scanId, "lookup.json"), "{}\n");
  await assert.rejects(publish(plan, folderStore(out)), /lookup\.json is already in the bucket with different content/);
});

test("nothing about a server tracked privately is ever planned", async () => {
  // Layout 1 has no place for any server watched with a sign-in, whatever the catalog says.
  assert.ok(Object.keys(signedInServers).length > 0);
  const privateEndpoint = { id: "signed-in-github", url: "https://api.githubcopilot.com/mcp/", names: [], signedIn: "github", firstSeen: started, inRegistry: false, checks: [], changes: [], file: "lists/si/api.githubcopilot.com-signed-in-github.json" };
  const cases: Array<[string, ScanOptions]> = [
    ["an endpoint record", { extraEndpoints: [privateEndpoint] }],
    ["an endpoint record with only the signedIn field", { extraEndpoints: [{ ...privateEndpoint, id: "000000000000" }] }],
    ["a feed entry", { feed: { version: 1, watched: [{ id: "signed-in-stripe", vendor: "stripe" }], changes: [] } }],
    ["a feed change", { feed: { version: 1, watched: [], changes: [{ id: "signed-in-linear" }] } }],
    ["a servers row", { servers: [{ id: "signed-in-supabase" }] }],
    ["a list file", { manifestExtra: { "lists/si/mcp.stripe.com-signed-in-stripe.json": "{}\n" } }],
    ["a watched file", { manifestExtra: { "watched/linear.json": "{}\n" } }],
    // Sites whose terms forbid publishing about them (catalog `forbidden`, the tracker's keptOffSites).
    ["an endpoint on a kept-off site", { extraEndpoints: [{ id: endpointId("https://mcp.sentry.dev/mcp"), url: "https://mcp.sentry.dev/mcp", names: [], firstSeen: started, inRegistry: true, checks: [], changes: [] }] }],
    ["a list named for a kept-off host", { manifestExtra: { "lists/ab/mcp.sentry.dev-abcdefabcdef.json": `${JSON.stringify({ source: "https://elsewhere.example.com/mcp", tools: [] })}\n` } }],
    ["a list read from a kept-off address", { manifestExtra: { "lists/ab/other.example.com-abcdefabcdef.json": `${JSON.stringify({ source: "https://mcp.airtable.com/mcp", tools: [] })}\n` } }],
    ["a feed change on a kept-off site", { feed: { version: 1, watched: [], changes: [{ id: "abcdefabcdef", url: "https://eu.sentry.io/mcp" }] } }],
    ["a kept-off host in hosts.json", { manifestExtra: { "hosts.json": `${JSON.stringify({ version: 1, hosts: { "api.intercom.com": { overBudgetRuns: 1 } } })}\n` } }],
  ];
  for (const [what, options] of cases) {
    const dir = await folder();
    await writeScan(dir, options);
    const error = await (async () => { try { planScan(await scanInputFromFolder(dir)); } catch (caught) { return caught; } return null; })();
    assert.ok(error instanceof PrivateDataError, `${what} was not refused`);
    // The refusal names no vendor: the log it lands in is public.
    assert.doesNotMatch((error as Error).message, /github|stripe|linear|supabase|sentry|airtable|intercom/i, what);
  }
  // Only the scanner's own fields decide: a public server naming a tool after a vendor is published as usual.
  const dir = await folder();
  await writeScan(dir, { listText: `${JSON.stringify({ source: urlA, takenAt: started, tools: [{ name: "signed-in-github", kind: "read" }] })}\n` });
  assert.ok(planScan(await scanInputFromFolder(dir)).objects.length > 0);
  // Even a vendor the catalog marked publish: true is refused: the layout has no place for it yet.
  assert.equal(isPrivateRecord({ id: "signed-in-github", signedIn: "github" }), true);
  assert.equal(isPrivateRecord({ id: idA }), false);
});

test("two publishes that overlap both end up in latest.json, and it never moves back", async () => {
  const dir = await folder();
  await writeScan(dir);
  const older = planScan(await scanInputFromFolder(dir));
  const newerId = "2026-11-26T041700Z";
  const newer = planScan({ ...(await scanInputFromFolder(dir)), id: newerId });
  // While the older scan's run is about to write latest.json, a run for a newer scan does all of its work.
  let s3: Awaited<ReturnType<typeof fakeS3>> | undefined;
  s3 = await fakeS3({ beforePointerPut: async () => { await publish(newer, s3?.store as Store, { now: () => new Date("2026-11-26T05:00:00Z") }); } });
  const report = await publish(older, s3.store, { now: () => new Date("2026-11-26T05:01:00Z") });
  const pointer = JSON.parse(s3.objects.get("latest.json")?.body.toString("utf8") as string);
  assert.equal(pointer.scan, newerId, "the newer scan stays current");
  assert.deepEqual(pointer.scans, [newerId, scanId], "neither scan is lost");
  assert.deepEqual(report.pointer.scans, [newerId, scanId]);
  // The losing write was refused by the store, then the run read latest.json again and wrote it on that.
  const pointerRequests = s3.requests.filter((request) => request.key === "latest.json").map((request) => request.method);
  assert.deepEqual(pointerRequests, ["GET", "GET", "PUT", "GET", "GET", "PUT", "GET", "PUT"]);
});

test("latest.json is left alone when it keeps changing under the run", async () => {
  const dir = await folder();
  await writeScan(dir);
  const plan = planScan(await scanInputFromFolder(dir));
  let writes = 0;
  const busy: Store = {
    async head() { return null; },
    async putNew() { return true; },
    async getPointer() { return null; },
    async putPointer() { writes += 1; return false; },
  };
  await assert.rejects(publish(plan, busy), /latest\.json changed under this run 5 times/);
  assert.equal(writes, 5);
});

test("each top file may hold only the fields the layout knows, about endpoints of the scan", async () => {
  const cases: Array<[string, ScanOptions, RegExp]> = [
    ["a new feed field", { feed: { version: 1, watched: [], changes: [], privateTotals: {} } }, /feed\.json has fields layout 1 does not know \(privateTotals\)/],
    ["a servers row of no endpoint", { servers: [{ id: idA }, { id: "0123456789ab", url: "https://elsewhere.example.com" }] }, /servers\.json row 2 is not an endpoint of this scan/],
    ["a lookup row of no endpoint", { manifestExtra: { "lookup.json": `${JSON.stringify({ version: 1, rows: [["x", "https://elsewhere.example.com/mcp", 1]] })}\n` } }, /lookup\.json is not the lookup of this scan's servers\.json/],
    // The address of an endpoint of the scan, but not a row of its servers table: what a private record's row would look like.
    ["a lookup row the servers table does not have", { manifestExtra: { "lookup.json": `${JSON.stringify({ version: 1, generatedAt: started, rows: [...lookupOf([serverRow(idA, urlA)]), ["", "https://b.example.com/mcp", 9, "2026-11-25", 0, { write: 9 }]] })}\n` } }, /lookup\.json is not the lookup of this scan's servers\.json/],
    ["a new registry field", { manifestExtra: { "registry.json": `${JSON.stringify({ readAt: started, token: "x" })}\n` } }, /registry\.json has fields layout 1 does not know \(token\)/],
    ["a hosts entry with more than its counters", { manifestExtra: { "hosts.json": `${JSON.stringify({ version: 1, hosts: { "a.example.com": { overBudgetRuns: 1, tools: [] } } })}\n` } }, /hosts\.json has fields layout 1 does not know/],
  ];
  for (const [what, options, expected] of cases) {
    const dir = await folder();
    await writeScan(dir, options);
    const input = await scanInputFromFolder(dir);
    assert.throws(() => planScan(input), expected, what);
  }
});

test("a list no endpoint names is kept under the id in its file name; one with no id is left out", async () => {
  const orphanId = "cccccccccccc";
  const orphan = `lists/cc/gone.example.com-${orphanId}.json`;
  const orphanText = `${JSON.stringify({ source: "https://gone.example.com/mcp", tools: [] })}\n`;
  const dir = await folder();
  await writeScan(dir, { manifestExtra: { [orphan]: orphanText } });
  // Not written by this scan: an older scan wrote it, so it is in the folder and its digest.
  await writeFile(path.join(dir, "lists", "cc", "notes.json"), "{}\n");
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  await rm(path.join(dir, "manifest.json"));
  await writeManifest(dir, await buildManifest({
    dataDir: dir, written: manifest.files.map((file: { path: string }) => file.path), scanStartedAt: started, generatedAt: started,
    registry: { readAt: started, attemptedAt: started, attemptOk: true }, previous: { verified: true }, environment: {},
  }));
  const plan = planScan(await scanInputFromFolder(dir));
  assert.deepEqual([plan.orphanLists, plan.leftOutLists], [1, 1]);
  assert.ok(plan.objects.some((object) => object.key === listKey(orphanId, sha(orphanText))));
  const lines = gunzipSync(plan.objects.find((object) => object.key.endsWith("lists.jsonl.gz"))?.body as Buffer).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.id, line.path]).sort(), [[idA, listA], [orphanId, orphan]].sort());
});

test("evidence is kept only for an endpoint of the scan", async () => {
  const dir = await folder();
  await writeScan(dir);
  const input = await scanInputFromFolder(dir);
  const response = Buffer.from("{\"status\":401}\n");
  const plan = planScan({ ...input, evidence: new Map([[`evidence/${idA}/first.json`, response]]) });
  assert.deepEqual(plan.record.evidence, [evidenceKey(idA, sha(response))]);
  assert.ok(plan.objects.some((object) => object.key === evidenceKey(idA, sha(response))));
  for (const evidencePath of [`evidence/${"0".repeat(12)}/first.json`, "evidence/signed-in-stripe/first.json", `evidence/${idA}/../first.json`]) {
    assert.throws(() => planScan({ ...input, evidence: new Map([[evidencePath, response]]) }), /is not evidence for an endpoint of this scan/, evidencePath);
  }
});

test("a top file put in the folder after its manifest was written is refused", async () => {
  const dir = await folder();
  await writeScan(dir, { manifestExtra: {} });
  await rm(path.join(dir, "hosts.json"));
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  await rm(path.join(dir, "manifest.json"));
  await writeManifest(dir, await buildManifest({
    dataDir: dir, written: manifest.files.map((file: { path: string }) => file.path).filter((name: string) => name !== "hosts.json"), scanStartedAt: started, generatedAt: started,
    registry: { readAt: started, attemptedAt: started, attemptOk: true }, previous: { verified: true }, environment: {},
  }));
  assert.ok(planScan(await scanInputFromFolder(dir)).objects.every((object) => !object.key.endsWith("hosts.json")));
  await writeFile(path.join(dir, "hosts.json"), `${JSON.stringify({ version: 1, hosts: {} })}\n`);
  await assert.rejects(scanInputFromFolder(dir), /does not match the manifest's digest/);
});

test("an error from the store reaches the log without the secret key", async () => {
  const credentials = { accessKeyId: "test-key-id", secretAccessKey: "s3cr3t-value-never-logged" };
  // A store that answers with everything it was sent, headers included.
  const echo = (async (input: URL | string, init?: RequestInit) => new Response(`${String(input)} ${JSON.stringify(init?.headers)}`, { status: 500 })) as typeof fetch;
  const store = s3Store({ endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "radar", credentials, fetchImpl: echo });
  const error = await store.getPointer().then(() => null, (caught: unknown) => caught as Error);
  assert.match(error?.message ?? "", /GET latest\.json answered 500/);
  assert.doesNotMatch(error?.message ?? "", /s3cr3t/);
});

test("a withdrawn scan stays withdrawn: it is never current or listed again, and uploads keep the list", async () => {
  const good = "2026-11-24T041700Z", bad = scanId, later = "2026-11-26T041700Z";
  // As an admin leaves latest.json after taking back a bad scan.
  const rolledBack = { layout: 1, scan: good, record: `scans/${good}/scan.json`, scans: [good], withdrawn: [bad], updatedAt: "x" };
  assert.throws(() => nextPointer(rolledBack, bad, "now"), /was withdrawn/);
  const older = nextPointer(rolledBack, "2026-11-20T041700Z", "now");
  assert.deepEqual([older.scan, older.scans, older.withdrawn], [good, [good, "2026-11-20T041700Z"], [bad]]);
  const next = nextPointer(older, later, "now");
  assert.deepEqual([next.scan, next.scans, next.withdrawn], [later, [later, good, "2026-11-20T041700Z"], [bad]]);
  // Even a bad id left in `scans` by mistake is not made current again.
  assert.equal(nextPointer({ ...rolledBack, scans: [bad, good] }, "2026-11-20T041700Z", "now").scan, good);

  // Re-running the bad scan's upload is refused before anything is sent.
  const dir = await folder();
  await writeScan(dir);
  const s3 = await fakeS3();
  s3.objects.set("latest.json", { body: Buffer.from(JSON.stringify(rolledBack)), headers: { etag: "\"1\"" } });
  await assert.rejects(publish(planScan(await scanInputFromFolder(dir)), s3.store), /was withdrawn from latest\.json/);
  assert.deepEqual(s3.requests.map((request) => request.method), ["GET"]);
  // A pointer from before withdrawn existed reads as none withdrawn.
  assert.deepEqual(nextPointer({ layout: 1, scan: good, record: "", scans: [good], updatedAt: "x" } as never, later, "now").withdrawn, []);
});

test("an upload to a bucket needs a verified signature, unless --unsigned says otherwise", async () => {
  const dir = await folder();
  await writeScan(dir);
  const s3 = await fakeS3();
  const env = { R2_ACCESS_KEY_ID: "test-key-id", R2_SECRET_ACCESS_KEY: "test-secret" };
  const lines: string[] = [];
  assert.equal(await radarMain(["publish", `--data=${dir}`, "--bucket=radar", `--endpoint=${s3.endpoint}`], { env, log: (line) => lines.push(line), now: soon }), 2);
  assert.match(lines.join("\n"), /needs --require-signature/);
  assert.equal(s3.requests.length, 0);
  // --unsigned only with a bucket, and never with --require-signature.
  assert.equal(await radarMain(["publish", `--data=${dir}`, "--dry-run", "--unsigned"], { log: () => undefined, now: soon }), 2);
  assert.equal(await radarMain(["publish", `--data=${dir}`, "--bucket=radar", "--unsigned", "--require-signature", `--endpoint=${s3.endpoint}`], { env, log: () => undefined, now: soon }), 2);
  assert.equal(s3.requests.length, 0);
  // Signed and verified (cosign stubbed), it goes up.
  await writeFile(path.join(dir, "manifest.sigstore.json"), "{\"bundle\":true}\n");
  assert.equal(await radarMain(["publish", `--data=${dir}`, "--bucket=radar", "--require-signature", `--endpoint=${s3.endpoint}`], { env, log: () => undefined, now: soon, cosign: async () => ({ code: 0, output: "Verified OK" }) }), 0);
  assert.ok(s3.objects.has(`scans/${scanId}/manifest.sigstore.json`));
});

test("a file changed after the folder was checked is not uploaded", async () => {
  const dir = await folder();
  await writeScan(dir);
  await writeFile(path.join(dir, "manifest.sigstore.json"), "{\"bundle\":true}\n");
  // cosign runs after the hashes are checked: a write to the folder at that moment comes after the check.
  const cosign = async () => { await writeFile(path.join(dir, "feed.json"), "{\"version\":1,\"watched\":[],\"changes\":[]}\n"); return { code: 0, output: "Verified OK" }; };
  await assert.rejects(scanInputFromFolder(dir, { requireSignature: true, cosign }), /feed\.json changed after the folder was checked/);
});

test("the store's other answers are not taken for success", async () => {
  // A 409 that is not a bucket lock stops the run.
  const answer = (status: number, body: string, headers: Record<string, string> = {}) => s3Store({ endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "radar", credentials: { accessKeyId: "id", secretAccessKey: "secret" }, fetchImpl: (async () => new Response(body, { status, headers })) as unknown as typeof fetch });
  const dir = await folder();
  await writeScan(dir);
  const object = planScan(await scanInputFromFolder(dir)).objects[0] as Parameters<Store["putNew"]>[0];
  await assert.rejects(answer(409, "<Code>OperationAborted</Code>").putNew(object), /answered 409: <Code>OperationAborted/);
  assert.equal(await answer(409, "<Code>ObjectLockedByBucketPolicy</Code>").putNew(object), false);
  // latest.json without an ETag cannot be replaced safely.
  await assert.rejects(answer(200, "{}").getPointer(), /without an ETag/);
  assert.deepEqual(await answer(200, "{}", { etag: "\"e\"" }).getPointer(), { body: Buffer.from("{}"), etag: "\"e\"" });
});

test("a folder store replaces latest.json only if it is the version read", async () => {
  const out = await folder();
  const store = folderStore(out);
  const pointer = (scan: string) => ({ key: "latest.json", body: Buffer.from(`${scan}\n`), contentType: "application/json", cacheControl: "", sourceSha256: "", sourceBytes: 0 });
  assert.equal(await store.putPointer(pointer("a"), "stale"), false, "there is none, so no version matches");
  assert.equal(await store.putPointer(pointer("a"), null), true);
  assert.equal(await store.putPointer(pointer("b"), null), false, "there is one now");
  const current = await store.getPointer();
  assert.equal(await store.putPointer(pointer("b"), "0".repeat(64)), false);
  assert.equal(await store.putPointer(pointer("b"), current?.etag ?? null), true);
  assert.equal(await readFile(path.join(out, "latest.json"), "utf8"), "b\n");
});
