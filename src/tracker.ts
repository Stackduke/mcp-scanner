import { createHash } from "node:crypto";
import { assessTool, authorityOf, canDo, confined, plural, seriousFirst, shownName } from "./authority.ts";
import type { AuthorityKind, AuthorityReport } from "./authority.ts";
import type { ErrorClass, ListToolsResult } from "./client.ts";
import { catalog, publicList } from "./catalog.ts";
import type { PublicServer } from "./catalog.ts";
import type { ChangedField } from "./diff.ts";
import type { RegistryRead } from "./registry.ts";
import { methodVersion } from "./method.ts";
import { canonical, takeSnapshot, toolKey } from "./snapshot.ts";
import type { Snapshot } from "./types.ts";

/**
 * The public tracker: which endpoints to look at, what each look found, and the feed a web page reads.
 *
 * The same rules as the plain-language report hold here, because the feed is published:
 * - every tool is read the more serious way (the counts come from `authorityOf`);
 * - nothing says what a server cannot do, or that it is safe;
 * - a server's words appear only as identifiers: tool names cut to the characters tool names
 *   normally have. Its name for itself is not published;
 * - a count of tools is given only for what was found: a kind with no tools is left out, never 0;
 * - nothing claims a period was quiet unless it was watched. Each change says between which two
 *   successful scans it happened, and each endpoint keeps a record of its recent checks.
 * The text checks for planted instructions are not published here. A finding goes to a person
 * first, so a vendor can be told privately.
 */
export type CheckOutcome = "listed" | "sign-in-required" | "not-usable" | "unreachable" | "no-token";
const outcomeCode: Record<CheckOutcome, string> = { listed: "L", "sign-in-required": "S", "not-usable": "N", unreachable: "U", "no-token": "T" };
const codeOutcome = Object.fromEntries(Object.entries(outcomeCode).map(([outcome, code]) => [code, outcome])) as Record<string, CheckOutcome>;

/**
 * What a server says about its own tools, from the annotations it sends: marked read-only, marked
 * destructive, marked as changing things without being destructive, or given no such label.
 * These are the server's claims, not the scanner's reading, so they can be added up across servers.
 */
export interface Labels { readOnly: number; changes: number; destructive: number; none: number }

export function labelsOf(tools: Array<{ annotations?: Record<string, unknown> }>): Labels {
  const labels: Labels = { readOnly: 0, changes: 0, destructive: 0, none: 0 };
  for (const { annotations = {} } of tools) {
    const { readOnlyHint, destructiveHint } = annotations;
    if (readOnlyHint === true) labels.readOnly += 1;
    else if (destructiveHint === true) labels.destructive += 1;
    else if (typeof readOnlyHint === "boolean" || typeof destructiveHint === "boolean") labels.changes += 1;
    else labels.none += 1;
  }
  return labels;
}

/** How many tools are counted under each kind. A kind with none is left out: a 0 would read as "cannot". */
export type KindCounts = Partial<Record<AuthorityKind, number>>;

export interface ChangeRecord {
  /** The scan that saw the change. */
  at: string;
  /** The last scan before it that listed tools. The change happened somewhere between the two. */
  since: string;
  /** At most `keptNames` names each; `counts` has the full numbers. */
  added: string[];
  removed: string[];
  changed: Array<{ name: string; fields: ChangedField[] }>;
  /** Tools added or changed that are counted as able to do more than before, with the most serious thing each now does. */
  moreSerious: Array<{ name: string; kind: AuthorityKind }>;
  counts: { added: number; removed: number; changed: number; moreSerious: number };
  /** Seen on a list that did not read the same twice, on a second run in a row: recorded, but the server is flapping. */
  unstable?: true;
  /** Written by the scanner. Tool names are the only words of the server's in it. */
  summary: string;
  /** The method version that recorded the change. Records from before 26 November 2026 have none. */
  methodVersion?: string;
}

/**
 * What one check found out besides its outcome. `retries` counts the extra attempts made after a failure that may
 * clear up; `unstable` marks a check whose list changed and, read again at once, did not read the same.
 */
