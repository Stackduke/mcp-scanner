import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { confined, day, plural, shownName, shownSource } from "./authority.ts";
import { changeRows, listOf, noteLines, problemRows, repeatedNames, runCheck, updateLockfile } from "./check.ts";
import type { CheckResult } from "./check.ts";
import { listTools, readCapped, readTool, ReplyTooLarge, userAgent } from "./client.ts";
import type { ListToolsResult } from "./client.ts";
import { isRecord, lockedEntries, readLockedTools } from "./lockfile.ts";
import type { LockedTool } from "./lockfile.ts";
import { listWithToken, signedInServers } from "./signed-in.ts";
import { takeSnapshot } from "./snapshot.ts";
import type { Snapshot, ToolDefinition } from "./types.ts";

/**
 * The agent's side of the lockfile: the MCP servers a repository's agents connect to, which it
 * did not write and does not deploy, and the tools approved on each, in `stackduke.watch.json`.
 *
 * Each run gets every server's current tools and compares them with the approved list, as `check`
 * does for a server a repository builds. The tools come from one of two places:
 *
 * - the public tracker's copy, for a server it watches with a sign-in (GitHub, Linear, Stripe and
 *   the rest of the catalog's published servers). It is read from the tracker's `data` branch on
 *   GitHub, the same files stackduke.com/tracker shows. Those tools are the ones the tracker's own
 *   test account is shown, which may not be what the repository's account is shown;
 * - the server itself, for any other server, or for one given a `tokenVariable`: then the token in
 *   that environment variable is sent to that server, and to nothing else, under the rules every
 *   token here follows.
 *
 * It is an alert, not a block. Nothing here stands between an agent and a server; a failed run
 * tells a person, and an agent can still use whatever the server offers until someone acts.
 *
 * Tracker data that is old, incomplete or out of reach is said to be so. It is never taken as
 * "nothing changed".
 */
export const watchfileName = "stackduke.watch.json";
const watchVersion = 1;
const about = "The MCP servers this repository's agents connect to, and the tools approved on each. Written by stackduke-mcp-scanner watch --update. Review a change to this file as you would a change to code.";
/** Only variables named for this can be pointed at a server, so a watch file cannot send the job's own token or another secret anywhere. */
export const tokenVariablePattern = /^STACKDUKE_WATCH_[A-Z0-9_]{1,60}$/;
/** Where the tracker's files are read from: its `data` branch, as GitHub serves it. */
export const trackerData = "https://raw.githubusercontent.com/Stackduke/mcp-scanner/data";
/** The tracker runs once a day, so two days allows for one missed run. */
export const defaultMaxAgeHours = 48;
const longestData = 16_000_000;

export interface WatchedServer {
  /** The address, as `new URL` writes it. */
  url: string;
  tokenVariable?: string;
  /** The approved tools. Null when nothing has been approved for this server yet. */
  tools: LockedTool[] | null;
}

export interface Watchfile { servers: WatchedServer[] }

const isLoopback = (host: string) => host === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]";

/** A server's address as the watch file keeps it: https, or http on this machine, with no login in it. */
export function serverAddress(text: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try { parsed = new URL(text); } catch { return { ok: false, reason: "it is not a web address" }; }
  if (parsed.username || parsed.password) return { ok: false, reason: "it has a user name or password in it; give a token through tokenVariable instead" };
  if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(parsed.hostname)))) return { ok: false, reason: "it is not https (plain http is read only on this machine)" };
  if (parsed.hash) return { ok: false, reason: "it has a # part" };
  return { ok: true, url: parsed.href };
}

export type WatchfileRead = { ok: true; watchfile: Watchfile } | { ok: false; reason: string };

