import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { manifestName, readManifest, signatureName, verifyManifest } from "./manifest.ts";
import type { RunCosign } from "./manifest.ts";
import { isKeptOff, isPrivateRecord, listVerdict, scanIdOf } from "./radar-layout.ts";
import { lookupOf } from "./tracker.ts";
import type { FeedServer } from "./tracker.ts";
import type { ScanInput } from "./radar-layout.ts";

/**
 * The data branch's history, one scan per commit, in the bucket's layout. It only reads the repository (git log,
 * ls-tree and cat-file); the branch is never checked out, changed or deleted.
 *
 * Before 24 October 2026 the branch also held servers that are now tracked privately (their endpoint records,
 * feed entries, watched/ files and tool lists). Those are left out here: a scan is filtered, then planned like any
 * other, and planning refuses a scan that still holds any. The feed's totals never counted them: the tracker
 * added up public endpoints only. Servers on the sites of vendors whose terms forbid publishing about them (the
 * catalog's kept-off sites; Airtable and Sentry endpoints were on the branch from 16 to 23 October) are left
 * out the same way.
 *
 * Since scans carry a manifest, each one is two commits: the scan's, then the one adding its signature. They
 * are one scan here, named by the manifest's start time, with the signature when there is one. Such a commit is
 * checked as the uploader checks a folder (verifyManifest): its files against the manifest, and the signature
 * with cosign, so `signed` means verified here too. A scan dated in the future is refused, as publish refuses it.
 */
export interface BackfillOptions {
  now?: () => Date;
  /** The repository whose Track workflow must have signed a scan. Default Stackduke/mcp-scanner. */
  repository?: string;
  /** For tests: what runs cosign. */
  cosign?: RunCosign;
}
export interface BackfillScan {
  input: ScanInput;
  /** Endpoint records, feed entries, servers rows and list files left out: about servers tracked privately, or kept off. */
  leftOut: number;
}

