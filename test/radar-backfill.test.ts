import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { radarMain } from "../src/radar-cli.ts";
import { isLayoutKey, listKey } from "../src/radar-layout.ts";
import { buildManifest, writeManifest } from "../src/manifest.ts";
import { endpointId, lookupOf } from "../src/tracker.ts";
import type { FeedServer } from "../src/tracker.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const temporary: string[] = [];
after(async () => { for (const folder of temporary) await rm(folder, { recursive: true, force: true }); });
async function folder(): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), "radar-backfill-"));
  temporary.push(made);
  return made;
}

const urlA = "https://a.example.com/mcp";
const idA = endpointId(urlA);
const listA = `lists/${idA.slice(0, 2)}/a.example.com-${idA}.json`;
const privateList = "lists/si/mcp.stripe.com-signed-in-stripe.json";
/** A list a private record names, at a path that does not say so: left out because the record names it. */
const privateNamedList = "lists/77/mcp.stripe.com-777777777777.json";
/** A list no endpoint names any more: still public, kept under the id in its name. */
const orphanList = "lists/cc/gone.example.com-cccccccccccc.json";
const orphanText = `${JSON.stringify({ source: "https://gone.example.com/mcp", tools: [] })}\n`;
const listV1 = `${JSON.stringify({ source: urlA, takenAt: "2026-10-20T10:00:00.000Z", tools: [{ name: "one", kind: "read" }] })}\n`;
const listV2 = `${JSON.stringify({ source: urlA, takenAt: "2026-10-25T10:00:00.000Z", tools: [{ name: "one", kind: "read" }, { name: "two", kind: "write" }] })}\n`;
const endpointA = { id: idA, url: urlA, names: ["com.example/a"], firstSeen: "2026-10-20T10:00:00.000Z", inRegistry: true, checks: [], changes: [], file: listA };
/** On a site whose terms forbid publishing about it: on the branch as a public endpoint from 16 to 23 October. */
const sentryUrl = "https://mcp.sentry.dev/mcp";
const sentryId = endpointId(sentryUrl);
const sentryList = `lists/${sentryId.slice(0, 2)}/mcp.sentry.dev-${sentryId}.json`;
const sentryEndpoint = { id: sentryId, url: sentryUrl, names: ["io.sentry/mcp"], firstSeen: "2026-10-16T18:06:47.641Z", inRegistry: true, checks: [], changes: [], file: sentryList };
const serverRow = (id: string, url: string, extra: object = {}) => ({ id, url, names: [], firstSeen: "2026-10-20T10:00:00.000Z", tools: 1, kinds: { read: 1 }, lastChecked: "2026-10-20T10:00:00.000Z", lastListed: "2026-10-20T10:00:00.000Z", outcome: "listed", changesIn30Days: 0, watchIn30Days: 0, ...extra });
const lookupText = (rows: object[]) => `${JSON.stringify({ version: 1, generatedAt: "2026-10-20T10:00:00.000Z", rows: lookupOf(rows as FeedServer[]) })}\n`;
const privateEndpoint = { id: "signed-in-stripe", url: "https://mcp.stripe.com", names: [], signedIn: "stripe", firstSeen: "2026-10-20T10:00:00.000Z", inRegistry: false, checks: [], changes: [], file: privateNamedList };

