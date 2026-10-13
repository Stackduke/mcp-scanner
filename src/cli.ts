import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { authorityOf, describeAuthority } from "./authority.ts";
import { listTools, readTool } from "./client.ts";
import { diffSnapshots } from "./diff.ts";
import { describeDiff, describeSnapshot } from "./report.ts";
import { scanSignedIn, signedInServers } from "./signed-in.ts";
import { takeSnapshot } from "./snapshot.ts";
import { snapshotFromRepository } from "./sources/github-snapshots.ts";
import type { Snapshot, ToolDefinition } from "./types.ts";

const usage = `Usage:
  npm run scan -- scan <https-url> [--save]         List a server's tools, label them, and check their text.
  npm run scan -- signed-in <name> [--save]         The same, for a server that wants a sign-in (${Object.keys(signedInServers).join(", ")}).
  npm run scan -- authority <snapshot.json>...      What an agent can do through these servers, in plain words.
  npm run scan -- diff <before.json> <after.json>   Compare two saved snapshots.
  npm run scan -- history <owner/repo> <from> <to>  Compare tool definitions a repository publishes at two tags.

Nothing here calls a tool. scan sends no credential. signed-in reads a token from an environment
variable and sends it only to that server's fixed address; the token is never printed or saved.
--save writes the snapshot under data/snapshots/<source>/. history sends GITHUB_TOKEN, if set, to
api.github.com only.`;

async function save(snapshot: Snapshot): Promise<string> {
  const name = snapshot.source.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9.@-]+/g, "_").slice(0, 120);
  const directory = path.join("data", "snapshots", name);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${snapshot.takenAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return file;
}

/** A saved snapshot read back with nothing taken on trust: the file may have been made by hand. */
async function readSnapshot(file: string): Promise<Snapshot | null> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { source, takenAt, server, tools } = parsed as Record<string, unknown>;
  if (typeof source !== "string" || typeof takenAt !== "string" || !Array.isArray(tools)) return null;
  const seen = new Map<string, number>();
  const read = tools.map((tool) => {
    const definition = readTool(tool);
    if (!definition) return null;
    const given = (tool as { variant?: unknown }).variant;
    // A source may give several definitions of one tool, as named variants or by repeating the name.
    // Each is kept, because the serious one may not be the first.
    const base = typeof given === "string" && given ? `${definition.name}#${given}` : definition.name;
    const times = (seen.get(base) ?? 0) + 1;
    seen.set(base, times);
    const variant = [typeof given === "string" ? given : "", times > 1 ? `repeat-${times}` : ""].filter(Boolean).join("-");
    return variant ? { ...definition, variant } : definition;
  });
  if (read.some((tool) => tool === null)) return null;
  const name = typeof server === "object" && server !== null ? (server as { name?: unknown }).name : undefined;
  return takeSnapshot(source, read as Array<ToolDefinition & { variant?: string }>, typeof name === "string" ? { name } : undefined, takenAt);
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

  if (command === "signed-in" && args[0]) {
    const scan = await scanSignedIn(args[0], process.env);
    if (scan.outcome === "unknown-server") { console.error(`No signed-in server is set up under that name. Known: ${Object.keys(signedInServers).join(", ")}.`); return 2; }
    if (scan.outcome === "no-token") {
      console.error(scan.reason === "missing"
        ? `Set ${scan.tokenVariable} to a token for this server. It is read from the environment only, never from an argument.`
        : `${scan.tokenVariable} does not hold something that can be sent as a token. Nothing was sent.`);
      return 2;
    }
    if (scan.outcome === "unsafe-connection") { console.error(`Certificate checking is switched off here (NODE_TLS_REJECT_UNAUTHORIZED=0), so the token in ${scan.tokenVariable} was not sent.`); return 2; }
    if (scan.outcome === "token-echoed") { console.error(`${scan.url} sent the token back in its reply. Nothing it returned was printed or saved. Treat that token as exposed and replace it.`); return 5; }
    const { url, result } = scan;
    if (result.outcome === "sign-in-required") { console.log(`${url} refused the token in ${scan.tokenVariable} (HTTP ${result.status}).`); return 3; }
    if (result.outcome !== "listed") { console.log(`${url} could not be scanned: ${result.outcome} (${result.detail}).`); return 4; }
    const snapshot = takeSnapshot(url, result.tools, result.server);
    console.log(describeSnapshot(snapshot));
    console.log("\nThis is the list this token is allowed to see. Another account, or a token with other permissions, may be shown more or fewer tools.");
    if (flags.has("--save")) console.log(`\nSaved to ${await save(snapshot)}`);
    return 0;
  }

  if (command === "authority" && args[0]) {
    const snapshots = await Promise.all(args.map(readSnapshot));
    if (snapshots.some((snapshot) => snapshot === null)) { console.error("One of those files is not a saved snapshot."); return 2; }
    console.log(describeAuthority((snapshots as Snapshot[]).map(authorityOf)));
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