function git(repo: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]} failed: ${stderr.toString("utf8").trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

/** Reads blobs by object id, all in one `git cat-file --batch`. */
function readBlobs(repo: string, ids: string[]): Promise<Map<string, Buffer>> {
  if (!ids.length) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited with ${code}`));
      const out = Buffer.concat(chunks);
      const blobs = new Map<string, Buffer>();
      let at = 0;
      while (at < out.length) {
        const end = out.indexOf(10, at);
        const [id, type, size] = out.subarray(at, end).toString("utf8").split(" ");
        if (type !== "blob" || !id || size === undefined) return reject(new Error(`git cat-file could not read ${id}`));
        const length = Number(size);
        blobs.set(id, out.subarray(end + 1, end + 1 + length));
        at = end + 1 + length + 1;
      }
      resolve(blobs);
    });
    child.stdin.end(`${ids.join("\n")}\n`);
  });
}

/** Path to blob id, for every file of a commit. */
async function treeOf(repo: string, commit: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>();
  for (const entry of (await git(repo, ["ls-tree", "-r", "-z", commit])).toString("utf8").split("\0")) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (match) tree.set(match[2] as string, match[1] as string);
  }
  return tree;
}

const tops = ["endpoints.jsonl", "feed.json", "servers.json", "lookup.json", "registry.json", "hosts.json"];

/** A commit's files, written to a new folder exactly as git holds them: `git archive`, unpacked by tar. */
function extract(repo: string, commit: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = spawn("git", ["-C", repo, "archive", "--format=tar", commit], { stdio: ["ignore", "pipe", "ignore"] });
    const untar = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "ignore"] });
    archive.stdout.pipe(untar.stdin);
    let failed = false;
    const fail = (what: string) => { if (!failed) { failed = true; reject(new Error(`${what} failed while reading commit ${commit.slice(0, 12)}`)); } };
    archive.on("error", () => fail("git archive"));
    untar.on("error", () => fail("tar"));
    archive.on("close", (code) => { if (code !== 0) fail("git archive"); });
    untar.on("close", (code) => { if (code !== 0) fail("tar"); else if (!failed) resolve(); });
  });
}

/** Checks a commit's scan against its manifest, and its signature with cosign when it has one; throws if it does not hold. */
async function verifyCommit(repo: string, commit: string, signed: boolean, { repository, cosign }: BackfillOptions): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-backfill-"));
  try {
    await extract(repo, commit, dir);
    const check = await verifyManifest(dir, { hashesOnly: !signed, thisScanOnly: true, ...(repository ? { repository } : {}), ...(cosign ? { cosign } : {}) });
    if (!check.ok) throw new Error(`Commit ${commit.slice(0, 12)} does not match its ${signed ? "signed " : ""}manifest, so nothing more was published: ${check.problems.slice(0, 3).join("; ")}${check.problems.length > 3 ? ` (and ${check.problems.length - 3} more)` : ""}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The scans of a data branch, oldest first. Commits with no endpoints.jsonl (the branch's first) are skipped. */
export async function* backfillScans(repo: string, ref: string, options: BackfillOptions = {}): AsyncGenerator<BackfillScan> {
  const now = options.now ?? (() => new Date());
  // A ref that starts with "-" would reach git as an option (--output=<file> writes a file), so it is refused.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) throw new Error(`Not a branch or ref name: ${ref}`);
  const log = (await git(repo, ["log", "--reverse", "--first-parent", "--format=%H %cI", ref, "--"])).toString("utf8").trim();
  const commits = (log ? log.split("\n") : []).map((line) => line.split(" ") as [string, string]);
  // The manifest's blob in each commit: a commit whose manifest the next commit keeps is followed by its signing commit.
  const manifestIds: Array<string | undefined> = [];
  for (const [commit] of commits) manifestIds.push(/^\d+ blob ([0-9a-f]+)\t/.exec((await git(repo, ["ls-tree", commit, manifestName])).toString("utf8"))?.[1]);
  let previous = new Map<string, string>();
  let cache = new Map<string, Buffer>();
  for (const [index, [commit, committedAt]] of commits.entries()) {
    if (manifestIds[index] && manifestIds[index] === manifestIds[index + 1]) continue;
    const tree = await treeOf(repo, commit);
    if (!tree.has("endpoints.jsonl")) { previous = tree; continue; }

    const listPaths = [...tree.keys()].filter((name) => name.startsWith("lists/") && name.endsWith(".json"));
    const wanted = [...new Set([...[...tops, manifestName, signatureName].flatMap((name) => tree.get(name) ?? []), ...listPaths.map((name) => tree.get(name) as string)])];
    const blobs = await readBlobs(repo, wanted.filter((id) => !cache.has(id)));
    const blob = (id: string) => (cache.get(id) ?? blobs.get(id)) as Buffer;
    let leftOut = 0;

    // Endpoint records about servers tracked privately or kept off go, and with them the lists they name.
    const withheld = (record: unknown) => isPrivateRecord(record) || isKeptOff((record as { url?: unknown } | null)?.url);
    const privateLists = new Set<string>();
    const endpointLines: string[] = [];
    let endpointsChanged = false;
    for (const text of blob(tree.get("endpoints.jsonl") as string).toString("utf8").split("\n")) {
      if (!text.trim()) continue;
      const record = JSON.parse(text) as { file?: unknown };
      if (withheld(record)) {
        if (typeof record.file === "string") privateLists.add(record.file);
        leftOut += 1;
        endpointsChanged = true;
        continue;
      }
      endpointLines.push(text);
    }
    const files = new Map<string, Buffer>();
    for (const name of tops) {
      const id = tree.get(name);
      if (id) files.set(name, blob(id));
    }
    if (endpointsChanged) files.set("endpoints.jsonl", Buffer.from(endpointLines.length ? `${endpointLines.join("\n")}\n` : ""));
    const feed = files.get("feed.json");
    if (feed) {
      const parsed = JSON.parse(feed.toString("utf8")) as Record<string, unknown>;
      let changed = false;
      for (const field of ["watched", "changes"]) {
        const entries = parsed[field];
        if (!Array.isArray(entries)) continue;
        const kept = entries.filter((entry) => !withheld(entry));
        if (kept.length !== entries.length) { leftOut += entries.length - kept.length; parsed[field] = kept; changed = true; }
      }
      // Written the way the tracker writes it, so an unfiltered feed keeps its bytes and a filtered one reads the same.
      if (changed) files.set("feed.json", Buffer.from(`${JSON.stringify(parsed)}\n`));
    }
    const servers = files.get("servers.json");
    if (servers) {
      const rows = JSON.parse(servers.toString("utf8")) as unknown;
      if (Array.isArray(rows)) {
        const kept = rows.filter((row) => !withheld(row));
        if (kept.length !== rows.length) {
          leftOut += rows.length - kept.length;
          files.set("servers.json", Buffer.from(`${JSON.stringify(kept)}\n`));
          // The lookup is made from the servers table, so it is made again from what is kept.
          const lookup = files.get("lookup.json");
          if (lookup) files.set("lookup.json", Buffer.from(`${JSON.stringify({ ...(JSON.parse(lookup.toString("utf8")) as object), rows: lookupOf(kept as FeedServer[]) })}\n`));
        }
      }
    }

    const lists = new Map<string, Buffer>();
    const newLists = new Set<string>();
    for (const name of listPaths) {
      const id = tree.get(name) as string;
      if (privateLists.has(name) || name.includes("signed-in-") || listVerdict(name, blob(id)) !== "public") { leftOut += 1; continue; }
      lists.set(name, blob(id));
      if (previous.get(name) !== id) newLists.add(name);
    }
    // Only the current commit's lists are kept for the next one: most are unchanged, and are not read again.
    cache = new Map(listPaths.map((name) => [tree.get(name) as string, blob(tree.get(name) as string)]));
    previous = tree;

    // A scan with a manifest is named by when it started, as the uploader names it; an older one by its commit.
    const manifestId = tree.get(manifestName);
    const manifest = manifestId ? blob(manifestId) : undefined;
    const read = manifest ? readManifest((() => { try { return JSON.parse(manifest.toString("utf8")) as unknown; } catch { return null; } })()) : null;
    if (manifest && typeof read === "string") throw new Error(`${manifestName} in commit ${commit.slice(0, 12)} cannot be used: ${read}.`);
    // A signed scan is published as it was signed: one that needed filtering would no longer match its manifest.
    if (manifest && leftOut) throw new Error(`Commit ${commit.slice(0, 12)} has a manifest and data about servers tracked privately; it cannot be published as signed.`);
    const scanStartedAt = read && typeof read !== "string" ? read.scanStartedAt : undefined;
    // The pointer never moves back, so a scan dated ahead would hold it: refused, as publish refuses it.
    if (Date.parse(scanStartedAt ?? committedAt) > now().getTime() + 10 * 60_000) throw new Error(`Commit ${commit.slice(0, 12)} is dated in the future, so it was not published.`);
    const signatureId = tree.get(signatureName);
    if (manifest) await verifyCommit(repo, commit, signatureId !== undefined, options);
    yield {
      input: {
        id: scanIdOf(scanStartedAt ?? committedAt),
        source: { kind: "data-branch", commit, committedAt, ...(scanStartedAt ? { scanStartedAt } : {}) },
        files, lists, newLists,
        ...(manifest ? { manifest } : {}), ...(manifest && signatureId ? { signature: blob(signatureId) } : {}),
      },
      leftOut,
    };
  }
}
