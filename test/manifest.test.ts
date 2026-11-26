import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { describeVerification, githubIssuer, readManifest, signerIdentity, verifyManifest } from "../src/manifest.ts";
import type { Manifest, RunCosign } from "../src/manifest.ts";
import { methodVersion } from "../src/method.ts";
import { takeSnapshot } from "../src/snapshot.ts";
import { track } from "../src/track.ts";
import { changeBetween, printOf, readPrint } from "../src/tracker.ts";
import type { Endpoint, Feed, ListPrint } from "../src/tracker.ts";
import type { ToolDefinition } from "../src/types.ts";

const now = "2026-11-26T04:17:00.000Z";
const readOnly = { annotations: { readOnlyHint: true } };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const commit = "0123456789abcdef0123456789abcdef01234567";
const environment = { GITHUB_SHA: commit, GITHUB_RUN_ID: "9876543210", GITHUB_RUN_ATTEMPT: "2", GITHUB_REPOSITORY: "Stackduke/mcp-scanner" };

/** One registry entry, one server whose tools the test sets. */
function fakeNetwork(tools: () => ToolDefinition[]): typeof fetch {
  return (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://registry.modelcontextprotocol.io/")) return Response.json({ servers: [{ server: { name: "com.example/open", remotes: [{ type: "streamable-http", url: "https://open.example.com/mcp" }] } }], metadata: {} });
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "Open" } } });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: tools() } });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
}

async function run(dataDir: string, tools: () => ToolDefinition[], at: number) {
  return track({ dataDir, readRegistry: true, maxChecks: 10, perHost: 5, perSite: 50, concurrency: 2, hostGapMs: 0, budgetMinutes: 5, publicServers: [], environment, fetchImpl: fakeNetwork(tools), now: () => new Date(at) });
}

const readJson = async <T>(file: string) => JSON.parse(await readFile(file, "utf8")) as T;
const day = 24 * 3_600_000;

test("each run writes a manifest with the full sha256 of every file it wrote, the method version, the scanner commit and the run", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "manifest-"));
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now));
  const manifest = await readJson<Manifest>(path.join(dataDir, "manifest.json"));

  assert.equal(manifest.version, 1);
  assert.equal(manifest.methodVersion, methodVersion);
  assert.equal(manifest.methodVersion, "1.0.0");
  assert.deepEqual(manifest.scanner, { commit });
  assert.deepEqual(manifest.run, { id: "9876543210", attempt: "2", repository: "Stackduke/mcp-scanner" });
  assert.equal(manifest.scanStartedAt, now);
  assert.equal(manifest.registry.readAt, now, "the registry read time");
  assert.equal(manifest.registry.attemptOk, true);

  // One endpoint, so endpoints.jsonl is one line of JSON.
  const listFile = (await readJson<Endpoint>(path.join(dataDir, "endpoints.jsonl"))).file as string;
  assert.deepEqual(manifest.files.map((file) => file.path), ["endpoints.jsonl", "feed.json", listFile, "lookup.json", "registry.json", "servers.json"].sort());
  for (const file of manifest.files) {
    const text = await readFile(path.join(dataDir, file.path), "utf8");
    assert.equal(file.sha256, sha256(text), `${file.path}: the full sha256 of what is on disk`);
    assert.equal(file.bytes, Buffer.byteLength(text));
  }
  assert.ok(!manifest.files.some((file) => file.path.startsWith("manifest")), "the manifest does not list itself or its signature");
});

test("a run lists only the files it wrote: an unchanged tool list is not rewritten, so not listed", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "manifest-"));
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now) - day);
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now));
  const manifest = await readJson<Manifest>(path.join(dataDir, "manifest.json"));
  assert.deepEqual(manifest.files.map((file) => file.path), ["endpoints.jsonl", "feed.json", "lookup.json", "registry.json", "servers.json"]);
});