/** Read as strictly as the lockfile: a field this version does not know stops the run instead of being skipped. */
export function readWatchfile(text: string): WatchfileRead {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: "it is not valid JSON" }; }
  if (!isRecord(parsed)) return { ok: false, reason: "it is not a JSON object" };
  if (parsed.watchVersion !== watchVersion) return { ok: false, reason: `its watchVersion is not ${watchVersion}` };
  if (Object.keys(parsed).some((key) => !["watchVersion", "about", "servers"].includes(key))) return { ok: false, reason: "it has a field this version does not know" };
  if (!isRecord(parsed.servers)) return { ok: false, reason: "it has no servers object" };
  const servers: WatchedServer[] = [];
  const seen = new Set<string>();
  for (const [index, [key, entry]] of Object.entries(parsed.servers).entries()) {
    const at = `server ${index + 1}`;
    const address = serverAddress(key);
    if (!address.ok) return { ok: false, reason: `the address of ${at} is refused: ${address.reason}` };
    if (seen.has(address.url)) return { ok: false, reason: `${at} repeats an address listed before it` };
    seen.add(address.url);
    if (!isRecord(entry)) return { ok: false, reason: `${at} is not a JSON object` };
    if (Object.keys(entry).some((field) => !["tokenVariable", "tools"].includes(field))) return { ok: false, reason: `${at} has a field this version does not know` };
    if (entry.tokenVariable !== undefined && !(typeof entry.tokenVariable === "string" && tokenVariablePattern.test(entry.tokenVariable))) {
      return { ok: false, reason: `the tokenVariable of ${at} must be named STACKDUKE_WATCH_ and capital letters, digits or _` };
    }
    // Each variable goes with one address, so an entry added later cannot borrow another server's token.
    if (typeof entry.tokenVariable === "string" && servers.some((server) => server.tokenVariable === entry.tokenVariable)) {
      return { ok: false, reason: `${at} names the same tokenVariable as a server before it; each token goes to one server only` };
    }
    let tools: LockedTool[] | null = null;
    if (entry.tools !== undefined) {
      if (!Array.isArray(entry.tools)) return { ok: false, reason: `the tools of ${at} are not a list` };
      const read = readLockedTools(entry.tools);
      if (!read.ok) return { ok: false, reason: `in ${at}, ${read.reason}` };
      tools = read.tools;
    }
    servers.push({ url: address.url, ...(typeof entry.tokenVariable === "string" ? { tokenVariable: entry.tokenVariable } : {}), tools });
  }
  return { ok: true, watchfile: { servers } };
}

