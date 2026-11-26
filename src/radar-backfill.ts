import { execFile, spawn } from "node:child_process";
import { isPrivateRecord, publishedVendors, scanIdOf } from "./radar-layout.ts";
import type { ScanInput } from "./radar-layout.ts";

/**
 * The data branch's history, one scan per commit, in the bucket's layout. It only reads the repository (git log,
 * ls-tree and cat-file); the branch is never checked out, changed or deleted.
 *
 * Before 24 October 2026 the branch also held servers that are now tracked privately (their endpoint records,
 * feed entries, watched/ files and tool lists). Those are left out here: a scan is filtered, then planned like any
 * other, and planning refuses a scan that still holds any. The feed's totals (servers, tools) from those days
 * still count them, as numbers only.
 */
export interface BackfillScan {
  input: ScanInput;
  /** Endpoint records, feed entries and list files left out because they are about servers tracked privately. */
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

const tops = ["endpoints.jsonl", "feed.json", "servers.json", "lookup.json", "registry.json"];

/** The scans of a data branch, oldest first. Commits with no endpoints.jsonl (the branch's first) are skipped. */
export async function* backfillScans(repo: string, ref: string, published = publishedVendors()): AsyncGenerator<BackfillScan> {
  // A ref that starts with "-" would reach git as an option (--output=<file> writes a file), so it is refused.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) throw new Error(`Not a branch or ref name: ${ref}`);
  const log = (await git(repo, ["log", "--reverse", "--first-parent", "--format=%H %cI", ref, "--"])).toString("utf8").trim();
  let previous = new Map<string, string>();
  let cache = new Map<string, Buffer>();
  for (const line of log ? log.split("\n") : []) {
    const [commit, committedAt] = line.split(" ") as [string, string];
    const tree = await treeOf(repo, commit);
    if (!tree.has("endpoints.jsonl")) { previous = tree; continue; }

    const listPaths = [...tree.keys()].filter((name) => name.startsWith("lists/") && name.endsWith(".json"));
    const wanted = [...new Set([...tops.flatMap((name) => tree.get(name) ?? []), ...listPaths.map((name) => tree.get(name) as string)])];
    const blobs = await readBlobs(repo, wanted.filter((id) => !cache.has(id)));
    const blob = (id: string) => (cache.get(id) ?? blobs.get(id)) as Buffer;
    let leftOut = 0;

    // Endpoint records about servers tracked privately go, and with them the lists they name.
    const privateLists = new Set<string>();
    const endpointLines: string[] = [];
    let endpointsChanged = false;
    for (const text of blob(tree.get("endpoints.jsonl") as string).toString("utf8").split("\n")) {
      if (!text.trim()) continue;
      const record = JSON.parse(text) as { file?: unknown };
      if (isPrivateRecord(record, published)) {
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
        const kept = entries.filter((entry) => !isPrivateRecord(entry, published));
        if (kept.length !== entries.length) { leftOut += entries.length - kept.length; parsed[field] = kept; changed = true; }
      }
      // Written the way the tracker writes it, so an unfiltered feed keeps its bytes and a filtered one reads the same.
      if (changed) files.set("feed.json", Buffer.from(`${JSON.stringify(parsed)}\n`));
    }
    const servers = files.get("servers.json");
    if (servers) {
      const rows = JSON.parse(servers.toString("utf8")) as unknown;
      if (Array.isArray(rows)) {
        const kept = rows.filter((row) => !isPrivateRecord(row, published));
        if (kept.length !== rows.length) { leftOut += rows.length - kept.length; files.set("servers.json", Buffer.from(`${JSON.stringify(kept)}\n`)); }
      }
    }

    const lists = new Map<string, Buffer>();
    const newLists = new Set<string>();
    for (const name of listPaths) {
      if (privateLists.has(name) || name.includes("signed-in-")) { leftOut += 1; continue; }
      const id = tree.get(name) as string;
      lists.set(name, blob(id));
      if (previous.get(name) !== id) newLists.add(name);
    }
    // Only the current commit's lists are kept for the next one: most are unchanged, and are not read again.
    cache = new Map(listPaths.map((name) => [tree.get(name) as string, blob(tree.get(name) as string)]));
    previous = tree;

    yield { input: { id: scanIdOf(committedAt), source: { kind: "data-branch", commit, committedAt }, files, lists, newLists, published }, leftOut };
  }
}
