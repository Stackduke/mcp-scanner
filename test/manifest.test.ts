import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { checkBeforeSigning, describeVerification, folderDigest, githubIssuer, readManifest, readNameStatus, signerIdentity, unaccountedChanges, verifyManifest } from "../src/manifest.ts";
import type { Manifest, RunCosign } from "../src/manifest.ts";
import { methodVersion } from "../src/method.ts";
import { takeSnapshot } from "../src/snapshot.ts";
import { dataAttributes, track } from "../src/track.ts";
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

async function run(dataDir: string, tools: () => ToolDefinition[], at: number, cosign?: RunCosign) {
  return track({ dataDir, readRegistry: true, maxChecks: 10, perHost: 5, perSite: 50, concurrency: 2, hostGapMs: 0, budgetMinutes: 5, publicServers: [], environment, fetchImpl: fakeNetwork(tools), now: () => new Date(at), ...(cosign ? { cosign } : {}) });
}

/** cosign as it answers a signature that verifies. */
const verifies: RunCosign = async () => ({ code: 0, output: "Verified OK" });
/** What the sign job does, as far as these tests need: a signature next to the manifest. */
const sign = (dataDir: string) => writeFile(path.join(dataDir, "manifest.sigstore.json"), "{}");

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
  assert.deepEqual(manifest.previous, { verified: false, reason: "no manifest" }, "the first scan had nothing signed to start from");

  // One endpoint, so endpoints.jsonl is one line of JSON.
  const listFile = (await readJson<Endpoint>(path.join(dataDir, "endpoints.jsonl"))).file as string;
  assert.deepEqual(manifest.files.map((file) => file.path), [".gitattributes", "endpoints.jsonl", "feed.json", listFile, "lookup.json", "registry.json", "servers.json"].sort());
  assert.equal(await readFile(path.join(dataDir, ".gitattributes"), "utf8"), "* text eol=lf\n");
  assert.equal(dataAttributes, "* text eol=lf\n");
  for (const file of manifest.files) {
    const text = await readFile(path.join(dataDir, file.path), "utf8");
    assert.equal(file.sha256, sha256(text), `${file.path}: the full sha256 of what is on disk`);
    assert.equal(file.bytes, Buffer.byteLength(text));
  }
  assert.ok(!manifest.files.some((file) => file.path.startsWith("manifest")), "the manifest does not list itself or its signature");

  // The folder's digest is what sha256sum gives, as docs/verify-a-scan.md says, so it can be checked by hand.
  const byHand = execFileSync("bash", ["-c", "find . -path ./.git -prune -o -type f -print | sed 's|^\\./||' | grep -vxE 'manifest\\.json|manifest\\.sigstore\\.json' | LC_ALL=C sort | xargs -d '\\n' sha256sum | sha256sum | cut -d' ' -f1"], { cwd: dataDir, encoding: "utf8" }).trim();
  assert.deepEqual(manifest.tree, { files: 7, sha256: byHand });
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

/** A folder as the daily workflow leaves it: a signed scan, then the next scan, started from it. */
async function scanned(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "manifest-"));
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now) - day);
  await sign(dataDir);
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now), verifies);
  return dataDir;
}

test("verify passes on the folder a scan wrote, and finds a file changed afterwards", async () => {
  const dataDir = await scanned();
  const good = await verifyManifest(dataDir, { hashesOnly: true });
  assert.equal(good.ok, true, good.problems.join("; "));
  assert.equal(good.matched, 5);
  assert.equal(good.signature, "not checked");
  assert.match(describeVerification(good), /Hashes OK: all 7 files match the manifest\. The signature was not checked/);

  const feedFile = path.join(dataDir, "feed.json");
  const feed = await readJson<Feed>(feedFile);
  feed.coverage.toolsListed += 1;
  await writeFile(feedFile, `${JSON.stringify(feed)}\n`);
  const tampered = await verifyManifest(dataDir, { hashesOnly: true });
  assert.equal(tampered.ok, false);
  assert.deepEqual(tampered.problems, ["feed.json: does not match its sha256 in the manifest", "The folder does not match the manifest's digest of it (7 files here, 7 when the scan ended): a file was changed, added or removed since."]);
  assert.equal(tampered.matched, 4);
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
  assert.equal(noCosign.signature, "not checked", "a missing cosign is not a bad signature");
  assert.ok(noCosign.problems.some((problem) => problem.startsWith("cosign was not found")));
});