/** The file's text. Servers are sorted by address and each tool list is written as the lockfile writes one, so it reads well in a diff. */
export function writeWatchfile(watchfile: Watchfile): string {
  const servers = [...watchfile.servers].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const entries = Object.fromEntries(servers.map((server) => [server.url, {
    ...(server.tokenVariable ? { tokenVariable: server.tokenVariable } : {}),
    ...(server.tools ? { tools: lockedEntries(server.tools) } : {}),
  }]));
  return `${JSON.stringify({ watchVersion, about, servers: entries }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------
// The tracker's copy.

type Fetched = { ok: true; text: string } | { ok: false; why: string };

/** A promise that gives up after `ms`, so one slow reply cannot hold the run open. */
function withinTime<T>(work: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(late), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** One of the tracker's files, from its published address or from a folder holding a copy. Nothing is sent but the request. */
async function readData(data: string, file: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Fetched> {
  if (/^https:\/\//i.test(data)) {
    const fetched = async (): Promise<Fetched> => {
      try {
        const response = await fetchImpl(`${data.replace(/\/+$/, "")}/${file}`, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { ok: false, why: response.status === 404 ? "it has no such file" : `it answered HTTP ${response.status}` }; }
        return { ok: true, text: await readCapped(response, longestData) };
      } catch (error) {
        return { ok: false, why: error instanceof ReplyTooLarge ? "the file is larger than this scanner accepts" : "it could not be reached" };
      }
    };
    return withinTime(fetched(), timeoutMs + 5_000, { ok: false, why: "it did not answer in time" });
  }
  const where = path.join(data, file);
  try {
    if ((await stat(where)).size > longestData) return { ok: false, why: "the file is larger than this scanner accepts" };
    return { ok: true, text: await readFile(where, "utf8") };
  } catch (error) {
    return { ok: false, why: (error as NodeJS.ErrnoException).code === "ENOENT" ? "it has no such file" : "the file could not be opened" };
  }
}

interface FeedEntry {
  vendor: string;
  url: string;
  lastListed?: string;
  lastChecked?: string;
  outcome?: string;
  tools?: number;
  names: string[] | null;
  latestChange?: string;
}

type FeedRead = { ok: true; entries: FeedEntry[] } | { ok: false; why: string };

const isDate = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** The servers the tracker watches with a sign-in, from its feed. Only the fields this needs are read. */
function readFeed(text: string): FeedRead {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, why: "the tracker's feed is not valid JSON" }; }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.watched)) return { ok: false, why: "the tracker's feed is not in the form this version reads" };
  const entries: FeedEntry[] = [];
  for (const item of parsed.watched) {
    if (!isRecord(item) || typeof item.vendor !== "string" || typeof item.url !== "string") continue;
    const address = serverAddress(item.url);
    if (!address.ok) continue;
    const groups = Array.isArray(item.groups) ? item.groups : null;
    const names = groups && groups.every((group) => isRecord(group) && Array.isArray(group.tools) && group.tools.every((name) => typeof name === "string"))
      ? groups.flatMap((group) => (group as { tools: string[] }).tools)
      : null;
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const latest = changes[0];
    entries.push({
      vendor: item.vendor, url: address.url, names,
      ...(isDate(item.lastListed) ? { lastListed: item.lastListed } : {}),
      ...(isDate(item.lastChecked) ? { lastChecked: item.lastChecked } : {}),
      ...(typeof item.outcome === "string" ? { outcome: item.outcome } : {}),
      ...(typeof item.tools === "number" ? { tools: item.tools } : {}),
      ...(isRecord(latest) && isDate(latest.at) ? { latestChange: latest.at } : {}),
    });
  }
  return { ok: true, entries };
}

const hour = 3_600_000;
const sameNames = (a: string[], b: string[]) => {
  const [left, right] = [[...a].sort(), [...b].sort()];
  return left.length === right.length && left.every((name, index) => name === right[index]);
};
/** The feed names a tool listed more than once `name#variant`; the saved list repeats the plain name. */
const baseName = (shown: string) => shown.replace(/#.*$/, "");

type Copy = { ok: true; tools: ToolDefinition[]; server?: Snapshot["server"]; listedAt: string; note?: string } | { ok: false; why: string };

/**
 * The tracker's latest list of one server's tools, if it is recent and its files agree. The feed
 * says when the server was last listed; `watched/<vendor>.json` holds the definitions, rewritten
 * when they change. The two are read separately, so they are checked against each other: the
 * same tool names, and a saved list no older than the last change the feed records and no newer
 * than the last listing.
 */
async function trackerCopy(entry: FeedEntry, read: (file: string) => Promise<Fetched>, now: Date, maxAgeHours: number): Promise<Copy> {
  if (!entry.lastListed) return { ok: false, why: "the tracker has not listed this server's tools yet" };
  const age = now.getTime() - Date.parse(entry.lastListed);
  if (age < -hour) return { ok: false, why: "the tracker's feed gives a time in the future for its last listing, so it cannot be relied on" };
  if (age > maxAgeHours * hour) {
    return { ok: false, why: `the tracker last listed its tools on ${day(entry.lastListed)}, ${Math.floor(age / hour)} hours ago, which is older than the ${maxAgeHours} hours allowed` };
  }
  if (!/^[a-z0-9-]{1,40}$/.test(entry.vendor)) return { ok: false, why: "the tracker's feed names this server in a way this version does not read" };
  const file = await read(`watched/${entry.vendor}.json`);
  if (!file.ok) return { ok: false, why: `the tracker's saved tool list could not be read: ${file.why}` };
  let snapshot: unknown;
  try { snapshot = JSON.parse(file.text); } catch { return { ok: false, why: "the tracker's saved tool list is not valid JSON" }; }
  if (!isRecord(snapshot) || !Array.isArray(snapshot.tools) || !isDate(snapshot.takenAt)) return { ok: false, why: "the tracker's saved tool list is not in the form this version reads" };
  const tools = snapshot.tools.map(readTool);
  if (tools.some((tool) => tool === null)) return { ok: false, why: "the tracker's saved tool list has a tool this version cannot read" };
  const definitions = tools as ToolDefinition[];
  // Both files come from the same run of the tracker only if these agree. A cache can serve one
  // file from before a run and the other from after it.
  const savedAt = Date.parse(snapshot.takenAt);
  const disagree = (entry.names !== null && !sameNames(definitions.map((tool) => shownName(tool)), entry.names.map(baseName)))
    || (entry.tools !== undefined && entry.tools !== definitions.length)
    || savedAt > Date.parse(entry.lastListed) + 60_000
    || (entry.latestChange !== undefined && savedAt < Date.parse(entry.latestChange) - 60_000);
  if (disagree) return { ok: false, why: "the tracker's feed and its saved tool list do not agree, as happens for a few minutes after a run; try again later" };
  const server = isRecord(snapshot.server) ? {
    ...(typeof snapshot.server.name === "string" ? { name: snapshot.server.name } : {}),
    ...(typeof snapshot.server.version === "string" ? { version: snapshot.server.version } : {}),
  } : undefined;
  const missed = entry.outcome && entry.outcome !== "listed" && entry.lastChecked ? `The tracker's latest look, on ${day(entry.lastChecked)}, did not list its tools; this is the list from before.` : undefined;
  return { ok: true, tools: definitions, ...(server ? { server } : {}), listedAt: entry.lastListed, ...(missed ? { note: missed } : {}) };
}

// ---------------------------------------------------------------------------------------------
// One run.

export type Via = { from: "tracker"; listedAt: string } | { from: "server"; tokenVariable?: string };

export type ServerOutcome =
  | { url: string; checked: true; via: Via; result: CheckResult; live: Snapshot; repeated: string[]; note?: string }
  /** No list could be had. `code` is 3 when it is a sign-in that is missing or refused, 4 otherwise. */
  | { url: string; checked: false; via: Via | null; why: string; code: 3 | 4 };

export interface WatchOptions {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** For each request to a server or to the tracker. */
  timeoutMs?: number;
  /** An https address or a folder holding the tracker's files. */
  trackerData?: string;
  maxAgeHours?: number;
  now?: Date;
}

/** The addresses the tracker publishes, from the catalog this copy carries. The feed may list more. */
const catalogAddresses = new Set(Object.values(signedInServers).flatMap((server) => { const address = serverAddress(server.url); return address.ok ? [address.url] : []; }));

const said = (detail: string) => confined(detail, /[^A-Za-z0-9 ,.()_:-]+/g, 160) || "no reason was given";

/** A list read from the server itself, as an outcome, in the scanner's words. */
function fromServer(result: ListToolsResult, tokenVariable: string | undefined): { ok: true; tools: ToolDefinition[]; server: Snapshot["server"] } | { ok: false; why: string; code: 3 | 4 } {
  if (result.outcome === "listed") return { ok: true, tools: result.tools, server: result.server };
  if (result.outcome === "sign-in-required") {
    return tokenVariable
      ? { ok: false, why: `it refused the token in \`${tokenVariable}\` (HTTP ${result.status})`, code: 3 }
      : { ok: false, why: `it asks for a sign-in (HTTP ${result.status}). Give it a token: name a STACKDUKE_WATCH_ variable as its tokenVariable in the watch file, and set that variable for the run`, code: 3 };
  }
  if (result.outcome === "not-usable") return { ok: false, why: `its answer could not be used: ${said(result.detail)}`, code: 4 };
  return { ok: false, why: "it could not be reached", code: 4 };
}

export async function runWatch(servers: WatchedServer[], options: WatchOptions): Promise<ServerOutcome[]> {
  const { env, fetchImpl = fetch, timeoutMs = 15_000, trackerData: data = trackerData, maxAgeHours = defaultMaxAgeHours, now = new Date() } = options;
  const read = (file: string) => readData(data, file, fetchImpl, timeoutMs);
  let feed: Promise<FeedRead> | null = null;
  const theFeed = () => (feed ??= read("feed.json").then((file) => (file.ok ? readFeed(file.text) : { ok: false as const, why: `the tracker's feed could not be read: ${file.why}` })));

  const outcomes: ServerOutcome[] = [];
  for (const server of servers) {
    let via: Via;
    let listed: { ok: true; tools: ToolDefinition[]; server?: Snapshot["server"]; note?: string } | { ok: false; why: string; code: 3 | 4 };
    if (server.tokenVariable) {
      via = { from: "server", tokenVariable: server.tokenVariable };
      const scan = await listWithToken(server.url, server.tokenVariable, env[server.tokenVariable], env, { fetchImpl, timeoutMs });
      listed = scan.outcome === "answered" ? fromServer(scan.result, server.tokenVariable)
        : scan.outcome === "no-token" ? { ok: false, why: scan.reason === "missing" ? `\`${server.tokenVariable}\` is not set for this run` : `\`${server.tokenVariable}\` does not hold a usable token`, code: 3 }
        : scan.outcome === "unsafe-connection" ? { ok: false, why: "certificate checking is switched off here (NODE_TLS_REJECT_UNAUTHORIZED=0), so the token was not sent", code: 4 }
        : scan.outcome === "token-echoed" ? { ok: false, why: "the server sent the token back, so nothing it returned was used. Replace that token", code: 4 }
        : { ok: false, why: "the token could not be used with this address", code: 4 };
    } else {
      const known = await theFeed();
      const entry = known.ok ? known.entries.find((candidate) => candidate.url === server.url) : undefined;
      if (entry) {
        const copy = await trackerCopy(entry, read, now, maxAgeHours);
        via = { from: "tracker", listedAt: copy.ok ? copy.listedAt : entry.lastListed ?? "" };
        listed = copy.ok ? copy : { ok: false, why: copy.why, code: 4 };
      } else if (catalogAddresses.has(server.url)) {
        // A server the tracker publishes, and no copy to be had: say so, rather than ask it without a sign-in.
        outcomes.push({ url: server.url, checked: false, via: null, why: known.ok ? "the tracker watches this server, but its feed has no entry for it today" : known.why, code: 4 });
        continue;
      } else {
        via = { from: "server" };
        listed = fromServer(await listTools(server.url, { fetchImpl, timeoutMs }), undefined);
      }
    }
    if (!listed.ok) { outcomes.push({ url: server.url, checked: false, via, why: listed.why, code: listed.code }); continue; }
    try {
      const live = takeSnapshot(server.url, listed.tools, listed.server, via.from === "tracker" ? via.listedAt : now.toISOString());
      const repeated = repeatedNames(listed.tools);
      const result = runCheck(live, server.tools ? { tools: server.tools } : null, repeated);
      outcomes.push({ url: server.url, checked: true, via, result, live, repeated, ...(listed.note ? { note: listed.note } : {}) });
    } catch {
      outcomes.push({ url: server.url, checked: false, via, why: "a tool definition is nested too deeply to compare", code: 4 });
    }
  }
  return outcomes;
}

/**
 * 1 when any server's tools differ from the approved list or fail a check. Otherwise 0 when every
 * server was read, 3 when each one that was not read wants a sign-in it did not get, and 4 when any
 * other could not be read. A server not read never counts as unchanged.
 */
export function exitCode(outcomes: ServerOutcome[]): number {
  if (outcomes.some((outcome) => outcome.checked && !outcome.result.passed)) return 1;
  const codes = outcomes.flatMap((outcome) => (outcome.checked ? [] : [outcome.code]));
  if (!codes.length) return 0;
  return codes.every((code) => code === 3) ? 3 : 4;
}

export type WatchUpdate =
  | { written: true; watchfile: Watchfile }
  /** A server has findings nobody accepted, or a name listed twice. Nothing is written. */
  | { written: false; refused: string[] };

/**
 * The watch file after a person has approved what the servers that could be read list now. As
 * with `check --update`, a finding nobody has accepted stops it unless `acceptFindings` is set.
 * A server that could not be read keeps the list approved before.
 */
export function updateWatch(watchfile: Watchfile, outcomes: ServerOutcome[], acceptFindings: boolean): WatchUpdate {
  const approved = new Map<string, LockedTool[]>();
  const refused: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.checked) continue;
    const server = watchfile.servers.find((candidate) => candidate.url === outcome.url);
    const update = updateLockfile(outcome.live, server?.tools ? { tools: server.tools } : null, acceptFindings, outcome.repeated);
    if (update.written) approved.set(outcome.url, update.tools); else refused.push(outcome.url);
  }
  if (refused.length) return { written: false, refused };
  return { written: true, watchfile: { servers: watchfile.servers.map((server) => (approved.has(server.url) ? { ...server, tools: approved.get(server.url) as LockedTool[] } : server)) } };
}

