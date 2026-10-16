import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { authorityOf, describeAuthority, shownSource } from "./authority.ts";
import { listTools } from "./client.ts";
import { diffSnapshots } from "./diff.ts";
import { connect, ghSecretSet, readHidden } from "./connect.ts";
import { describeDigest, periodOf } from "./digest.ts";
import { describeDiff, describeSnapshot } from "./report.ts";
import { scanSignedIn, signedInServers } from "./signed-in.ts";
import { readSnapshot, save } from "./files.ts";
import { describeReview, review } from "./review.ts";
import { takeSnapshot } from "./snapshot.ts";
import { track } from "./track.ts";
import { snapshotFromRepository } from "./sources/github-snapshots.ts";
import type { Snapshot } from "./types.ts";

const usage = `Usage:
  npm run scan -- scan <https-url> [--save]         List a server's tools, label them, and check their text.
  npm run scan -- signed-in <name> [--save]         The same, for a server that wants a sign-in (${Object.keys(signedInServers).join(", ")}).
  npm run scan -- authority <snapshot.json>...      What an agent can do through these servers, in plain words.
  npm run scan -- digest <snapshot-folder>...       The week's changes on the servers saved there, as an email's text.
                                                    --days=7 and --until=YYYY-MM-DD set the period, in UTC.
  npm run scan -- diff <before.json> <after.json>   Compare two saved snapshots.
  npm run scan -- history <owner/repo> <from> <to>  Compare tool definitions a repository publishes at two tags.
  npm run scan -- track [options]                   One run of the public tracker: read the registry, look at the endpoints
                                                    due, and write the data folder and the feed. Options, each at most once:
                                                    --data=tracker-data --budget-minutes=45 --max-checks=6000 --per-host=30
                                                    --concurrency=24 --host-gap-ms=1000 --skip-registry
  npm run scan -- review [--data=tracker-data] [--days=2]
                                                    Look again, live, at servers the tracker found new or changed, and print
                                                    what the text checks find. For a person; it writes nothing.
  npm run scan -- connect [vendor...] [--repo=owner/name]
                                                    Add vendor tokens to the tracker's repository secrets, one hidden
                                                    prompt each, each tested first. Default: every vendor, Stackduke/mcp-scanner.

Nothing here calls a tool. scan sends no credential. signed-in reads a token from an environment
variable and sends it only to that server's fixed address; the token is never printed or saved.
--save writes the snapshot under data/snapshots/<source>/. history sends GITHUB_TOKEN, if set, to
api.github.com only.`;

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

  if (command === "digest" && args[0]) {
    // Flags are read strictly: a misspelt or half-given one would otherwise quietly report the wrong period.
    const options = new Map<string, string>();
    for (const flag of flags) {
      const match = /^--(days|until)=(.+)$/.exec(flag);
      if (!match || options.has(match[1] as string)) { console.error("digest takes --days=N and --until=YYYY-MM-DD, each at most once."); return 2; }
      options.set(match[1] as string, match[2] as string);
    }
    const daysText = options.get("days") ?? "7", untilText = options.get("until");
    const days = /^\d{1,2}$/.test(daysText) ? Number(daysText) : 0;
    const endOfDay = untilText === undefined ? null : new Date(`${untilText}T23:59:59.999Z`);
    const dateIsReal = endOfDay === null || (/^\d{4}-\d{2}-\d{2}$/.test(untilText ?? "") && !Number.isNaN(endOfDay.getTime()) && endOfDay.toISOString().slice(0, 10) === untilText);
    if (days < 1 || days > 92 || !dateIsReal) { console.error("--days takes a whole number from 1 to 92, and --until a real date written YYYY-MM-DD."); return 2; }
    // With --until the period is whole days, in UTC, ending with that day. Without it, the days up to now.
    const until = endOfDay ?? new Date();
    const period = { from: new Date(endOfDay ? endOfDay.getTime() + 1 - days * 86_400_000 : until.getTime() - days * 86_400_000), until };

    // Every saved scan in the folders given, grouped by the server it came from.
    const byServer = new Map<string, { snapshots: Snapshot[]; unreadable: number }>();
    const seenFiles = new Set<string>();
    let stray = 0, emptyFolders = 0;
    for (const folder of new Set(args.map((folder) => path.resolve(folder)))) {
      let files: string[];
      try { files = (await readdir(folder)).filter((file) => file.endsWith(".json")).sort(); } catch { console.error("One of those folders could not be read."); return 2; }
      const here = new Set<string>();
      let unreadable = 0;
      for (const file of files) {
        const full = path.resolve(folder, file);
        if (seenFiles.has(full)) continue;
        seenFiles.add(full);
        const snapshot = await readSnapshot(full);
        if (!snapshot || Number.isNaN(new Date(snapshot.takenAt).getTime())) { unreadable += 1; continue; }
        const key = shownSource(snapshot.source).toLowerCase();
        here.add(key);
        const server = byServer.get(key) ?? { snapshots: [], unreadable: 0 };
        server.snapshots.push(snapshot);
        byServer.set(key, server);
      }
      // A scan that cannot be read belongs to the server whose folder it sits in, and makes that server's period incomplete.
      if (here.size) for (const key of here) (byServer.get(key) as { unreadable: number }).unreadable += unreadable;
      else { stray += unreadable; emptyFolders += 1; }
    }
    const servers = [...byServer.values()].flatMap(({ snapshots, unreadable }) => {
      const server = periodOf(snapshots, period, unreadable);
      // A folder whose scans all fall after the period gave nothing for it either.
      if (!server) emptyFolders += 1;
      return server ? [server] : [];
    });
    const digest = describeDigest(servers, period, { strayScans: stray, emptyFolders });
    console.log(`Subject: ${digest.subject}\n\n${digest.text}`);
    return 0;
  }

  if (command === "track" && !args.length) {
    const defaults: Record<string, string> = { data: "tracker-data", "budget-minutes": "45", "max-checks": "6000", "per-host": "30", concurrency: "24", "host-gap-ms": "1000" };
    const given = new Map<string, string>();
    for (const flag of flags) {
      const match = /^--([a-z-]+)(?:=(.+))?$/.exec(flag);
      const name = match?.[1] ?? "", value = match?.[2];
      const known = name === "skip-registry" ? value === undefined : Object.hasOwn(defaults, name) && value !== undefined;
      if (!known || given.has(name)) { console.error(`track does not take ${flag.split("=")[0]}, or took it twice.`); return 2; }
      given.set(name, value ?? "");
    }
    const option = (name: string) => given.get(name) ?? (defaults[name] as string);
    const value: Record<string, number> = {};
    for (const name of ["budget-minutes", "max-checks", "per-host", "concurrency", "host-gap-ms"]) {
      const text = option(name);
      if (!/^\d{1,6}$/.test(text) || Number(text) < (name === "host-gap-ms" ? 0 : 1)) { console.error(`--${name} takes a whole number${name === "host-gap-ms" ? "" : " from 1"}.`); return 2; }
      value[name] = Number(text);
    }
    const summary = await track({
      dataDir: option("data"), readRegistry: !given.has("skip-registry"),
      maxChecks: value["max-checks"] as number, perHost: value["per-host"] as number, concurrency: value.concurrency as number,
      hostGapMs: value["host-gap-ms"] as number, budgetMinutes: value["budget-minutes"] as number,
      environment: process.env, log: (line) => console.log(line),
    });
    console.log(`Done: ${summary.checked} of ${summary.planned} checks made, ${summary.changed} with a change, ${summary.notStarted} left for the next run.`);
    return 0;
  }

  if (command === "review" && !args.length) {
    const given = new Map([...flags].map((flag) => { const match = /^--(data|days)=(.+)$/.exec(flag); return [match?.[1] ?? flag, match?.[2] ?? ""] as const; }));
    const days = given.get("days") ?? "2";
    if ([...given.keys()].some((name) => name !== "data" && name !== "days") || given.size !== flags.size || !/^\d{1,3}$/.test(days) || Number(days) < 1) { console.error("review takes --data=<folder> and --days=N, each at most once."); return 2; }
    console.log(describeReview(await review({ dataDir: given.get("data") ?? "tracker-data", days: Number(days), concurrency: 16, hostGapMs: 1000, budgetMinutes: 60 })));
    return 0;
  }

  if (command === "connect") {
    const repoFlags = [...flags].map((flag) => /^--repo=([\w.-]+\/[\w.-]+)$/.exec(flag));
    if (repoFlags.some((match) => !match) || repoFlags.length > 1) { console.error("connect takes only --repo=owner/name."); return 2; }
    const repository = repoFlags[0]?.[1] ?? "Stackduke/mcp-scanner";
    const vendors = args.length ? args : Object.keys(signedInServers);
    console.log(`Each token is tested against its vendor's server, then stored as a secret of ${repository}. Nothing is printed or written to a file.`);
    const { stored, skipped } = await connect(vendors, repository, { readSecret: readHidden, storeSecret: ghSecretSet, print: (...lines) => console.log(lines.join("\n")) });
    console.log(`\nStored: ${stored.join(", ") || "none"}. Skipped: ${skipped.join(", ") || "none"}.`);
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