test("a new manifest drops the previous scan's signature, which belonged to the old one", async () => {
  const dataDir = await scanned();
  await writeFile(path.join(dataDir, "manifest.sigstore.json"), "{}");
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now) + day);
  await assert.rejects(readFile(path.join(dataDir, "manifest.sigstore.json")), { code: "ENOENT" });
});

test("a manifest is read with nothing taken on trust: no path may leave the data folder", () => {
  const base = { version: 1, methodVersion: "1.0.0", scanner: { commit }, previous: { verified: true }, tree: { files: 0, sha256: "b".repeat(64) }, files: [] as unknown[] };
  assert.equal(typeof readManifest(base), "object");
  assert.equal(typeof readManifest({ ...base, tree: undefined }), "string", "a manifest must cover the whole folder");
  assert.equal(typeof readManifest({ ...base, previous: undefined }), "string", "and say whether it started from a signed one");
  assert.equal(typeof readManifest({ ...base, previous: { verified: false, reason: "lists/xx/a-vendor.json: missing" } }), "string", "in fixed words only");
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

test("a file the latest scan did not write is still checked: changing, adding or removing any file fails, at HEAD", async () => {
  const dataDir = await scanned();
  const listFile = path.join(dataDir, (await readJson<Endpoint>(path.join(dataDir, "endpoints.jsonl"))).file as string);
  const manifest = await readJson<Manifest>(path.join(dataDir, "manifest.json"));
  assert.ok(!manifest.files.some((file) => listFile.endsWith(file.path)), "the latest scan did not write the list");
  assert.equal((await verifyManifest(dataDir, { hashesOnly: true })).ok, true);

  const list = await readFile(listFile, "utf8");
  await writeFile(listFile, list.replace(/"takenAt":"[^"]+"/, '"takenAt":"2026-01-01T00:00:00.000Z"'));
  const edited = await verifyManifest(dataDir, { hashesOnly: true });
  assert.equal(edited.ok, false, "an edit to a file this scan did not write is caught");
  assert.match(edited.problems.join(" "), /does not match the manifest's digest/);
  await writeFile(listFile, list);
  assert.equal((await verifyManifest(dataDir, { hashesOnly: true })).ok, true, "put back as it was, it passes again");

  await writeFile(path.join(dataDir, "lists", "extra.json"), "{}\n");
  assert.equal((await verifyManifest(dataDir, { hashesOnly: true })).ok, false, "an added file is caught");
  await rm(path.join(dataDir, "lists", "extra.json"));
  await rm(listFile);
  assert.equal((await verifyManifest(dataDir, { hashesOnly: true })).ok, false, "a removed file is caught");
});

test("a file changed between two scans does not become part of what the next scan signs: that scan records it, signed", async () => {
  const dataDir = await scanned();
  await sign(dataDir);
  const listFile = path.join(dataDir, (await readJson<Endpoint>(path.join(dataDir, "endpoints.jsonl"))).file as string);
  const list = await readJson<ListPrint>(listFile);
  // Someone with push access edits a list the next scan will not rewrite (its server's tools have not changed).
  await writeFile(listFile, `${JSON.stringify({ ...list, takenAt: "2026-01-01T00:00:00.000Z", server: { name: "Someone else" } })}\n`);
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now) + day, verifies);
  const manifest = await readJson<Manifest>(path.join(dataDir, "manifest.json"));
  assert.equal(manifest.previous.verified, false);
  assert.equal(manifest.previous.reason, "folder changed since that scan");
  assert.equal(manifest.previous.run, "9876543210");

  await sign(dataDir);
  const atHead = await verifyManifest(dataDir, { cosign: verifies, now: new Date(Date.parse(now) + day) });
  assert.equal(atHead.ok, false, "verify at HEAD does not say OK");
  assert.equal(atHead.signature, "verified");
  assert.match(describeVerification(atHead), /The scan started from a folder that was not exactly a signed scan's \(folder changed since that scan\)/);
  // The workflow still publishes this scan's signature: its folder and signature are sound, and the next scan needs a signed start.
  const thisScan = await verifyManifest(dataDir, { cosign: verifies, thisScanOnly: true });
  assert.equal(thisScan.ok, true);
  // Its OK line claims only what was checked: never a clean start it did not have.
  assert.doesNotMatch(describeVerification(thisScan), /started from the signed scan/);
  assert.match(describeVerification(thisScan), /Its start was not checked here \(--this-scan-only\)\. The scan recorded that the folder it started from was not exactly a signed scan's: folder changed since that scan\./);

  // The next scan starts from that signed folder, unchanged, so it is clean again; the record above stays in history.
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now) + 2 * day, verifies);
  assert.equal((await readJson<Manifest>(path.join(dataDir, "manifest.json"))).previous.verified, true);
});

test("the start check says why the folder was not a signed scan's, in fixed words", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "manifest-"));
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now) - day);
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now), verifies);
  assert.equal((await readJson<Manifest>(path.join(dataDir, "manifest.json"))).previous.reason, "not signed");
  await sign(dataDir);
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now) + day, async () => ({ code: 1, output: "Error: invalid signature" }));
  assert.equal((await readJson<Manifest>(path.join(dataDir, "manifest.json"))).previous.reason, "signature did not verify");
});