// ---------------------------------------------------------------------------------------------
// The summary, in Markdown, for the job summary, an issue or a terminal. It follows the check's
// rules: every sentence is the scanner's, tool names appear only as identifiers in code spans, and
// a server's descriptions are never quoted. A server is named by its host alone, since a path may
// hold something private.

export const watchMarker = "<!-- stackduke-mcp-watch";
const fileShown = (watchfilePath: string) => confined(watchfilePath, /[^A-Za-z0-9_./ -]+/g, 120);
const longestSummary = 60_000;
const more = "Each definition shows in the watch file's diff once approved with `--update`.";
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return "?"; } };

/** Each server's name in the summary: its host, and its place in the file when two share a host. */
export function serverNames(urls: string[]): Map<string, string> {
  const hosts = urls.map(hostOf);
  return new Map(urls.map((url, index) => {
    const host = `\`${shownSource(hosts[index])}\``;
    const shared = hosts.filter((other) => other === hosts[index]).length > 1;
    return [url, shared ? `${host} (entry ${index + 1})` : host];
  }));
}

/** What `--server=` names a server by, in the approve example: its host, or the whole address when two share it. */
function serverOption(url: string, urls: string[]): string {
  const host = hostOf(url);
  return urls.filter((other) => hostOf(other) === host).length > 1 ? "<its address in the watch file>" : shownSource(host);
}