test("the method version is stamped into every list file and change record the tracker writes", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "manifest-"));
  let tools: ToolDefinition[] = [{ name: "get_page", ...readOnly }];
  await run(dataDir, () => tools, Date.parse(now) - day);
  tools = [{ name: "get_page", ...readOnly }, { name: "send_invoice" }];
  await run(dataDir, () => tools, Date.parse(now));

  const [endpoint] = (await readFile(path.join(dataDir, "endpoints.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Endpoint);
  assert.equal(endpoint?.changes.length, 1);
  assert.equal(endpoint?.changes[0]?.methodVersion, methodVersion, "in the change record");
  const list = await readJson<ListPrint>(path.join(dataDir, endpoint?.file as string));
  assert.equal(list.methodVersion, methodVersion, "in the list file");
  const feed = await readJson<Feed>(path.join(dataDir, "feed.json"));
  assert.equal(feed.changes[0]?.methodVersion, methodVersion, "and so in the feed's copy of the change");

  const print = printOf(takeSnapshot("https://a.example/mcp", [{ name: "x" }], undefined, now));
  assert.equal(print.methodVersion, methodVersion);
  assert.equal(changeBetween(print, print, now).methodVersion, methodVersion);
});

test("files from before the method version keep working: an old list is read, and old change records are kept as they were", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "manifest-"));
  const url = "https://open.example.com/mcp";
  const { methodVersion: _dropped, ...oldPrint } = printOf(takeSnapshot(url, [{ name: "get_page", ...readOnly }], undefined, "2026-11-01T04:17:00.000Z"));
  assert.ok(readPrint(oldPrint), "a list file with no method version is still a list file");
  const oldChange = { at: "2026-11-01T04:17:00.000Z", since: "2026-10-31T04:17:00.000Z", added: ["get_page"], removed: [], changed: [], moreSerious: [], counts: { added: 1, removed: 0, changed: 0, moreSerious: 0 }, summary: "1 tool added: get_page." };
  const file = "lists/ab/open.example.com-abc.json";
  const old = { id: "abc", url, names: ["com.example/open"], firstSeen: "2026-10-01T04:17:00.000Z", inRegistry: true, checks: ["2026-11-01T04:17:00.000Z L"], changes: [oldChange], lastChecked: "2026-11-01T04:17:00.000Z", lastListed: "2026-11-01T04:17:00.000Z", outcome: "listed", file };
  await mkdir(path.join(dataDir, "lists", "ab"), { recursive: true });
  await writeFile(path.join(dataDir, file), `${JSON.stringify(oldPrint)}\n`);
  await writeFile(path.join(dataDir, "endpoints.jsonl"), `${JSON.stringify(old)}\n`);

  await run(dataDir, () => [{ name: "get_page", ...readOnly }, { name: "delete_page" }], Date.parse(now));
  const [endpoint] = (await readFile(path.join(dataDir, "endpoints.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Endpoint);
  assert.equal(endpoint?.changes.length, 2, "the change is seen against the old list");
  assert.equal(endpoint?.changes[0]?.methodVersion, methodVersion);
  assert.deepEqual(endpoint?.changes[1], oldChange, "the old record is left as it was, with no method version");
});

async function scanned(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "manifest-"));
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now));
  return dataDir;
}

test("verify passes on the folder a scan wrote, and finds a file changed afterwards", async () => {
  const dataDir = await scanned();
  const good = await verifyManifest(dataDir, { hashesOnly: true });
  assert.equal(good.ok, true, good.problems.join("; "));
  assert.equal(good.matched, 6);
  assert.equal(good.signature, "not checked");
  assert.match(describeVerification(good), /Hashes OK\. The signature was not checked/);

  const feedFile = path.join(dataDir, "feed.json");
  const feed = await readJson<Feed>(feedFile);
  feed.coverage.toolsListed += 1;
  await writeFile(feedFile, `${JSON.stringify(feed)}\n`);
  const tampered = await verifyManifest(dataDir, { hashesOnly: true });
  assert.equal(tampered.ok, false);
  assert.deepEqual(tampered.problems, ["feed.json: does not match its sha256 in the manifest"]);
  assert.equal(tampered.matched, 5);
  assert.match(describeVerification(tampered), /NOT VERIFIED/);
});