test("the digest leaves out the manifest, its signature and .git, and refuses a link", async () => {
  const dataDir = await scanned();
  const before = await folderDigest(dataDir);
  await mkdir(path.join(dataDir, ".git"));
  await writeFile(path.join(dataDir, ".git", "HEAD"), "ref: refs/heads/data\n");
  await writeFile(path.join(dataDir, "manifest.sigstore.json"), "{}");
  assert.deepEqual(await folderDigest(dataDir), before);
  execFileSync("ln", ["-s", "/etc/hostname", path.join(dataDir, "lists", "link.json")]);
  const linked = await verifyManifest(dataDir, { hashesOnly: true });
  assert.ok(linked.problems.includes("lists/link.json: not a plain file"));
});

test("a signed result says exactly what it shows and what it does not, and an old scan is pointed out", async () => {
  const dataDir = await scanned();
  await writeFile(path.join(dataDir, "manifest.sigstore.json"), "{}");
  const fresh = await verifyManifest(dataDir, { cosign: async () => ({ code: 0, output: "Verified OK" }), now: new Date(Date.parse(now) + 3_600_000) });
  const text = describeVerification(fresh);
  assert.match(text, /OK: all 7 files in this folder are exactly as run 9876543210 of Stackduke\/mcp-scanner's Track workflow left them, at scanner commit 0123456789abcdef0123456789abcdef01234567, in the scan started 2026-11-26T04:17:00\.000Z\./);
  assert.match(text, /Not shown: that this is the latest scan, that the code at that commit was reviewed, or that the scanner read each server correctly\./);
  assert.doesNotMatch(text, /Note:/);

  const old = await verifyManifest(dataDir, { cosign: async () => ({ code: 0, output: "Verified OK" }), now: new Date(Date.parse(now) + 5 * day) });
  assert.equal(old.ok, true, "an old scan is still validly signed");
  assert.match(describeVerification(old), /Note: This scan is 5 days old\. An older scan stays validly signed, so check that its date and run ID are the scan you expect/);
});

test("before signing, a scan's commit may change only what its manifest accounts for", () => {
  const manifest = { files: [{ path: "feed.json" }, { path: "lists/ab/x.json" }] } as Manifest;
  const changes = readNameStatus("M\0feed.json\0A\0lists/ab/x.json\0M\0manifest.json\0D\0manifest.sigstore.json\0D\0lists/cd/moved.json\0D\0watched/vendor.json\0");
  assert.deepEqual(unaccountedChanges(manifest, changes), []);
  const extra = readNameStatus("M\0lists/ef/other.json\0A\0notes.txt\0D\0README.md\0T\0feed.json\0");
  assert.deepEqual(unaccountedChanges(manifest, extra), ["M lists/ef/other.json", "A notes.txt", "D README.md", "T feed.json"]);
});

test("the check before signing refuses another run's manifest and a commit with an unlisted change, using git itself", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "manifest-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dataDir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "-q");
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now) - day);
  git("add", "-A"); git("commit", "-q", "-m", "first");
  await run(dataDir, () => [{ name: "get_page", ...readOnly }, { name: "send_invoice" }], Date.parse(now));
  git("add", "-A"); git("commit", "-q", "-m", "scan");
  assert.deepEqual(await checkBeforeSigning(dataDir, "9876543210"), []);
  assert.deepEqual(await checkBeforeSigning(dataDir, "1"), ["The manifest is from run 9876543210, not this run (1)."]);

  // Something else rides along in the scan's commit: a file the scan never wrote, and the manifest edited to cover it.
  await writeFile(path.join(dataDir, "README.md"), "changed\n");
  const manifest = await readJson<Manifest>(path.join(dataDir, "manifest.json"));
  manifest.tree = { files: (await folderDigest(dataDir)).files, sha256: (await folderDigest(dataDir)).sha256 };
  await writeFile(path.join(dataDir, "manifest.json"), JSON.stringify(manifest));
  git("add", "-A"); git("commit", "-q", "--amend", "-m", "scan");
  assert.deepEqual(await checkBeforeSigning(dataDir, "9876543210"), ["The commit has a change the manifest does not account for: A README.md"]);
});

