#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { authorityOf, describeAuthority, shownSource } from "./authority.ts";
import { listTools } from "./client.ts";
import { diffSnapshots } from "./diff.ts";
import { connect, ghSecretSet, readHidden } from "./connect.ts";
import { describeDigest, periodOf } from "./digest.ts";
import { describeDiff, describeSnapshot } from "./report.ts";
import { scanSignedIn, signedInServers } from "./signed-in.ts";
import { catalog, signInFrom } from "./catalog.ts";
import { discover } from "./oauth.ts";
import { printable } from "./text.ts";
import { trySignIn } from "./try-sign-in.ts";
import { createInterface } from "node:readline/promises";
import { readSnapshot, save, writeWhole } from "./files.ts";
import { describeCheck, describeUnreachable, repeatedNames, runCheck, updateLockfile } from "./check.ts";
import { lockfileName, readLockfile } from "./lockfile.ts";
import type { Lockfile } from "./lockfile.ts";
import { listToolsStdio, programEnvironment, splitCommand } from "./stdio.ts";
import { confined } from "./authority.ts";
import { stat } from "node:fs/promises";
import { describeReview, review } from "./review.ts";
import { takeSnapshot } from "./snapshot.ts";
import { track } from "./track.ts";
import { snapshotFromRepository } from "./sources/github-snapshots.ts";
import type { Snapshot } from "./types.ts";

const usage = `Usage:
  npm run scan -- scan <https-url> [--save]         List a server's tools, label them, and check their text.
  npm run scan -- signed-in <name> [--save]         The same, for a server that wants a sign-in (${Object.keys(signedInServers).join(", ")}).
  npm run scan -- check <url> [options]             Compare a server's tools with the approved list in stackduke.lock.json,
  npm run scan -- check [options] -- <program> [args...]
                                                    for a server reached at a web address or run as a local program.
                                                    Fails when a tool changed and the lockfile was not updated, when a text
                                                    check fires, or when a tool that changes things has no risk annotation.
                                                    --lockfile=stackduke.lock.json --update --accept-findings
                                                    --summary=<file> (Markdown) --timeout=<seconds> --command="<program> [args]"
  npm run scan -- authority <snapshot.json>...      What an agent can do through these servers, in plain words.
  npm run scan -- digest <snapshot-folder>...       The week's changes on the servers saved there, as an email's text.
                                                    --days=7 and --until=YYYY-MM-DD set the period, in UTC.
  npm run scan -- diff <before.json> <after.json>   Compare two saved snapshots.
  npm run scan -- history <owner/repo> <from> <to>  Compare tool definitions a repository publishes at two tags.
  npm run scan -- track [options]                   One run of the public tracker: read the registry, look at the endpoints
                                                    due, and write the data folder and the feed. Options, each at most once:
                                                    --data=tracker-data --budget-minutes=45 --max-checks=30000 --per-host=30 --per-site=150
                                                    --concurrency=48 --host-gap-ms=1000 --skip-registry
  npm run scan -- review [--data=tracker-data] [--days=2]
                                                    Look again, live, at servers the tracker found new or changed, and print
                                                    what the text checks find. For a person; it writes nothing.
  npm run scan -- discover <https-url>              How a server signs in: what its catalog entry's signIn should be.
  npm run scan -- catalog                           Ask every server in catalog/servers.json how it signs in, and
                                                    say where the answer no longer matches the file.
  npm run scan -- try-sign-in <https-url> [--scopes="a b"]
                                                    Sign in to a server in a browser, as a test: the tokens are used
                                                    to list its tools once, never printed or saved, and then dropped.
  npm run scan -- connect [vendor...] [--repo=owner/name]
                                                    Add vendor tokens to the tracker's repository secrets, one hidden
                                                    prompt each, each tested first. Default: every vendor, Stackduke/mcp-scanner.

Nothing here calls a tool. scan, check, discover and catalog send no credential. check runs the program it is
given, with this environment, so give it only a server you would run anyway. signed-in reads a token from an environment
variable and sends it only to that server's fixed address; the token is never printed or saved.
--save writes the snapshot under data/snapshots/<source>/. history sends GITHUB_TOKEN, if set, to
api.github.com only.`;

/** A loopback address, where plain http is allowed: a server started for the check on the same machine. */
const isLoopback = (host: string) => host === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]";