/** A check's error class, or the tracker's own reason for not making it: the host had used its time for this run. */
export type CheckErrorClass = ErrorClass | "host_budget_exceeded";

export interface CheckFacts {
  errorClass?: CheckErrorClass;
  status?: number;
  protocolVersion?: string;
  retries?: number;
  unstable?: boolean;
}

/** The latest check in full. Its time is the endpoint's `lastChecked`. */
export interface LastCheck { errorClass?: CheckErrorClass; status?: number; protocolVersion?: string; retries: number; unstable?: true }

/** A server held back from recording a flapping list once per this many days at most. */
export const flapHoldBackDays = 7;

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
  labels?: Labels;
  /** Where the latest tool list is kept, relative to the data folder. */
  file?: string;
  /** The most recent checks, newest last, as `<time> <code>`. */
  checks: string[];
  /** The latest check's facts. Missing on an endpoint not checked since they were first recorded. */
  lastCheck?: LastCheck;
  /**
   * The checks among `checks` with something to say, newest last, as `<time> <error class> <status or -> <retries>`,
   * and ` unstable` when the list did not read the same twice. A check that listed tools at the first attempt has
   * none, nor does any check made before these were first recorded.
   */
  checkDetails?: string[];
  /** When the list last changed and, read again at once, did not read the same. */
  unstable?: string;
  /** When a check was last left for the next run because its host had used its time: not a check, nor a failure. */
  lastSkipped?: string;
  /** Newest first. */
  changes: ChangeRecord[];
}

const keptChecks = 40;
const keptChanges = 10;
/** Names kept per list in a change, so a server renaming thousands of tools cannot bloat the published files. */
export const keptNames = 20;
/** Fewer again in the feed, which a web page loads whole. */
const feedNames = 10;
/** The feed stops adding changes past this size, and says how many it left out. */
const feedBudgetBytes = 1_000_000;
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
    if (known) { known.names = list; known.inRegistry = true; delete known.leftRegistry; }
    else endpoints.set(url, { id: endpointId(url), url, names: list, firstSeen: now, inRegistry: true, checks: [], changes: [] });
  }
  if (!read.complete) return;
  for (const endpoint of endpoints.values()) {
    if (named.has(endpoint.url) || !endpoint.inRegistry) continue;
    endpoint.inRegistry = false;
    endpoint.leftRegistry = now;
  }
}

export interface PlanOptions {
  /** Most endpoints looked at in one run. */
  maxChecks: number;
  /** Most endpoints on one host in one run, so a host listing thousands of endpoints is not hammered. */
  perHost: number;
  /** Most endpoints on one site (a domain and its subdomains) in one run, so many subdomains cannot fill a run. */
  perSite: number;
}

// Hosting shared by many unrelated owners: there, each host is its own site.
const sharedHosting = ["workers.dev", "pages.dev", "vercel.app", "netlify.app", "github.io", "onrender.com", "fly.dev", "herokuapp.com", "supabase.co", "railway.app", "deno.dev", "run.app", "azurewebsites.net", "azurecontainerapps.io", "amazonaws.com", "replit.app", "modal.run", "ngrok-free.app", "web.app", "firebaseapp.com", "hf.space", "glitch.me"];

/** The site an address belongs to: its registrable domain, roughly, or the whole host on shared hosting. */
export function siteOf(url: string): string {
  // A name ending in dots (mcp.example.com.) is the same host to DNS, so it is the same site here.
  const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  if (sharedHosting.some((suffix) => host.endsWith(`.${suffix}`))) return host;
  const labels = host.split(".");
  // example.co.uk, example.com.au: a country's own second level is part of the suffix.
  const countrySecondLevel = /^[a-z]{2}$/.test(labels.at(-1) ?? "") && ["co", "com", "net", "org", "ac", "gov", "edu"].includes(labels.at(-2) ?? "");
  return labels.slice(countrySecondLevel ? -3 : -2).join(".");
}

/** Whether an address is on one of the sites given. One that cannot be read as an address is not. */
export function onSites(url: unknown, sites: ReadonlySet<string>): boolean {
  if (typeof url !== "string") return false;
  try { return sites.has(siteOf(url)); } catch { return false; }
}

