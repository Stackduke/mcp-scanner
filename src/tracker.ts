import { createHash } from "node:crypto";
import { assessTool, authorityOf, canDo, confined, plural, seriousFirst, shownName } from "./authority.ts";
import type { AuthorityKind, AuthorityReport } from "./authority.ts";
import type { ListToolsResult } from "./client.ts";
import type { ChangedField } from "./diff.ts";
import type { RegistryRead } from "./registry.ts";
import { canonical, takeSnapshot, toolKey } from "./snapshot.ts";
import type { Snapshot } from "./types.ts";

/**
 * The public tracker: which endpoints to look at, what each look found, and the feed a web page reads.
 *
 * The same rules as the plain-language report hold here, because the feed is published:
 * - every tool is read the more serious way (the counts come from `authorityOf`);
 * - nothing says what a server cannot do, or that it is safe;
 * - a server's words appear only as identifiers: tool names cut to the characters tool names
 *   normally have, and its name for itself only when it carries no word of reassurance;
 * - nothing claims a period was quiet unless it was watched. Each change says between which two
 *   successful scans it happened, and each endpoint keeps a record of its recent checks.
 * The text checks for planted instructions are not published here. A finding goes to a person
 * first, so a vendor can be told privately.
 */
export type CheckOutcome = "listed" | "sign-in-required" | "not-usable" | "unreachable" | "no-token";
const outcomeCode: Record<CheckOutcome, string> = { listed: "L", "sign-in-required": "S", "not-usable": "N", unreachable: "U", "no-token": "T" };
const codeOutcome = Object.fromEntries(Object.entries(outcomeCode).map(([outcome, code]) => [code, outcome])) as Record<string, CheckOutcome>;

export type KindCounts = Record<AuthorityKind, number>;

export interface ChangeRecord {
  /** The scan that saw the change. */
  at: string;
  /** The last scan before it that listed tools. The change happened somewhere between the two. */
  since: string;
  added: string[];
  removed: string[];
  changed: Array<{ name: string; fields: ChangedField[] }>;
  /** Tools counted as able to do more than before (added or changed), with the most serious thing each now does. */
  moreSerious: Array<{ name: string; kind: AuthorityKind }>;
  /** Written by the scanner. Tool names are the only words of the server's in it. */
  summary: string;
}

export interface Endpoint {
  /** Stable and short: from the address, or `signed-in-<vendor>` for a server scanned with a token. */
  id: string;
  url: string;
  /** Registry entries that point here, as identifiers. */
  names: string[];
  /** The vendor key in `signedInServers`, for a server scanned with a token. */
  signedIn?: string;
  firstSeen: string;
  inRegistry: boolean;
  leftRegistry?: string;
  lastChecked?: string;
  outcome?: CheckOutcome;
  outcomeSince?: string;
  lastListed?: string;
  /** A fingerprint of the whole tool list, to see a change without opening the saved list. */
  listHash?: string;
  tools?: number;
  kinds?: KindCounts;
  /** The server's name for itself, when it can be shown. */
  declaredName?: string;
  /** Where the latest tool list is kept, relative to the data folder. */
  file?: string;
  /** The most recent checks, newest last, as `<time> <code>`. */
  checks: string[];
  /** Newest first. */
  changes: ChangeRecord[];
}

const keptChecks = 40;
const keptChanges = 30;
const hour = 3_600_000, day = 24 * hour;

export const endpointId = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 12);
const registryName = (name: string) => confined(name, /[^A-Za-z0-9_./-]+/g, 100);

/** Where an endpoint's tool list is kept: spread over folders, so none holds thousands of files. */
export function printFile(endpoint: Pick<Endpoint, "id" | "url">): string {
  const host = confined(new URL(endpoint.url).hostname, /[^A-Za-z0-9.-]+/g, 60) || "host";
  return `lists/${endpoint.id.slice(0, 2)}/${host}-${endpoint.id}.json`;
}