async function check(rest: string[]): Promise<number> {
  // Everything after "--" is the program to run and its arguments, untouched.
  const split = rest.indexOf("--");
  const before = split === -1 ? rest : rest.slice(0, split);
  let program = split === -1 ? [] : rest.slice(split + 1);
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (const item of before) {
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const match = /^--(lockfile|summary|timeout|command)=(.*)$|^--(update|accept-findings)$/s.exec(item);
    const name = match?.[1] ?? match?.[3];
    if (!name || options.has(name)) { console.error(`check does not take ${item.split("=")[0]}, or took it twice.`); return 2; }
    options.set(name, match?.[2] ?? "");
  }
  if (options.has("command")) {
    const parts = splitCommand(options.get("command") as string);
    if (!parts?.[0]) { console.error("--command needs a program, with any quotes closed."); return 2; }
    if (program.length) { console.error("Give the program either after -- or with --command, not both."); return 2; }
    program = parts;
  }
  const url = positional[0];
  if (program.length && !program[0]) { console.error("The program after -- has no name."); return 2; }
  if (positional.length > 1 || (url && program.length) || (!url && !program.length)) { console.error("check takes one server: a web address, or a program after --."); return 2; }
  if (options.has("accept-findings") && !options.has("update")) { console.error("--accept-findings is only used with --update."); return 2; }
  const timeoutText = options.get("timeout");
  if (timeoutText !== undefined && !(/^\d{1,3}$/.test(timeoutText) && Number(timeoutText) >= 1 && Number(timeoutText) <= 600)) { console.error("--timeout takes a whole number of seconds from 1 to 600."); return 2; }

  let target: string;
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { console.error("That is not a web address."); return 2; }
    if (parsed.username || parsed.password) { console.error("A web address with a user name or password in it is refused. check sends no credential."); return 2; }
    if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(parsed.hostname)))) { console.error("check reads https:// addresses, and http:// only on this machine (localhost)."); return 2; }
    // Only the host is shown: a path or query may hold something private.
    target = `the server at \`${confined(parsed.host, /[^A-Za-z0-9.:[\]-]+/g, 80) || "?"}\``;
  } else {
    // The command is never shown or stored: its arguments may hold a secret.
    target = "the local program given";
  }

  const lockfilePath = options.get("lockfile") || lockfileName;
  const relative = path.relative(process.cwd(), path.resolve(lockfilePath));
  const shownLockfile = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : lockfilePath;
  const summaryPath = options.get("summary");
  const finish = async (markdown: string, code: number) => {
    console.log(markdown);
    if (summaryPath) await writeWhole(summaryPath, markdown);
    return code;
  };

  let lockfile: Lockfile | null = null;
  try {
    if ((await stat(lockfilePath)).size > 16_000_000) { console.error(`${printable(lockfilePath)} is larger than a lockfile should be.`); return 2; }
    const read = readLockfile(await readFile(lockfilePath, "utf8"));
    if (!read.ok) { console.error(`${printable(lockfilePath)} could not be read: ${read.reason}.`); return 2; }
    lockfile = read.lockfile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { console.error(`${printable(lockfilePath)} could not be opened.`); return 2; }
  }

  const timeoutMs = timeoutText === undefined ? undefined : Number(timeoutText) * 1000;
  const result = url
    ? await listTools(url, timeoutMs ? { timeoutMs } : {})
    : await listToolsStdio(program, { env: programEnvironment(process.env), ...(timeoutMs ? { timeoutMs } : {}) });
  if (result.outcome !== "listed") {
    const tail = (result as { stderrTail?: string }).stderrTail;
    if (tail) {
      console.error("The program's last error output, as it wrote it:");
      for (const line of tail.split(/\r?\n/).filter((text) => text.trim())) console.error(`  program stderr | ${printable(line, 300)}`);
    }
    const why = result.outcome === "sign-in-required" ? `it asks for a sign-in (HTTP ${result.status}), and check sends no credential` : `${result.outcome}, ${printable(result.detail)}`;
    return finish(describeUnreachable(target, why, shownLockfile), result.outcome === "sign-in-required" ? 3 : 4);
  }

  const summary = { target, lockfilePath: shownLockfile, serverArgs: url ? "<the same address>" : "-- <the same command>" };
  const repeated = repeatedNames(result.tools);
  let live: Snapshot, update: ReturnType<typeof updateLockfile> | null = null;
  try {
    live = takeSnapshot(url ?? "local program", result.tools, result.server);
    if (options.has("update")) update = updateLockfile(live, lockfile, options.has("accept-findings"), repeated);
  } catch {
    // A definition nested past what can be compared. The list is not one this check can use.
    return finish(describeUnreachable(target, "not-usable, a tool definition is nested too deeply to read", shownLockfile), 4);
  }

  if (update) {
    if (!update.written) return finish(describeCheck(update.result, { ...summary, update: "refused" }), 1);
    let current: string | null = null;
    try { current = await readFile(lockfilePath, "utf8"); } catch { /* not there yet */ }
    if (current === update.text) return finish(describeCheck(update.result, { ...summary, update: "unchanged" }), 0);
    await writeWhole(lockfilePath, update.text);
    return finish(describeCheck(update.result, { ...summary, update: "written" }), 0);
  }
  const checked = runCheck(live, lockfile, repeated);
  return finish(describeCheck(checked, summary), checked.passed ? 0 : 1);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "check") return check(rest);
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

  if (command === "discover" && args[0] && !flags.size) {
    const found = await discover(args[0]);
    const method = signInFrom(found);
    if (found.outcome === "oauth") {
      const server = found.authorizationServer;
      console.log([
        `${printable(args[0])}: ${method}`,
        `  sign-in server: ${printable(server.issuer)}${found.olderDiscovery ? " (found the older way: the server does not describe itself)" : ""}`,
        `  automatic registration: ${server.registrationEndpoint ? "yes" : "no"}; client metadata documents: ${server.metadataDocuments ? "yes" : "no"}`,
        `  client without a secret allowed: ${server.authMethods.includes("none") ? "yes" : "no"}`,
        `  scopes it suggests: ${printable(found.scopes.join(" ")) || "none named"}`,
      ].join("\n"));
    } else {
      console.log(`${printable(args[0])}: ${method}${"detail" in found ? ` (${found.detail})` : ""}`);
    }
    return found.outcome === "oauth" || found.outcome === "no-oauth" || found.outcome === "open" ? 0 : 4;
  }

  if (command === "catalog" && !args.length && !flags.size) {
    let differing = 0;
    for (const entry of catalog.servers) {
      const method = signInFrom(await discover(entry.url));
      const same = method === entry.signIn;
      if (!same) differing += 1;
      console.log(`${entry.id}: ${same ? `${method}, as recorded` : `now ${method}, recorded ${entry.signIn} on ${entry.signInCheckedOn}`}`);
    }
    console.log(differing ? `\n${differing} differ. Check them by hand before changing the file.` : "\nAll match the file.");
    return differing ? 1 : 0;
  }

  if (command === "try-sign-in" && args[0] && args.length === 1) {
    const scopeFlags = [...flags].map((flag) => /^--scopes=([\w:.\- /]*)$/.exec(flag));
    if (scopeFlags.some((match) => !match) || scopeFlags.length > 1) { console.error("try-sign-in takes only --scopes=\"a b\"."); return 2; }
    if (!args[0].startsWith("https://")) { console.error("Only https:// servers are signed in to."); return 2; }
    const lines = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const scopes = scopeFlags[0]?.[1]?.split(/\s+/).filter(Boolean);
      const result = await trySignIn(args[0], { ask: (prompt) => lines.question(prompt), print: (...text) => console.log(text.join("\n")), ...(scopes ? { scopes } : {}) });
      if (result.outcome !== "listed") { console.log(`\nStopped at ${result.at}: ${result.detail}.`); return 3; }
      console.log(`\nIt works: the server listed ${result.tools} tools with the new sign-in${result.scope ? `, granted ${result.scope}` : ""}. The tokens have been dropped; remove the sign-in in the vendor's settings if it is not needed.`);
      return 0;
    } finally {
      lines.close();
    }
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
    const defaults: Record<string, string> = { data: "tracker-data", "budget-minutes": "45", "max-checks": "30000", "per-host": "30", "per-site": "150", concurrency: "48", "host-gap-ms": "1000" };
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
    for (const name of ["budget-minutes", "max-checks", "per-host", "per-site", "concurrency", "host-gap-ms"]) {
      const text = option(name);
      if (!/^\d{1,6}$/.test(text) || Number(text) < (name === "host-gap-ms" ? 0 : 1)) { console.error(`--${name} takes a whole number${name === "host-gap-ms" ? "" : " from 1"}.`); return 2; }
      value[name] = Number(text);
    }
    const summary = await track({
      dataDir: option("data"), readRegistry: !given.has("skip-registry"),
      maxChecks: value["max-checks"] as number, perHost: value["per-host"] as number, perSite: value["per-site"] as number, concurrency: value.concurrency as number,
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

let finished = false;
// Node ends quietly when nothing is left that it waits for. A command that ends that way did not finish, and must not look as if it did.
process.on("beforeExit", () => { if (!finished) { console.error("The command stopped before it finished."); process.exitCode = 1; finished = true; } });
main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error: unknown) => { console.error(error instanceof Error ? error.message : "The scan failed."); process.exitCode = 1; },
).finally(() => {
  finished = true;
  // An abandoned request may hold a connection open; the work is done, so do not wait for it.
  setTimeout(() => process.exit(), 5_000).unref();
});