/** The host in a list file's name (lists/ab/<host>-<id>.json), as an address. */
export const listFileUrl = (listPath: string) => {
  const host = /^lists\/[^/]+\/(.+)-[^-/]+\.json$/.exec(listPath)?.[1];
  return host ? `https://${host}/` : undefined;
};

/**
 * Whether a saved tool list is about one of the sites given: by the host in its file name, or by the address it
 * says it was read from (`source`), since a long host is cut short in the name.
 */
export function listOnSites(listPath: string, bytes: Buffer | string, sites: ReadonlySet<string>): boolean {
  if (onSites(listFileUrl(listPath), sites)) return true;
  try { return onSites((JSON.parse(bytes.toString()) as { source?: unknown } | null)?.source, sites); } catch { return false; }
}

/** How long to wait before looking again at an endpoint that did not list tools: 4 to 10 days, spread by address. */
const restingDays = (endpoint: Endpoint) => 4 + (Number.parseInt(endpoint.id.slice(0, 4), 16) % 7);
const age = (time: string | undefined, now: number) => (time ? now - Date.parse(time) : Number.POSITIVE_INFINITY);

/**
 * The endpoints to look at in this run, in order: those that list tools (looked at daily), then
 * those never looked at, then the rest when their rest is over. The oldest look comes first.
 */