test("verify finds a file missing, and a manifest edited to match a changed file still fails its signature check", async () => {
  const dataDir = await scanned();
  await writeFile(path.join(dataDir, "servers.json"), "[]\n");
  const manifestFile = path.join(dataDir, "manifest.json");
  const manifest = await readJson<Manifest>(manifestFile);
  // Someone rewrites the manifest to cover the change: the hashes now agree, so only the signature can catch it.
  for (const file of manifest.files) if (file.path === "servers.json") Object.assign(file, { sha256: sha256("[]\n"), bytes: 3 });
  manifest.files.push({ path: "lists/zz/gone.json", sha256: "0".repeat(64), bytes: 1 });
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(path.join(dataDir, "manifest.sigstore.json"), "{}");

  const cosign: RunCosign = async () => ({ code: 1, output: "Error: none of the expected identities matched what was in the certificate\nmain.go:74: error during command execution: invalid signature when validating ASN.1 encoded signature" });
  const result = await verifyManifest(dataDir, { cosign });
  assert.equal(result.ok, false);
  assert.equal(result.signature, "failed");
  assert.ok(result.problems.includes("lists/zz/gone.json: missing"));
  assert.ok(result.problems.some((problem) => problem.startsWith("The signature did not verify")));
});

test("verify asks cosign for the Track workflow's identity on main, GitHub's issuer, and the scanner commit the manifest names", async () => {
  const dataDir = await scanned();
  await writeFile(path.join(dataDir, "manifest.sigstore.json"), "{}");
  let given: string[] = [];
  const cosign: RunCosign = async (args) => { given = args; return { code: 0, output: "Verified OK" }; };
  const result = await verifyManifest(dataDir, { cosign });
  assert.equal(result.ok, true, result.problems.join("; "));
  assert.equal(result.signature, "verified");
  assert.deepEqual(given, [
    "verify-blob", "--bundle", path.join(dataDir, "manifest.sigstore.json"),
    "--certificate-identity", "https://github.com/Stackduke/mcp-scanner/.github/workflows/track.yml@refs/heads/main",
    "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
    "--certificate-github-workflow-sha", commit,
    path.join(dataDir, "manifest.json"),
  ]);
  assert.equal(signerIdentity("someone/fork"), "https://github.com/someone/fork/.github/workflows/track.yml@refs/heads/main");
  assert.equal(githubIssuer, "https://token.actions.githubusercontent.com");
});

test("verify says so when the manifest is not signed yet, or cosign is not installed", async () => {
  const dataDir = await scanned();
  const unsigned = await verifyManifest(dataDir, { cosign: async () => assert.fail("cosign is not run without a signature") });
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.signature, "missing");

  await writeFile(path.join(dataDir, "manifest.sigstore.json"), "{}");
  const noCosign = await verifyManifest(dataDir, { cosign: async () => ({ code: 127, output: "cosign was not found" }) });
  assert.equal(noCosign.ok, false);
  assert.ok(noCosign.problems.some((problem) => problem.startsWith("cosign was not found")));
});

test("a new manifest drops the previous scan's signature, which belonged to the old one", async () => {
  const dataDir = await scanned();
  await writeFile(path.join(dataDir, "manifest.sigstore.json"), "{}");
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now) + day);
  await assert.rejects(readFile(path.join(dataDir, "manifest.sigstore.json")), { code: "ENOENT" });
});

test("a manifest is read with nothing taken on trust: no path may leave the data folder", () => {
  const base = { version: 1, methodVersion: "1.0.0", scanner: { commit }, files: [] as unknown[] };
  assert.equal(typeof readManifest(base), "object");
  for (const bad of ["../outside.json", "/etc/passwd", "lists/../../x", "lists\\x", "lists//x", ""]) {
    assert.equal(typeof readManifest({ ...base, files: [{ path: bad, sha256: "a".repeat(64), bytes: 1 }] }), "string", bad);
  }
  assert.equal(typeof readManifest({ ...base, files: [{ path: "feed.json", sha256: "abc", bytes: 1 }] }), "string", "a short hash is not enough");
  assert.equal(typeof readManifest({ ...base, version: 2 }), "string");
});

test("docs/METHOD.md has an entry for the current method version", async () => {
  const method = await readFile(new URL("../docs/METHOD.md", import.meta.url), "utf8");
  assert.match(method, new RegExp(`^## ${methodVersion.replaceAll(".", "\\.")} `, "m"));
});