/** Adds endpoints new to the registry and notes those that left it. A partial read removes nothing. */
export function mergeRegistry(endpoints: Map<string, Endpoint>, read: RegistryRead, now: string): void {
  const named = new Map<string, Set<string>>();
  for (const entry of read.entries) for (const url of entry.urls) {
    const names = named.get(url) ?? new Set<string>();
    names.add(registryName(entry.name));
    named.set(url, names);
  }
  for (const [url, names] of named) {
    const known = endpoints.get(url);
    const list = [...names].filter(Boolean).sort().slice(0, 5);
    if (known && !known.signedIn) { known.names = list; known.inRegistry = true; delete known.leftRegistry; }
    else if (!known) endpoints.set(url, { id: endpointId(url), url, names: list, firstSeen: now, inRegistry: true, checks: [], changes: [] });
  }
  if (!read.complete) return;
  for (const endpoint of endpoints.values()) {
    if (endpoint.signedIn || named.has(endpoint.url) || !endpoint.inRegistry) continue;
    endpoint.inRegistry = false;
    endpoint.leftRegistry = now;
  }
}

export interface PlanOptions {
  /** Most endpoints looked at in one run. */
  maxChecks: number;
  /** Most endpoints on one host in one run, so a host listing thousands of endpoints is not hammered. */
  perHost: number;
}

/** How long to wait before looking again at an endpoint that did not list tools: 4 to 10 days, spread by address. */
const restingDays = (endpoint: Endpoint) => 4 + (Number.parseInt(endpoint.id.slice(0, 4), 16) % 7);
const age = (time: string | undefined, now: number) => (time ? now - Date.parse(time) : Number.POSITIVE_INFINITY);

/**
 * The endpoints to look at in this run, in order: those that list tools (looked at daily), then
 * those never looked at, then the rest when their rest is over. The oldest look comes first.
 */
export function planChecks(endpoints: Iterable<Endpoint>, now: string, { maxChecks, perHost }: PlanOptions): Endpoint[] {
  const at = Date.parse(now);
  const listing: Endpoint[] = [], fresh: Endpoint[] = [], resting: Endpoint[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.signedIn) continue;
    if (!endpoint.inRegistry && age(endpoint.leftRegistry, at) > 7 * day) continue;
    const since = age(endpoint.lastChecked, at);
    if (!endpoint.lastChecked) fresh.push(endpoint);
    else if (endpoint.outcome === "listed" ? since >= 20 * hour : since >= restingDays(endpoint) * day) (endpoint.outcome === "listed" ? listing : resting).push(endpoint);
  }
  const oldestFirst = (a: Endpoint, b: Endpoint) => age(b.lastChecked ?? b.firstSeen, at) - age(a.lastChecked ?? a.firstSeen, at) || (a.url < b.url ? -1 : 1);
  const plan: Endpoint[] = [];
  const perHostCount = new Map<string, number>();
  for (const endpoint of [...listing.sort(oldestFirst), ...fresh.sort(oldestFirst), ...resting.sort(oldestFirst)]) {
    if (plan.length >= maxChecks) break;
    const host = new URL(endpoint.url).hostname;
    const count = perHostCount.get(host) ?? 0;
    if (count >= perHost) continue;
    perHostCount.set(host, count + 1);
    plan.push(endpoint);
  }
  return plan;
}

const fields: ChangedField[] = ["title", "description", "inputSchema", "outputSchema", "annotations"];
const shortHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);

/** One tool as the tracker keeps it: its name, what it is counted as doing, and a fingerprint of each field. */
export interface ToolPrint { name: string; kind: AuthorityKind; fields: Partial<Record<ChangedField, string>> }

/**
 * A tool list as the tracker keeps it. Small enough to keep for every endpoint, and enough to say
 * which tools and which of their fields changed. The full definitions are kept only for servers
 * watched with a login; for the rest, the server itself is the place to read them.
 */
export interface ListPrint { source: string; takenAt: string; server?: { name?: string; version?: string }; tools: ToolPrint[] }

