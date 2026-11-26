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
import { endpointId } from "../src/tracker.ts";

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
const listV1 = `${JSON.stringify({ source: urlA, takenAt: "2026-10-20T10:00:00.000Z", tools: [{ name: "one", kind: "read" }] })}\n`;
const listV2 = `${JSON.stringify({ source: urlA, takenAt: "2026-10-25T10:00:00.000Z", tools: [{ name: "one", kind: "read" }, { name: "two", kind: "write" }] })}\n`;
const endpointA = { id: idA, url: urlA, names: ["com.example/a"], firstSeen: "2026-10-20T10:00:00.000Z", inRegistry: true, checks: [], changes: [], file: listA };
const privateEndpoint = { id: "signed-in-stripe", url: "https://mcp.stripe.com", names: [], signedIn: "stripe", firstSeen: "2026-10-20T10:00:00.000Z", inRegistry: false, checks: [], changes: [], file: privateList };

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
    "endpoints.jsonl": `${JSON.stringify(endpointA)}\n${JSON.stringify(privateEndpoint)}\n`,
    [listA]: listV1,
    [privateList]: `${JSON.stringify({ source: "https://mcp.stripe.com", tools: [{ name: "create_refund", kind: "money" }] })}\n`,
    "watched/stripe.json": "{\"tools\":[]}\n",
    "feed.json": `${JSON.stringify({ version: 1, watched: [{ id: "signed-in-stripe", vendor: "stripe" }, { id: idA, vendor: "example" }], changes: [] })}\n`,
    "servers.json": `${JSON.stringify([{ id: idA, url: urlA }])}\n`,
    "registry.json": "{}\n",
  });
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Scan 2026-10-20"], "2026-10-20T10:05:00Z");
  await rm(path.join(repo, "watched"), { recursive: true });
  await rm(path.join(repo, privateList));
  await put({
    "endpoints.jsonl": `${JSON.stringify(endpointA)}\n`,
    [listA]: listV2,
    "feed.json": `${JSON.stringify({ version: 1, watched: [{ id: idA, vendor: "example" }], changes: [] })}\n`,
    "lookup.json": "{\"version\":1,\"rows\":[]}\n",
  });
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "Scan 2026-10-25"], "2026-10-25T10:05:00Z");
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
  const scanFiles = (id: string, names: string[]) => names.map((name) => `scans/${id}/${name}`);
  assert.deepEqual(await allFiles(out), [
    "latest.json",
    listKey(idA, sha(listV1)),
    listKey(idA, sha(listV2)),
    ...scanFiles(first, ["endpoints.jsonl.gz", "feed.json", "lists.jsonl.gz", "registry.json", "scan.json", "servers.json"]),
    ...scanFiles(second, ["endpoints.jsonl.gz", "feed.json", "lists.jsonl.gz", "lookup.json", "registry.json", "scan.json", "servers.json"]),
  ].sort());
  for (const key of await allFiles(out)) assert.ok(isLayoutKey(key), key);

  const pointer = JSON.parse(await readFile(path.join(out, "latest.json"), "utf8"));
  assert.deepEqual([pointer.scan, pointer.scans], [second, [second, first]]);
  const record = JSON.parse(await readFile(path.join(out, "scans", second, "scan.json"), "utf8"));
  assert.equal(record.source.kind, "data-branch");
  assert.deepEqual(record.lists, { current: 1, written: [listKey(idA, sha(listV2))] });
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
    assert.doesNotMatch(text, /stripe|signed-in/, key);
  }
  assert.match(lines.join("\n"), /records about servers tracked privately left out/);
  assert.doesNotMatch(lines.join("\n"), /stripe/);

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
  assert.match(lines.join("\n"), /2 scans planned/);
  assert.deepEqual(await allFiles(out), outBefore);
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"]).toString(), "");
  // A ref that git would read as an option is refused before git runs.
  await assert.rejects(radarMain(["backfill", `--repo=${repo}`, "--ref=--output=written-by-git", "--dry-run"], { log: () => undefined }), /Not a branch or ref name/);
});