test("a scan without cosign records its start as not checked, never as a signature that did not verify", async () => {
  const dataDir = await scanned();
  await sign(dataDir);
  await run(dataDir, () => [{ name: "get_page", ...readOnly }], Date.parse(now) + day, async () => ({ code: 127, output: "cosign was not found" }));
  assert.deepEqual((await readJson<Manifest>(path.join(dataDir, "manifest.json"))).previous.reason, "not checked");
});

test("a link in the data folder is removed, never followed, and the scan still publishes, recording an unclean start", async () => {
  const dataDir = await scanned();
  await sign(dataDir);
  const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
  const listFile = (await readJson<Endpoint>(path.join(dataDir, "endpoints.jsonl"))).file as string;
  // A link in place of a list's folder would send the scan's writes outside the data folder; another stands alone.
  const listFolder = path.join(dataDir, path.dirname(listFile));
  await rm(listFolder, { recursive: true });
  execFileSync("ln", ["-s", outside, listFolder]);
  execFileSync("ln", ["-s", "/etc/hostname", path.join(dataDir, "stray.json")]);

  await run(dataDir, () => [{ name: "get_page", ...readOnly }, { name: "send_invoice" }], Date.parse(now) + day, verifies);
  const manifest = await readJson<Manifest>(path.join(dataDir, "manifest.json"));
  assert.deepEqual(manifest.previous.reason, "folder changed since that scan");
  assert.deepEqual(await readdir(outside), [], "nothing was written through the link");
  assert.deepEqual((await folderDigest(dataDir)).others, [], "both links are gone");
  assert.ok(manifest.files.some((file) => file.path === listFile), "the list was written inside the folder again");
  await sign(dataDir);
  assert.equal((await verifyManifest(dataDir, { cosign: verifies, thisScanOnly: true })).ok, true, "and the scan's own folder verifies");
});

test("a published server's watched definitions are listed in the manifest, so the check before signing accepts them", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "manifest-"));
  const servers = { demo: { url: "https://mcp.demo.example/mcp", tokenVariable: "STACKDUKE_SCAN_DEMO_TOKEN", publish: true, kind: "api-key" as const, keyPage: "https://demo.example/keys", keyAdvice: "A read-only key." } };
  const fetchImpl = (async (_input: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "Demo" } } });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "get_page", ...readOnly }] } });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  await track({ dataDir, readRegistry: false, maxChecks: 10, perHost: 5, perSite: 50, concurrency: 2, hostGapMs: 0, budgetMinutes: 5, publicServers: [], environment: { ...environment, STACKDUKE_SCAN_DEMO_TOKEN: "demo-token" }, fetchImpl, now: () => new Date(now), signedInServers: servers });
  const manifest = await readJson<Manifest>(path.join(dataDir, "manifest.json"));
  const watched = manifest.files.find((file) => file.path === "watched/demo.json");
  assert.ok(watched, "the watched file is listed");
  assert.equal(watched.sha256, sha256(await readFile(path.join(dataDir, "watched", "demo.json"), "utf8")));
  assert.deepEqual(unaccountedChanges(manifest, [{ status: "A", path: "watched/demo.json" }]), []);
});