export function printOf(snapshot: Snapshot): ListPrint {
  const tools = snapshot.tools.map((tool) => ({
    name: toolKey(tool),
    kind: assessTool(tool).tool.kind,
    fields: Object.fromEntries(fields.filter((field) => tool[field] !== undefined).map((field) => [field, shortHash(tool[field])])),
  }));
  return { source: snapshot.source, takenAt: snapshot.takenAt, ...(snapshot.server ? { server: snapshot.server } : {}), tools };
}

/** A print read back from a file, or null when the file is not one. */
export function readPrint(value: unknown): ListPrint | null {
  if (typeof value !== "object" || value === null) return null;
  const { source, takenAt, tools } = value as Record<string, unknown>;
  if (typeof source !== "string" || typeof takenAt !== "string" || !Array.isArray(tools)) return null;
  const ok = tools.every((tool) => typeof tool === "object" && tool !== null && typeof tool.name === "string" && seriousFirst.includes(tool.kind) && typeof tool.fields === "object" && tool.fields !== null);
  return ok ? (value as ListPrint) : null;
}

/** A fingerprint of a whole list, to tell a change without opening the saved list. */
export const listHashOf = (print: ListPrint) => createHash("sha256").update(canonical(print.tools)).digest("hex");

export function kindCounts(report: AuthorityReport): KindCounts {
  const counts = Object.fromEntries(seriousFirst.map((kind) => [kind, 0])) as KindCounts;
  for (const group of report.groups) counts[group.kind] = group.tools.length;
  return counts;
}

const rankOf = (kind: AuthorityKind) => seriousFirst.indexOf(kind);
const listedNames = (names: string[], most = 5) => (names.length > most ? `${names.slice(0, most).join(", ")} and ${names.length - most} more` : names.join(", "));
const kindWords: Record<AuthorityKind, string> = { ...canDo, unclear: "not clear what it does" };

/** One sentence per kind of change, written by the scanner. Tool names are given as identifiers. */
export function describeChange(change: Omit<ChangeRecord, "summary">): string {
  const parts: string[] = [];
  const touching = (...which: ChangedField[]) => change.changed.filter((tool) => tool.fields.some((field) => which.includes(field))).map((tool) => tool.name);
  if (change.added.length) parts.push(`${plural(change.added.length, "tool")} added: ${listedNames(change.added)}.`);
  if (change.removed.length) parts.push(`${plural(change.removed.length, "tool")} removed: ${listedNames(change.removed)}.`);
  const described = touching("description"), titled = touching("title"), labelled = touching("annotations"), shaped = touching("inputSchema", "outputSchema");
  if (described.length) parts.push(`Description rewritten on ${listedNames(described)}.`);
  if (titled.length) parts.push(`Title changed on ${listedNames(titled)}.`);
  if (labelled.length) parts.push(`The server's own labels changed on ${listedNames(labelled)}.`);
  if (shaped.length) parts.push(`Inputs or outputs changed on ${listedNames(shaped)}.`);
  if (change.moreSerious.length) parts.push(`Counted as able to do more: ${listedNames(change.moreSerious.map((tool) => `${tool.name} (${kindWords[tool.kind]})`), 3)}.`);
  return parts.join(" ") || "The tool list changed.";
}

/** What changed between two lists, in the tracker's terms. */
export function changeBetween(before: ListPrint, after: ListPrint, since: string): ChangeRecord {
  const earlier = new Map(before.tools.map((tool) => [tool.name, tool]));
  const later = new Map(after.tools.map((tool) => [tool.name, tool]));
  const shown = (name: string) => shownName({ name });
  const changed = after.tools.flatMap((tool) => {
    const was = earlier.get(tool.name);
    const differing = was ? fields.filter((field) => was.fields[field] !== tool.fields[field]) : [];
    return differing.length ? [{ name: shown(tool.name), fields: differing }] : [];
  });
  const moreSerious = after.tools.flatMap((tool) => {
    const was = earlier.get(tool.name);
    return (was ? rankOf(tool.kind) < rankOf(was.kind) : tool.kind !== "read") ? [{ name: shown(tool.name), kind: tool.kind }] : [];
  });
  const change = {
    at: after.takenAt,
    since,
    added: after.tools.filter((tool) => !earlier.has(tool.name)).map((tool) => shown(tool.name)),
    removed: before.tools.filter((tool) => !later.has(tool.name)).map((tool) => shown(tool.name)),
    changed,
    moreSerious: moreSerious.sort((a, b) => rankOf(a.kind) - rankOf(b.kind)),
  };
  return { ...change, summary: describeChange(change) };
}