const at = (time: string) => { const iso = new Date(time).toISOString(); return `${day(iso)}, ${iso.slice(11, 16)} UTC`; };

function readFrom(via: Via | null): string {
  if (!via) return "the Stackduke tracker";
  if (via.from === "tracker") return via.listedAt ? `the Stackduke tracker, listed ${at(via.listedAt)}` : "the Stackduke tracker";
  return via.tokenVariable ? `the server itself, with \`${via.tokenVariable}\`` : "the server itself, with no credential";
}

function resultOf(outcome: ServerOutcome, written: boolean): string {
  if (!outcome.checked) return "**not checked**";
  const { result } = outcome;
  if (written && !result.passed) return `approved now (${plural(result.toolCount, "tool")})`;
  if (!result.lockfileFound) return "**nothing approved yet**";
  const drift = result.diff.added.length + result.diff.removed.length + result.diff.changed.length;
  const parts = [
    ...(drift ? [`**${plural(drift, "tool")} differ${drift === 1 ? "s" : ""}**`] : []),
    ...(result.repeated.length ? [`**${plural(result.repeated.length, "name")} listed twice**`] : []),
    ...(result.problems.length ? [`**${plural(result.problems.length, "finding")}**`] : []),
  ];
  return parts.length ? parts.join(", ") : `matches (${plural(result.toolCount, "tool")})`;
}