export function planChecks(endpoints: Iterable<Endpoint>, now: string, { maxChecks, perHost, perSite }: PlanOptions): Endpoint[] {
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
  const perHostCount = new Map<string, number>(), perSiteCount = new Map<string, number>();
  for (const endpoint of [...listing.sort(oldestFirst), ...fresh.sort(oldestFirst), ...resting.sort(oldestFirst)]) {
    if (plan.length >= maxChecks) break;
    const host = new URL(endpoint.url).hostname, site = siteOf(endpoint.url);
    const onHost = perHostCount.get(host) ?? 0, onSite = perSiteCount.get(site) ?? 0;
    if (onHost >= perHost || onSite >= perSite) continue;
    perHostCount.set(host, onHost + 1);
    perSiteCount.set(site, onSite + 1);
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
export interface ListPrint {
  source: string;
  takenAt: string;
  /** The method version whose rules gave each tool its kind. Files from before 26 November 2026 have none. */
  methodVersion?: string;
  server?: { name?: string; version?: string };
  tools: ToolPrint[];
}

export function printOf(snapshot: Snapshot): ListPrint {
  const tools = snapshot.tools.map((tool) => ({
    name: toolKey(tool),
    kind: assessTool(tool).tool.kind,
    fields: Object.fromEntries(fields.filter((field) => tool[field] !== undefined).map((field) => [field, shortHash(tool[field])])),
  }));
  return { source: snapshot.source, takenAt: snapshot.takenAt, methodVersion, ...(snapshot.server ? { server: snapshot.server } : {}), tools };
}

/** A print read back from a file, or null when the file is not one. */
export function readPrint(value: unknown): ListPrint | null {
  if (typeof value !== "object" || value === null) return null;
  const { source, takenAt, tools } = value as Record<string, unknown>;
  if (typeof source !== "string" || typeof takenAt !== "string" || !Array.isArray(tools)) return null;
  const ok = tools.every((tool) => typeof tool === "object" && tool !== null && typeof tool.name === "string" && seriousFirst.includes(tool.kind) && typeof tool.fields === "object" && tool.fields !== null);
  return ok ? (value as ListPrint) : null;
}

/**
 * A fingerprint of a whole list, to tell a change without opening the saved list. It covers what the
 * server sent and nothing the scanner decided, so a change to the scanner's rules is not a change.
 */
export const listHashOf = (print: ListPrint) => createHash("sha256").update(canonical(print.tools.map(({ name, fields }) => ({ name, fields })))).digest("hex");

export function kindCounts(report: AuthorityReport): KindCounts {
  return Object.fromEntries(report.groups.filter((group) => group.tools.length).map((group) => [group.kind, group.tools.length]));
}

const rankOf = (kind: AuthorityKind) => seriousFirst.indexOf(kind);
const kindWords: Record<AuthorityKind, string> = { ...canDo, unclear: "not clear what it does" };

/** One sentence per kind of change, written by the scanner. Tool names are given as identifiers. */
export function describeChange(change: Omit<ChangeRecord, "summary">): string {
  const parts: string[] = [];
  const { counts } = change;
  const listedNames = (names: string[], total = names.length, most = 5) => {
    const shown = names.slice(0, most);
    return total > shown.length ? `${shown.join(", ")} and ${total - shown.length} more` : shown.join(", ");
  };
  const touching = (...which: ChangedField[]) => change.changed.filter((tool) => tool.fields.some((field) => which.includes(field))).map((tool) => tool.name);
  if (counts.added) parts.push(`${plural(counts.added, "tool")} added: ${listedNames(change.added, counts.added)}.`);
  if (counts.removed) parts.push(`${plural(counts.removed, "tool")} removed: ${listedNames(change.removed, counts.removed)}.`);
  const described = touching("description"), titled = touching("title"), labelled = touching("annotations"), shaped = touching("inputSchema", "outputSchema");
  if (described.length) parts.push(`Description rewritten on ${listedNames(described)}.`);
  if (titled.length) parts.push(`Title changed on ${listedNames(titled)}.`);
  if (labelled.length) parts.push(`The server's own labels changed on ${listedNames(labelled)}.`);
  if (shaped.length) parts.push(`Inputs or outputs changed on ${listedNames(shaped)}.`);
  if (counts.changed > change.changed.length) parts.push(`${plural(counts.changed, "tool")} changed in all.`);
  if (counts.moreSerious) parts.push(`Counted as able to do more: ${listedNames(change.moreSerious.map((tool) => `${tool.name} (${kindWords[tool.kind]})`), counts.moreSerious, 3)}.`);
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
    return differing.length ? [{ name: tool.name, fields: differing, kind: tool.kind, was: was?.kind }] : [];
  });
  const added = after.tools.filter((tool) => !earlier.has(tool.name));
  const removed = before.tools.filter((tool) => !later.has(tool.name));
  // Only tools the server added or changed: a tool it left alone is not counted as doing more because the scanner's rules moved.
  const moreSerious = [
    ...added.filter((tool) => tool.kind !== "read"),
    ...changed.filter((tool) => tool.was !== undefined && rankOf(tool.kind) < rankOf(tool.was)),
  ].sort((a, b) => rankOf(a.kind) - rankOf(b.kind));
  const change = {
    at: after.takenAt,
    since,
    added: added.slice(0, keptNames).map((tool) => shown(tool.name)),
    removed: removed.slice(0, keptNames).map((tool) => shown(tool.name)),
    changed: changed.slice(0, keptNames).map((tool) => ({ name: shown(tool.name), fields: tool.fields })),
    moreSerious: moreSerious.slice(0, keptNames).map((tool) => ({ name: shown(tool.name), kind: tool.kind })),
    counts: { added: added.length, removed: removed.length, changed: changed.length, moreSerious: moreSerious.length },
  };
  return { ...change, summary: describeChange(change), methodVersion };
}

export type CheckResult = ListToolsResult | { outcome: "no-token" };

/** The fingerprint of a list as it would be saved, or null when the list cannot be processed. */
export function listHashOfResult(url: string, result: CheckResult, now: string): string | null {
  if (result.outcome !== "listed") return null;
  try { return listHashOf(printOf(takeSnapshot(url, result.tools, result.server, now))); } catch { return null; }
}

/**
 * A list that differed from the saved one was read again at once. When the second read gives the same new list, the
 * change stands. When it gives the saved list back, or yet another list, the server is flapping: it is marked
 * unstable and no change is recorded. A second read that lists nothing proves neither, so the change stands.
 */
export function rereadVerdict(first: string, second: string | null): "changed" | "unstable" {
  return second === null || second === first ? "changed" : "unstable";
}

/**
 * Adds a check's line to `checkDetails` when it has something new to say, and drops lines older than the checks kept.
 * A line holds for the checks after it until the next line, so one that repeats the class and status of the check
 * before it is not written, and the newest line older than the kept checks stays: it still describes the oldest ones.
 */