export type CheckResult = ListToolsResult | { outcome: "no-token" };

/**
 * Records one look at an endpoint. When the list is new or different, returns it to be saved, in
 * full and as a print; an unchanged list is not saved again, so the history of the saved files is
 * the history of changes.
 */
export function recordCheck(endpoint: Endpoint, result: CheckResult, now: string, previous: ListPrint | null): { snapshot: Snapshot; print: ListPrint } | null {
  const outcome: CheckOutcome = result.outcome;
  endpoint.checks = [...endpoint.checks, `${now} ${outcomeCode[outcome]}`].slice(-keptChecks);
  if (endpoint.outcome !== outcome) endpoint.outcomeSince = now;
  endpoint.outcome = outcome;
  endpoint.lastChecked = now;
  if (result.outcome !== "listed") return null;

  const snapshot = takeSnapshot(endpoint.url, result.tools, result.server, now);
  const print = printOf(snapshot);
  const listHash = listHashOf(print);
  const report = authorityOf(snapshot);
  const unchanged = previous !== null && listHashOf(previous) === listHash;
  if (previous && !unchanged && endpoint.lastListed) endpoint.changes = [changeBetween(previous, print, endpoint.lastListed), ...endpoint.changes].slice(0, keptChanges);
  endpoint.listHash = listHash;
  endpoint.lastListed = now;
  endpoint.tools = snapshot.tools.length;
  endpoint.kinds = kindCounts(report);
  if (report.declaredName) endpoint.declaredName = report.declaredName;
  else delete endpoint.declaredName;
  endpoint.file = printFile(endpoint);
  return unchanged ? null : { snapshot, print };
}

/** The recent checks as times and outcomes. */
export const checksOf = (endpoint: Endpoint) => endpoint.checks.map((entry) => {
  const [at = "", code = ""] = entry.split(" ");
  return { at, outcome: codeOutcome[code] ?? "not-usable" };
});

// The feed: what the web page reads. Versioned, so the page can refuse a shape it does not know.

export interface FeedChange extends ChangeRecord { id: string; url: string; names: string[]; declaredName?: string; changesIn30Days: number }

export interface FeedServer {
  id: string;
  url: string;
  names: string[];
  declaredName?: string;
  tools: number;
  kinds: KindCounts;
  lastChecked: string;
  lastListed: string;
  outcome: CheckOutcome;
  changesIn30Days: number;
  lastChange?: string;
}

export interface FeedWatched {
  id: string;
  vendor: string;
  url: string;
  declaredName?: string;
  firstSeen: string;
  lastChecked?: string;
  lastListed?: string;
  outcome?: CheckOutcome;
  tools?: number;
  kinds?: KindCounts;
  /** Tool names under the most serious thing each is counted as doing. */
  groups: Array<{ kind: AuthorityKind; tools: string[] }>;
  checks: Array<{ at: string; outcome: CheckOutcome }>;
  changes: ChangeRecord[];
}

export interface Feed {
  version: 1;
  generatedAt: string;
  registry: { readAt: string; complete: boolean; entries: number; endpoints: number };
  coverage: {
    /** Endpoints the registry lists today. */
    endpoints: number;
    checked: number;
    neverChecked: number;
    /** By the outcome of each endpoint's latest check. */
    listed: number;
    signInRequired: number;
    notUsable: number;
    unreachable: number;
    /** Endpoints whose tools were listed in the last 48 hours: the ones whose changes are being followed closely. */
    listedLast48Hours: number;
  };
  watched: FeedWatched[];
  /** The latest change on each endpoint that changed in the last 30 days, newest first. */
  changes: FeedChange[];
}