/** A data branch like the real one: a first commit with a README, a scan that still held a private server, and a later one without. */
async function dataBranch(): Promise<string> {
  const repo = await folder();
  const git = (args: string[], date?: string) => execFileSync("git", ["-C", repo, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com", ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
  const put = async (files: Record<string, string>) => {
    for (const [relative, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
      await writeFile(path.join(repo, relative), text);
    }
  };
  git(["init", "-q", "-b", "data"]);
  await put({ "README.md": "data\n" });
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Data branch"], "2026-10-16T17:33:42Z");
  await put({
    "endpoints.jsonl": `${JSON.stringify(endpointA)}\n${JSON.stringify(privateEndpoint)}\n${JSON.stringify(sentryEndpoint)}\n`,
    [listA]: listV1,
    [sentryList]: `${JSON.stringify({ source: sentryUrl, tools: [{ name: "find_issues", kind: "read" }] })}\n`,
    // A kept-off list no record names: left out by the host in its name.
    "lists/ee/eu.sentry.io-eeeeeeeeeeee.json": `${JSON.stringify({ source: "https://eu.sentry.io/mcp", tools: [] })}\n`,
    [privateList]: `${JSON.stringify({ source: "https://mcp.stripe.com", tools: [{ name: "create_refund", kind: "money" }] })}\n`,
    [privateNamedList]: `${JSON.stringify({ source: "https://mcp.stripe.com", tools: [{ name: "create_refund", kind: "money" }] })}\n`,
    [orphanList]: orphanText,
    "watched/stripe.json": "{\"tools\":[]}\n",
    "feed.json": `${JSON.stringify({ version: 1, watched: [{ id: "signed-in-stripe", vendor: "stripe" }, { id: idA, vendor: "example" }], changes: [] })}\n`,
    "servers.json": `${JSON.stringify([serverRow(idA, urlA), serverRow("signed-in-stripe", "https://mcp.stripe.com", { signedIn: "stripe" }), serverRow(sentryId, sentryUrl)])}\n`,
    "lookup.json": lookupText([serverRow(idA, urlA), serverRow("signed-in-stripe", "https://mcp.stripe.com", { signedIn: "stripe" }), serverRow(sentryId, sentryUrl)]),
    "registry.json": "{}\n",
  });
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Scan 2026-10-20"], "2026-10-20T10:05:00Z");
  await rm(path.join(repo, "watched"), { recursive: true });
  await rm(path.join(repo, privateList));
  await rm(path.join(repo, privateNamedList));
  await rm(path.join(repo, sentryList));
  await rm(path.join(repo, "lists/ee/eu.sentry.io-eeeeeeeeeeee.json"));
  await put({
    "servers.json": `${JSON.stringify([serverRow(idA, urlA)])}\n`,
    "hosts.json": `${JSON.stringify({ version: 1, hosts: { "a.example.com": { overBudgetRuns: 0 } } })}\n`,
    "endpoints.jsonl": `${JSON.stringify(endpointA)}\n`,
    [listA]: listV2,
    "feed.json": `${JSON.stringify({ version: 1, watched: [{ id: idA, vendor: "example" }], changes: [] })}\n`,
    "lookup.json": lookupText([serverRow(idA, urlA)]),
  });
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Scan 2026-10-25"], "2026-10-25T10:05:00Z");
  // Since manifests: a scan's commit, then the commit adding its signature. Then a scan whose signing failed.
  const scanWithManifest = async (scanStartedAt: string, committedAt: string) => {
    await put({ "registry.json": `${JSON.stringify({ readAt: scanStartedAt })}\n` });
    await writeManifest(repo, await buildManifest({ dataDir: repo, written: ["registry.json"], scanStartedAt, generatedAt: scanStartedAt, registry: { readAt: scanStartedAt, attemptedAt: scanStartedAt, attemptOk: true }, previous: { verified: false, reason: "no manifest" }, environment: {} }));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "Scan"], committedAt);
  };
  await scanWithManifest("2026-11-26T04:17:00.000Z", "2026-11-26T05:00:00Z");
  await put({ "manifest.sigstore.json": "{\"bundle\":true}\n" });
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Sign scan"], "2026-11-26T05:02:00Z");
  await scanWithManifest("2026-11-27T04:17:00.000Z", "2026-11-27T05:00:00Z");
  return repo;
}

async function allFiles(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await allFiles(root, child)));
    else found.push(child);
  }
  return found.sort();
}