export function withDetail(endpoint: Endpoint, now: string, facts: CheckFacts, before: LastCheck | undefined): void {
  const errorClass = facts.errorClass ?? "ok";
  // After a skip's line, a check repeating the one before the skip still needs its own line, or the skip would describe it.
  const afterSkip = endpoint.checkDetails?.at(-1)?.split(" ")[1] === "host_budget_exceeded";
  const differs = afterSkip || errorClass !== (before?.errorClass ?? "ok") || facts.status !== before?.status;
  const entry = (errorClass !== "ok" && differs) || facts.retries || facts.unstable ? [detailOf(now, facts)] : [];
  const oldest = endpoint.checks[0]?.split(" ")[0] ?? now;
  const all = [...(endpoint.checkDetails ?? []), ...entry];
  const older = all.filter((line) => (line.split(" ")[0] ?? "") < oldest);
  const details = [...older.slice(-1), ...all.filter((line) => (line.split(" ")[0] ?? "") >= oldest)];
  if (details.length) endpoint.checkDetails = details; else delete endpoint.checkDetails;
}

/**
 * Records a check not made because its host had used its time for this run. It is the tracker's limit, not the
 * server's failure: no check, outcome or rest is recorded, so the endpoint is among the first looked at next run.
 */
export function recordSkipped(endpoint: Endpoint, now: string): void {
  endpoint.lastSkipped = now;
  // Its last real check is kept as it was; only a line says the endpoint was left.
  withDetail(endpoint, now, { errorClass: "host_budget_exceeded" }, undefined);
}

const detailOf = (now: string, facts: CheckFacts) => `${now} ${facts.errorClass ?? "-"} ${facts.status ?? "-"} ${facts.retries ?? 0}${facts.unstable ? " unstable" : ""}`;

/**
 * Records one look at an endpoint. When the list is new or different, returns it to be saved, in
 * full and as a print; an unchanged list is not saved again, so the history of the saved files is
 * the history of changes. The same list read differently by newer rules comes back with `reread`
 * set: its print holds the new reading and is saved, but the full list has not changed.
 */
export function recordCheck(endpoint: Endpoint, result: CheckResult, now: string, previous: ListPrint | null, facts: CheckFacts = {}): { snapshot: Snapshot; print: ListPrint; reread: boolean } | null {
  // Everything that can fail on a hostile list is worked out before the endpoint is touched.
  const listed = result.outcome === "listed" ? (() => {
    const snapshot = takeSnapshot(endpoint.url, result.tools, result.server, now);
    const print = printOf(snapshot);
    return { snapshot, print, listHash: listHashOf(print), kinds: kindCounts(authorityOf(snapshot)), labels: labelsOf(snapshot.tools) };
  })() : null;

  endpoint.checks = [...endpoint.checks, `${now} ${outcomeCode[result.outcome]}`].slice(-keptChecks);
  if (endpoint.outcome !== result.outcome) endpoint.outcomeSince = now;
  endpoint.outcome = result.outcome;
  endpoint.lastChecked = now;
  const unstable = Boolean(listed && previous && facts.unstable);
  // A flapping list is held back only when the server has not flapped in the last week. A server that flaps again
  // within it, however many clean runs come between, has the first read's list recorded, its change marked unstable.
  const flappedRecently = endpoint.unstable !== undefined && Date.parse(now) - Date.parse(endpoint.unstable) < flapHoldBackDays * day;
  const heldBack = unstable && !flappedRecently;
  const retries = facts.retries ?? 0;
  const before = endpoint.lastCheck;
  endpoint.lastCheck = {
    ...(facts.errorClass ? { errorClass: facts.errorClass } : {}), ...(facts.status !== undefined ? { status: facts.status } : {}),
    ...(facts.protocolVersion ? { protocolVersion: facts.protocolVersion } : {}), retries, ...(unstable ? { unstable: true as const } : {}),
  };
  withDetail(endpoint, now, { ...facts, retries, unstable }, before);
  if (!listed) return null;
  if (unstable) endpoint.unstable = now;
  // lastListed stays when the saved list was last confirmed, so a later change's `since` cannot leave out when it happened.
  if (heldBack) return null;

  const unchanged = previous !== null && listHashOf(previous) === listed.listHash;
  // The server sent the same list, but the scanner now reads it differently: keep the new reading, record no change.
  const reread = unchanged && canonical(previous.tools.map((tool) => tool.kind)) !== canonical(listed.print.tools.map((tool) => tool.kind));
  if (previous && !unchanged && endpoint.lastListed) endpoint.changes = [{ ...changeBetween(previous, listed.print, endpoint.lastListed), ...(unstable ? { unstable: true as const } : {}) }, ...endpoint.changes].slice(0, keptChanges);
  endpoint.listHash = listed.listHash;
  endpoint.lastListed = now;
  endpoint.tools = listed.snapshot.tools.length;
  endpoint.kinds = listed.kinds;
  endpoint.labels = listed.labels;
  endpoint.file = printFile(endpoint);
  return unchanged && !reread ? null : { snapshot: listed.snapshot, print: listed.print, reread };
}