export interface WatchSummaryOptions {
  watchfilePath: string;
  update?: "written" | "unchanged" | "refused";
  /** Every address in the watch file, in order, so a shared host can be told apart. */
  allUrls: string[];
  /** The run added servers with `--add`, so the approve example repeats that, not `--server`. */
  adding?: boolean;
}

export function describeWatch(outcomes: ServerOutcome[], { watchfilePath, update, allUrls, adding = false }: WatchSummaryOptions): string {
  const file = `\`${fileShown(watchfilePath) || "the watch file"}\``;
  const names = serverNames(allUrls);
  const nameOf = (url: string) => names.get(url) ?? `\`${shownSource(hostOf(url))}\``;
  const failing = outcomes.filter((outcome) => outcome.checked && !outcome.result.passed);
  const unread = outcomes.filter((outcome) => !outcome.checked);
  const verdict = update === "written" ? "watch file updated" : update === "refused" ? "watch file not updated" : update === "unchanged" ? "watch file already up to date"
    : failing.length ? "failed" : unread.length ? "could not check every server" : "passed";
  const lines: string[] = [`${watchMarker} ${fileShown(watchfilePath) || "watch file"} -->`, `## Stackduke MCP tool watch: ${verdict}`, ""];

  if (!outcomes.length) {
    lines.push(`${file} lists no servers, so nothing was compared.`, "");
  } else {
    lines.push(`Compared the tools of ${plural(outcomes.length, "MCP server")} this repository's agents connect to with ${file}.`, "");
    lines.push("| Server | Tools read from | Result |", "| --- | --- | --- |");
    for (const outcome of outcomes) lines.push(`| ${nameOf(outcome.url)} | ${readFrom(outcome.via)} | ${resultOf(outcome, update === "written")} |`);
    lines.push("");
  }

  for (const outcome of outcomes) {
    if (outcome.checked && outcome.result.passed && !outcome.note) continue;
    lines.push(`### ${nameOf(outcome.url)}`, "");
    if (!outcome.checked) {
      lines.push(`Not checked: ${outcome.why}. Nothing was compared for this server, so this run cannot say whether its tools changed.`, "");
      continue;
    }
    if (outcome.note) lines.push(outcome.note, "");
    const { result } = outcome;
    const rows = changeRows(result.diff);
    if (rows.length) {
      lines.push(update === "written" ? (result.lockfileFound ? "What was approved, since the tools approved before:" : "What was approved:") : result.lockfileFound ? "What changed since the tools were approved:" : "Tools it lists, none approved yet:", "");
      lines.push(...listOf(result.lockfileFound ? rows : rows.map((row) => row.replace(": added; ", ": ")), more), "");
    }
    const problems = problemRows(result);
    if (problems.length) lines.push("What the checks found:", "", ...listOf(problems, more), "");
    if (result.accepted.length) lines.push(`${plural(result.accepted.length, "finding")} recorded as accepted in the watch file ${result.accepted.length === 1 ? "is" : "are"} still present.`, "");
    if (result.notes.length) lines.push(...noteLines(result, more));
  }

  if (update === "written") {
    const read = outcomes.filter((outcome) => outcome.checked).length;
    lines.push(`${file} now holds the tools listed by ${plural(read, "server")}. Commit it, so reviewers see what was approved.`, "");
    if (unread.length) lines.push(`${plural(unread.length, "server")} could not be read; ${unread.length === 1 ? "its" : "their"} approved list${unread.length === 1 ? " was" : "s were"} left as ${unread.length === 1 ? "it was" : "they were"}.`, "");
  } else if (update === "unchanged") {
    lines.push(`${file} already holds these tools. Nothing was written.`, "");
  } else if (failing.length) {
    lines.push("### How to approve", "");
    if (update === "refused") lines.push("Nothing was written, because of the findings or repeated names above.", "");
    lines.push(`If a person has looked at a change and it is expected, approve it with \`--update\` and commit ${file}. Reviewers then see each definition in its diff. A finding a person has judged a false alarm is approved with \`--update --accept-findings\`, and stays accepted only while that tool's definition stays the same. If the change is not expected, stop using the server or the tool, and look at what the vendor has said about it.`, "");
    const repeats = (outcome: ServerOutcome) => outcome.checked && outcome.result.repeated.length > 0;
    const accept = (outcome: ServerOutcome) => outcome.checked && outcome.result.problems.length > 0;
    if (failing.some(repeats)) lines.push("A server that lists a tool name twice cannot be approved until it lists each name once: the watch file can hold only one definition of it.", "");
    const approvable = failing.filter((outcome) => !repeats(outcome));
    if (approvable.length && !(adding && failing.some(repeats))) {
      lines.push("```sh");
      // Servers added in one run are approved together, so that is one command.
      if (adding) lines.push(`stackduke-mcp-scanner watch --update${approvable.some(accept) ? " --accept-findings" : ""} --add=<each address, as before>`);
      else for (const outcome of approvable) lines.push(`stackduke-mcp-scanner watch --update${accept(outcome) ? " --accept-findings" : ""} --server=${serverOption(outcome.url, allUrls)}`);
      lines.push("```", "");
    }
  }

  lines.push("### What this is", "");
  lines.push("- An alert, not a block. Until someone acts, an agent can still use every tool these servers offer, changed or not.");
  if (outcomes.some((outcome) => outcome.via?.from === "tracker")) {
    lines.push("- Tools read from the Stackduke tracker are the ones its own test account was shown, on the day given. The account your agents use may be shown different tools, because of its plan, its permissions or the scopes it signed in with. To compare with what your own account is shown, give the server a `tokenVariable` in the watch file.");
  }
  if (unread.length) lines.push("- A server that was not checked is not known to be unchanged. The run fails until every server can be read again.");
  lines.push("- Tools are read from their lists; no tool is called. The text checks are pattern checks: a pass means nothing matched and nothing changed, not that a server is safe.");
  const text = `${lines.join("\n")}\n`;
  if (text.length <= longestSummary) return text;
  return `${text.slice(0, text.lastIndexOf("\n", longestSummary - 200))}\n\n… The summary was cut here to fit in an issue. The watch file's diff shows every definition.\n`;
}

/** The summary when the watch file itself could not be used. */
export function describeWatchfileProblem(watchfilePath: string, why: string): string {
  return [`${watchMarker} ${fileShown(watchfilePath) || "watch file"} -->`, "## Stackduke MCP tool watch: could not run", "", `${`\`${fileShown(watchfilePath) || "the watch file"}\``} could not be used: ${confined(why, /[^A-Za-z0-9 ,.()_:'-]+/g, 300)}.`, "", "Nothing was compared, so this run cannot say whether any server's tools changed."].join("\n") + "\n";
}