test("backfill turns the data branch's history into the layout, leaving out private servers, and never changes the branch", async () => {
  const repo = await dataBranch();
  const refsBefore = execFileSync("git", ["-C", repo, "show-ref"]).toString();
  const out = await folder();
  const lines: string[] = [];
  assert.equal(await radarMain(["backfill", `--repo=${repo}`, "--ref=data", `--to-folder=${out}`], { log: (line) => lines.push(line), now: () => new Date("2026-11-26T00:00:00Z") }), 0);

  const first = "2026-10-20T100500Z", second = "2026-10-25T100500Z";
  // Named by the manifest's start time, not the commit's: the scan and its signing commit are one scan.
  const signed = "2026-11-26T041700Z", unsigned = "2026-11-27T041700Z";
  const scanFiles = (id: string, names: string[]) => names.map((name) => `scans/${id}/${name}`);
  const snapshotFiles = (id: string, names: string[]) => names.map((name) => `snapshots/${id}/${name}`);
  const bulk = ["endpoints.jsonl.gz", "feed.json", "lists.jsonl.gz", "registry.json", "servers.json"];
  const later = [...bulk, "lookup.json", "hosts.json"];
  assert.deepEqual(await allFiles(out), [
    "latest.json",
    listKey(idA, sha(listV1)),
    listKey(idA, sha(listV2)),
    listKey("cccccccccccc", sha(orphanText)),
    ...scanFiles(first, ["scan.json"]),
    ...snapshotFiles(first, [...bulk, "lookup.json"]),
    ...scanFiles(second, ["scan.json"]),
    ...snapshotFiles(second, later),
    ...scanFiles(signed, ["manifest.json", "manifest.sigstore.json", "scan.json"]),
    ...snapshotFiles(signed, later),
    ...scanFiles(unsigned, ["manifest.json", "scan.json"]),
    ...snapshotFiles(unsigned, later),
  ].sort());
  for (const key of await allFiles(out)) assert.ok(isLayoutKey(key), key);

  const pointer = JSON.parse(await readFile(path.join(out, "latest.json"), "utf8"));
  assert.deepEqual([pointer.scan, pointer.scans], [unsigned, [unsigned, signed, second, first]]);
  const signedRecord = JSON.parse(await readFile(path.join(out, "scans", signed, "scan.json"), "utf8"));
  assert.equal(signedRecord.signed, true);
  assert.equal(signedRecord.source.scanStartedAt, "2026-11-26T04:17:00.000Z");
  assert.equal(JSON.parse(await readFile(path.join(out, "scans", unsigned, "scan.json"), "utf8")).signed, false);
  const record = JSON.parse(await readFile(path.join(out, "scans", second, "scan.json"), "utf8"));
  assert.equal(record.source.kind, "data-branch");
  assert.deepEqual(record.lists, { current: 2, written: [listKey(idA, sha(listV2))] });
  // Every file's recorded sha256 is of what is there.
  for (const file of record.files as Array<{ key: string; sha256: string }>) {
    const bytes = await readFile(path.join(out, file.key));
    assert.equal(sha(file.key.endsWith(".gz") ? gunzipSync(bytes) : bytes), file.sha256, file.key);
  }
  assert.equal(await readFile(path.join(out, listKey(idA, sha(listV1))), "utf8"), listV1);

  // Nothing about the private server, anywhere in the output, compressed or not.
  for (const key of await allFiles(out)) {
    const bytes = await readFile(path.join(out, key));
    const text = (key.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
    assert.doesNotMatch(text, /stripe|signed-in|sentry/, key);
  }
  assert.match(lines.join("\n"), /records about servers tracked privately or kept off left out/);
  assert.doesNotMatch(lines.join("\n"), /stripe|sentry/);
  // The first scan's lookup is made again from the servers it keeps.
  const firstLookup = JSON.parse(await readFile(path.join(out, "snapshots", first, "lookup.json"), "utf8"));
  assert.deepEqual(firstLookup.rows, lookupOf([serverRow(idA, urlA)] as unknown as FeedServer[]));

  // The branch is as it was, and a second run finds everything in place.
  assert.equal(execFileSync("git", ["-C", repo, "show-ref"]).toString(), refsBefore);
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"]).toString(), "");
  lines.length = 0;
  assert.equal(await radarMain(["backfill", `--repo=${repo}`, "--ref=data", `--to-folder=${out}`], { log: (line) => lines.push(line) }), 0);
  assert.match(lines.join("\n"), /0 objects written/);

  // A dry run prints a plan per scan, and changes neither the repository nor the output.
  const outBefore = await allFiles(out);
  lines.length = 0;
  assert.equal(await radarMain(["backfill", `--repo=${repo}`, "--ref=data", "--dry-run"], { log: (line) => lines.push(line) }), 0);
  assert.match(lines.join("\n"), /4 scans planned/);
  assert.deepEqual(await allFiles(out), outBefore);
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"]).toString(), "");
  // A ref that git would read as an option is refused before git runs.
  await assert.rejects(radarMain(["backfill", `--repo=${repo}`, "--ref=--output=written-by-git", "--dry-run"], { log: () => undefined }), /Not a branch or ref name/);
});

test("a commit with a manifest that would need filtering is refused, not published altered", async () => {
  const repo = await folder();
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } });
  git(["init", "-q", "-b", "data"]);
  await writeFile(path.join(repo, "endpoints.jsonl"), `${JSON.stringify(endpointA)}\n${JSON.stringify(privateEndpoint)}\n`);
  const at = "2026-11-26T04:17:00.000Z";
  await writeManifest(repo, await buildManifest({ dataDir: repo, written: ["endpoints.jsonl"], scanStartedAt: at, generatedAt: at, registry: { readAt: at, attemptedAt: at, attemptOk: true }, previous: { verified: false, reason: "no manifest" }, environment: {} }));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Scan"]);
  await assert.rejects(radarMain(["backfill", `--repo=${repo}`, "--ref=data", "--dry-run"], { log: () => undefined }), /cannot be published as signed/);
});