/** The recent checks as times and outcomes. */
export const checksOf = (endpoint: Endpoint) => endpoint.checks.flatMap((entry) => {
  const [at = "", code = ""] = entry.split(" ");
  const outcome = codeOutcome[code];
  return outcome ? [{ at, outcome }] : [];
});

// The feed: what the web page reads. Versioned, so the page can refuse a shape it does not know.

/**
 * How closely an endpoint was watched in the last 30 days: how many checks were made and how many
 * of them listed tools. "No change" means something only when these are high.
 */
export interface Watch { checks: number; listed: number }

export interface FeedChange extends ChangeRecord { id: string; url: string; names: string[]; firstSeen: string; changesIn30Days: number; watchIn30Days: Watch }

export interface FeedServer {
  id: string;
  url: string;
  names: string[];
  firstSeen: string;
  tools: number;
  kinds: KindCounts;
  lastChecked: string;
  lastListed: string;
  outcome: CheckOutcome;
  changesIn30Days: number;
  watchIn30Days: Watch;
  lastChange?: string;
  /** When its list last changed and did not read the same when read again at once. */
  unstable?: string;
}

/** What the catalog says about a watched server that a reader needs: its name and website. */
function catalogFacts(vendor: string): { name?: string; site?: string } {
  const entry = catalog.servers.find((server) => server.id === vendor);
  return entry ? { name: entry.name, site: entry.site } : {};
}

export interface FeedWatched {
  id: string;
  vendor: string;
  /** The vendor's name and website, from the catalog, for a page about this server. */
  name?: string;
  site?: string;
  url: string;
  firstSeen: string;
  lastChecked?: string;
  lastListed?: string;
  outcome?: CheckOutcome;
  tools?: number;
  kinds?: KindCounts;
  /** Tool names under the most serious thing each is counted as doing. "read" means said to only read. */
  groups: Array<{ kind: AuthorityKind; tools: string[] }>;
  checks: Array<{ at: string; outcome: CheckOutcome }>;
  /** The latest check's facts: why it ended as it did, the status, the protocol version agreed, how many retries. */
  lastCheck?: LastCheck;
  unstable?: string;
  changes: ChangeRecord[];
}

export interface RegistryState {
  /** The last read that returned entries, and whether it went to the end. */
  readAt: string;
  complete: boolean;
  entries: number;
  endpoints: number;
  /** The last attempt, which may have failed: then the list of endpoints is the one from `readAt`. */
  attemptedAt: string;
  attemptOk: boolean;
}

export interface Feed {
  version: 1;
  generatedAt: string;
  registry: RegistryState;
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
    /** Tools listed by the endpoints whose latest check listed them. */
    toolsListed: number;
  };
  watched: FeedWatched[];
  /** The latest change on each endpoint that changed in the last 30 days, newest first, as many as fit. */
  changes: FeedChange[];
  /** How many endpoints changed in the last 30 days, shown or not. */
  changesTotal: number;
  /** When the first endpoint was checked: changes can only have been seen since then. */
  trackingSince: string;
  /**
   * What servers say about their own tools, added up over the endpoints whose labels are known
   * (those listed since labels were first recorded). `servers` says how many that is.
   */
  across: { servers: number; tools: number; labels: Labels };
}