const mostChanges = 300;

export function buildFeed(endpoints: Endpoint[], watchedReports: Map<string, AuthorityReport>, registry: Feed["registry"], now: string): { feed: Feed; servers: FeedServer[] } {
  const at = Date.parse(now);
  const public_ = endpoints.filter((endpoint) => !endpoint.signedIn && endpoint.inRegistry);
  const count = (outcome: CheckOutcome) => public_.filter((endpoint) => endpoint.outcome === outcome).length;
  const recent = (endpoint: Endpoint) => endpoint.changes.filter((change) => age(change.at, at) <= 30 * day);
  const ofEndpoint = (endpoint: Endpoint) => ({ id: endpoint.id, url: endpoint.url, names: endpoint.names, ...(endpoint.declaredName ? { declaredName: endpoint.declaredName } : {}) });

  const changes: FeedChange[] = endpoints
    .filter((endpoint) => !endpoint.signedIn)
    .flatMap((endpoint) => {
      const inPeriod = recent(endpoint);
      return inPeriod[0] ? [{ ...ofEndpoint(endpoint), ...inPeriod[0], changesIn30Days: inPeriod.length }] : [];
    })
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.url < b.url ? -1 : 1))
    .slice(0, mostChanges);

  const watched: FeedWatched[] = endpoints.filter((endpoint) => endpoint.signedIn).map((endpoint) => {
    const report = watchedReports.get(endpoint.id);
    return {
      id: endpoint.id, vendor: endpoint.signedIn as string, url: endpoint.url,
      ...(endpoint.declaredName ? { declaredName: endpoint.declaredName } : {}),
      firstSeen: endpoint.firstSeen,
      ...(endpoint.lastChecked ? { lastChecked: endpoint.lastChecked } : {}),
      ...(endpoint.lastListed ? { lastListed: endpoint.lastListed } : {}),
      ...(endpoint.outcome ? { outcome: endpoint.outcome } : {}),
      ...(endpoint.tools !== undefined ? { tools: endpoint.tools } : {}),
      ...(endpoint.kinds ? { kinds: endpoint.kinds } : {}),
      groups: report ? report.groups.map((group) => ({ kind: group.kind, tools: group.tools.map((tool) => tool.name) })) : [],
      checks: checksOf(endpoint),
      changes: endpoint.changes.slice(0, 10),
    };
  }).sort((a, b) => (a.vendor < b.vendor ? -1 : 1));

  const servers: FeedServer[] = public_
    .filter((endpoint) => endpoint.lastListed && endpoint.kinds && endpoint.lastChecked && endpoint.outcome)
    .map((endpoint) => ({
      ...ofEndpoint(endpoint),
      tools: endpoint.tools ?? 0, kinds: endpoint.kinds as KindCounts,
      lastChecked: endpoint.lastChecked as string, lastListed: endpoint.lastListed as string, outcome: endpoint.outcome as CheckOutcome,
      changesIn30Days: recent(endpoint).length,
      ...(endpoint.changes[0] ? { lastChange: endpoint.changes[0].at } : {}),
    }))
    .sort((a, b) => (a.url < b.url ? -1 : 1));

  const feed: Feed = {
    version: 1,
    generatedAt: now,
    registry,
    coverage: {
      endpoints: public_.length,
      checked: public_.filter((endpoint) => endpoint.lastChecked).length,
      neverChecked: public_.filter((endpoint) => !endpoint.lastChecked).length,
      listed: count("listed"), signInRequired: count("sign-in-required"), notUsable: count("not-usable"), unreachable: count("unreachable"),
      listedLast48Hours: public_.filter((endpoint) => age(endpoint.lastListed, at) <= 48 * hour).length,
    },
    watched,
    changes,
  };
  return { feed, servers };
}

/** Starts the record of a server scanned with a token. */
export function watchedEndpoint(vendor: string, url: string, now: string): Endpoint {
  return { id: `signed-in-${vendor}`, url, names: [], signedIn: vendor, firstSeen: now, inRegistry: false, checks: [], changes: [] };
}
