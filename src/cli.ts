import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { listTools } from "./client.ts";
import { diffSnapshots } from "./diff.ts";
import { describeDiff, describeSnapshot } from "./report.ts";
import { takeSnapshot } from "./snapshot.ts";
import { snapshotFromRepository } from "./sources/github-snapshots.ts";
import type { Snapshot } from "./types.ts";

const usage = `Usage:
  npm run scan -- scan <https-url> [--save]         List a server's tools, label them, and check their text.
  npm run scan -- diff <before.json> <after.json>   Compare two saved snapshots.
  npm run scan -- history <owner/repo> <from> <to>  Compare tool definitions a repository publishes at two tags.

Nothing here calls a tool, and no credential is ever sent to an MCP server. --save writes the snapshot
under data/snapshots/<source>/. history sends GITHUB_TOKEN, if set, to api.github.com only.`;

async function save(snapshot: Snapshot): Promise<string> {
  const name = snapshot.source.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9.@-]+/g, "_").slice(0, 120);
  const directory = path.join("data", "snapshots", name);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${snapshot.takenAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return file;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((value) => value.startsWith("--")));
  const args = rest.filter((value) => !value.startsWith("--"));

  if (command === "scan" && args[0]) {
    const url = args[0];
    if (!url.startsWith("https://")) { console.error("Only https:// endpoints are scanned."); return 2; }
    const result = await listTools(url);
    if (result.outcome === "sign-in-required") { console.log(`${url} asks for a sign-in before listing its tools (HTTP ${result.status}). This scanner sends no credentials, so it stops here.`); return 3; }
    if (result.outcome !== "listed") { console.log(`${url} could not be scanned: ${result.outcome} (${result.detail}).`); return 4; }
    const snapshot = takeSnapshot(url, result.tools, result.server);
    console.log(describeSnapshot(snapshot));
    if (flags.has("--save")) console.log(`\nSaved to ${await save(snapshot)}`);
    return 0;
  }

  if (command === "diff" && args[0] && args[1]) {
    const [before, after] = await Promise.all([args[0], args[1]].map(async (file) => JSON.parse(await readFile(file, "utf8")) as Snapshot));
    console.log(describeDiff(diffSnapshots(before as Snapshot, after as Snapshot)));
    return 0;
  }

  if (command === "history" && args[0] && args[1] && args[2]) {
    const token = process.env.GITHUB_TOKEN || undefined;
    const [before, after] = await Promise.all([args[1], args[2]].map((ref) => snapshotFromRepository({ repository: args[0] as string, ref, ...(token ? { token } : {}) })));
    console.log(describeDiff(diffSnapshots(before as Snapshot, after as Snapshot)));
    if (flags.has("--save")) for (const snapshot of [before, after]) console.log(`Saved to ${await save(snapshot as Snapshot)}`);
    return 0;
  }

  console.log(usage);
  return command ? 2 : 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(error instanceof Error ? error.message : "The scan failed."); process.exitCode = 1; });