const mostChanges = 300;

/** An address without a trailing slash, so the public list and the registry can be matched. */
const plainUrl = (url: string) => url.replace(/\/$/, "");

const shorterChange = (change: ChangeRecord): ChangeRecord => ({
  ...change,
  added: change.added.slice(0, feedNames), removed: change.removed.slice(0, feedNames),
  changed: change.changed.slice(0, feedNames), moreSerious: change.moreSerious.slice(0, feedNames),
});

/** One server for a page about it, from its endpoint. The caller names the vendor. */
function watchedEntry(endpoint: Endpoint, groups: FeedWatched["groups"]): FeedWatched {
  return {
    id: endpoint.id, vendor: endpoint.signedIn ?? "", url: endpoint.url, firstSeen: endpoint.firstSeen,
    ...(endpoint.lastChecked ? { lastChecked: endpoint.lastChecked } : {}),
    ...(endpoint.lastListed ? { lastListed: endpoint.lastListed } : {}),
    ...(endpoint.outcome ? { outcome: endpoint.outcome } : {}),
    ...(endpoint.tools !== undefined ? { tools: endpoint.tools } : {}),
    ...(endpoint.kinds ? { kinds: endpoint.kinds } : {}),
    groups,
    checks: checksOf(endpoint),
    ...(endpoint.lastCheck ? { lastCheck: endpoint.lastCheck } : {}),
    ...(endpoint.unstable ? { unstable: endpoint.unstable } : {}),
    changes: endpoint.changes.slice(0, 5).map(shorterChange),
  };
}

/** The servers watched with a login, each with its name and website from the catalog. */
export function watchedOf(endpoints: Endpoint[], reports: Map<string, AuthorityReport>): FeedWatched[] {
  return endpoints.filter((endpoint) => endpoint.signedIn).map((endpoint) => {
    const report = reports.get(endpoint.id);
    const groups = report ? report.groups.map((group) => ({ kind: group.kind, tools: group.tools.map((tool) => tool.name) })) : [];
    return { ...watchedEntry(endpoint, groups), ...catalogFacts(endpoint.signedIn as string) };
  }).sort((a, b) => (a.vendor < b.vendor ? -1 : 1));
}

/**
 * Tool names under the most serious thing each is counted as doing, from a saved tool list. A server
 * read with no sign-in has only this list (no full definitions are kept), which is all the page needs.
 */
export function groupsOfPrint(print: ListPrint | null): FeedWatched["groups"] {
  if (!print) return [];
  return seriousFirst.flatMap((kind) => {
    const tools = print.tools.filter((tool) => tool.kind === kind).map((tool) => tool.name).sort();
    return tools.length ? [{ kind, tools }] : [];
  });
}

export function buildFeed(
  endpoints: Endpoint[], watchedReports: Map<string, AuthorityReport>, registry: RegistryState, now: string,
  publicGroups: Map<string, FeedWatched["groups"]> = new Map(), publicServers: readonly PublicServer[] = publicList.servers,
): { feed: Feed; servers: FeedServer[] } {
  const at = Date.parse(now);
  const public_ = endpoints.filter((endpoint) => !endpoint.signedIn && endpoint.inRegistry);
  const count = (outcome: CheckOutcome) => public_.filter((endpoint) => endpoint.outcome === outcome).length;
  const inMonth = (time: string) => age(time, at) <= 30 * day;
  const recent = (endpoint: Endpoint) => endpoint.changes.filter((change) => inMonth(change.at));
  const watchOf = (endpoint: Endpoint): Watch => {
    const checks = checksOf(endpoint).filter((check) => inMonth(check.at));
    return { checks: checks.length, listed: checks.filter((check) => check.outcome === "listed").length };
  };
  const ofEndpoint = (endpoint: Endpoint) => ({ id: endpoint.id, url: endpoint.url, names: endpoint.names, firstSeen: endpoint.firstSeen });

  const allChanges = public_
    .flatMap((endpoint) => {
      const inPeriod = recent(endpoint);
      return inPeriod[0] ? [{ ...ofEndpoint(endpoint), ...shorterChange(inPeriod[0]), changesIn30Days: inPeriod.length, watchIn30Days: watchOf(endpoint) }] : [];
    })
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.url < b.url ? -1 : 1));
  const changes: FeedChange[] = [];
  let bytes = 0;
  for (const change of allChanges.slice(0, mostChanges)) {
    bytes += JSON.stringify(change).length;
    if (bytes > feedBudgetBytes) break;
    changes.push(change);
  }

  // The servers the page shows: those watched with a login that are published (none since 24 October
  // 2026), and the official servers that answer with no sign-in. A server tracked privately is never in
  // these endpoints: its files live in the private folder.
  const signedIn = watchedOf(endpoints.filter((endpoint) => endpoint.signedIn), watchedReports);
  const open = new Map(endpoints.filter((endpoint) => !endpoint.signedIn).map((endpoint) => [plainUrl(endpoint.url), endpoint]));
  const official = publicServers.flatMap((server): FeedWatched[] => {
    const endpoint = open.get(plainUrl(server.url));
    if (!endpoint) return [];
    return [{ ...watchedEntry(endpoint, publicGroups.get(endpoint.id) ?? []), vendor: server.id, name: server.name, site: server.site }];
  });
  const watched: FeedWatched[] = [...signedIn, ...official].sort((a, b) => (a.vendor < b.vendor ? -1 : 1));

  const servers: FeedServer[] = public_
    .flatMap((endpoint) => endpoint.lastListed && endpoint.kinds && endpoint.lastChecked && endpoint.outcome ? [{
      ...ofEndpoint(endpoint),
      tools: endpoint.tools ?? 0, kinds: endpoint.kinds,
      lastChecked: endpoint.lastChecked, lastListed: endpoint.lastListed, outcome: endpoint.outcome,
      changesIn30Days: recent(endpoint).length, watchIn30Days: watchOf(endpoint),
      ...(endpoint.changes[0] ? { lastChange: endpoint.changes[0].at } : {}),
      ...(endpoint.unstable ? { unstable: endpoint.unstable } : {}),
    }] : [])
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
      toolsListed: public_.filter((endpoint) => endpoint.outcome === "listed").reduce((sum, endpoint) => sum + (endpoint.tools ?? 0), 0),
    },
    watched,
    changes,
    changesTotal: allChanges.length,
    trackingSince: public_.reduce((first, endpoint) => (endpoint.checks[0] && (!first || endpoint.checks[0] < first) ? endpoint.checks[0].split(" ")[0] as string : first), ""),
    across: acrossOf(public_.filter((endpoint) => endpoint.outcome === "listed")),
  };
  return { feed, servers };
}

function acrossOf(listing: Endpoint[]): Feed["across"] {
  const labels: Labels = { readOnly: 0, changes: 0, destructive: 0, none: 0 };
  let servers = 0, tools = 0;
  for (const endpoint of listing) {
    if (!endpoint.labels) continue;
    servers += 1;
    tools += endpoint.tools ?? 0;
    for (const key of Object.keys(labels) as Array<keyof Labels>) labels[key] += endpoint.labels[key];
  }
  return { servers, tools, labels };
}

/**
 * Every endpoint that listed tools, small enough for a web page to search: registry name, address,
 * tool count, the day it last listed them, changes in 30 days, and what its tools are counted as doing.
 */
export type LookupRow = [name: string, url: string, tools: number, lastListed: string, changesIn30Days: number, kinds: KindCounts];
export const lookupOf = (servers: FeedServer[]): LookupRow[] => servers.map((server) => [server.names[0] ?? "", server.url, server.tools, server.lastListed.slice(0, 10), server.changesIn30Days, server.kinds]);

/** Starts the record of a server scanned with a token. */
export function watchedEndpoint(vendor: string, url: string, now: string): Endpoint {
  return { id: `signed-in-${vendor}`, url, names: [], signedIn: vendor, firstSeen: now, inRegistry: false, checks: [], changes: [] };
}
