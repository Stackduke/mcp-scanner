import { readFile } from "node:fs/promises";
import path from "node:path";
import { authorityOf } from "./authority.ts";
import type { AuthorityReport } from "./authority.ts";
import { listTools, userAgent } from "./client.ts";
import { crawl } from "./crawl.ts";
import { readSnapshot, snapshotText, writeWhole } from "./files.ts";
import { readRegistry } from "./registry.ts";
import type { RegistryRead } from "./registry.ts";
import { catalog } from "./catalog.ts";
import { scanSignedIn, signedInServers, tokenFor } from "./signed-in.ts";
import { buildFeed, lookupOf, mergeRegistry, planChecks, readPrint, recordCheck, siteOf, watchedEndpoint } from "./tracker.ts";
import type { CheckResult, Endpoint, RegistryState } from "./tracker.ts";

/**
 * One run of the public tracker, over a data folder:
 *
 *   endpoints.jsonl   every endpoint known, one per line: what the registry calls it, its recent checks and changes
 *   lists/            the latest tool list of each endpoint, as fingerprints, rewritten only when it changes
 *   watched/          the full definitions of each server watched with a login, rewritten only when they change
 *   registry.json     when the registry was last read, and whether to the end
 *   feed.json         what the web page reads: coverage, the servers watched with a login, recent changes
 *   servers.json      every endpoint that listed tools, with counts, for a searchable table
 *
 * The folder is meant to be committed after each run, so its history is the history of every change.
 */
export interface TrackOptions {
  dataDir: string;
  readRegistry: boolean;
  maxChecks: number;
  perHost: number;
  perSite: number;
  concurrency: number;
  hostGapMs: number;
  /** Minutes after which no new check starts. */
  budgetMinutes: number;
  /** The longest one check may take, all its requests together. Default 60 seconds. */
  checkTimeoutMs?: number;
  environment: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TrackSummary {
  registry: RegistryState;
  planned: number;
  checked: number;
  notStarted: number;
  changed: number;
  watched: Array<{ vendor: string; outcome: string }>;
}

async function readEndpoints(file: string): Promise<Endpoint[]> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Endpoint);
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return null; }
}

/** The full definitions of a server watched with a login, rewritten when they change. */
const watchedFile = (vendor: string) => `watched/${vendor}.json`;

/**
 * A check that has not finished in time counts as unreachable. Node does not wait for the request
 * timeouts alone (they do not keep it running), so without this ordinary timer a run whose checks
 * had all stalled would simply end, silently, before writing anything.
 */
async function withinTime(check: Promise<CheckResult>, ms: number): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<CheckResult>((resolve) => { timer = setTimeout(() => resolve({ outcome: "unreachable", detail: "TimeoutError" }), ms); });
  try { return await Promise.race([check.catch((): CheckResult => ({ outcome: "unreachable", detail: "error" })), late]); }
  finally { clearTimeout(timer); }
}

/**
 * Sites of vendors whose terms forbid publishing about their service, from the catalog: the site of
 * the MCP server's address and of the vendor's website. No address on them is checked or kept,
 * wherever the registry lists it.
 */
export function keptOffSites(servers = catalog.servers): Set<string> {
  return new Set(servers.flatMap((server) => (!server.tracker.publish && server.tracker.forbidden ? [siteOf(server.url), siteOf(server.site)] : [])));
}

function keptOff(url: string, sites: Set<string>): boolean {
  try { return sites.has(siteOf(url)); } catch { return false; }
}

/**
 * Why a watched server's check did not list, for the run's log, so a missed check says what happened.
 * Every reason is the scanner's own words (a status code or an error's type), never the server's text,
 * so it is safe in a public log.
 */
export function checkReason(result: CheckResult, recorded: string | undefined): string {
  if (result.outcome === "listed") return recorded === "not-usable" ? " (the list could not be processed)" : "";
  if (result.outcome === "sign-in-required") return ` (HTTP ${result.status})`;
  if (result.outcome === "no-token") return "";
  return ` (${result.detail})`;
}

const byId = (a: Endpoint, b: Endpoint) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function track(options: TrackOptions): Promise<TrackSummary> {
  const { dataDir, environment, fetchImpl, log = () => undefined } = options;
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const file = (relative: string) => path.join(dataDir, relative);

  const all = await readEndpoints(file("endpoints.jsonl"));
  const byUrl = new Map(all.filter((endpoint) => !endpoint.signedIn).map((endpoint) => [endpoint.url, endpoint]));
  const watched = new Map(all.filter((endpoint) => endpoint.signedIn).map((endpoint) => [endpoint.signedIn as string, endpoint]));

  const sites = keptOffSites();
  const none: RegistryState = { readAt: "", complete: false, entries: 0, endpoints: 0, attemptedAt: "", attemptOk: false };
  let registry: RegistryState = { ...none, ...(await readJson<Partial<RegistryState>>(file("registry.json"))) };
  if (options.readRegistry) {
    const read: RegistryRead = await readRegistry({ userAgent, ...(fetchImpl ? { fetchImpl } : {}) });
    log(`registry: ${read.entries.length} entries in ${read.pages} pages${read.complete ? "" : ", stopped before the end"}`);
    // An empty read is a registry that did not answer, not a registry with nothing in it.
    registry = { ...registry, attemptedAt: startedAt, attemptOk: read.entries.length > 0 && read.complete };
    if (read.entries.length) {
      mergeRegistry(byUrl, read, startedAt);
      // The count leaves out addresses kept off the tracker, so it matches what the feed covers.
      registry = { ...registry, readAt: startedAt, complete: read.complete, entries: read.entries.length, endpoints: new Set(read.entries.flatMap((entry) => entry.urls).filter((url) => !keptOff(url, sites))).size };
    }
  }

  for (const [url, endpoint] of byUrl) if (keptOff(endpoint.url, sites)) byUrl.delete(url);

  let changed = 0, failed = 0;
  /** Records one check. A list the scanner cannot handle (one nested too deeply, say) is that server's failure, not the run's. */
  async function record(endpoint: Endpoint, result: CheckResult, at: string): Promise<void> {
    const latestChange = endpoint.changes[0];
    const previous = result.outcome === "listed" && endpoint.file ? readPrint(await readJson(file(endpoint.file))) : null;
    if (result.outcome === "listed" && endpoint.lastListed && !previous) log(`${endpoint.id}: its saved list is missing, so this look starts afresh`);
    let saved: ReturnType<typeof recordCheck> = null;
    try { saved = recordCheck(endpoint, result, at, previous); }
    catch {
      failed += 1;
      recordCheck(endpoint, { outcome: "not-usable", detail: "the list could not be processed" }, at, null);
    }
    if (endpoint.changes[0] !== latestChange) changed += 1;
    if (!saved || !endpoint.file) return;
    await writeWhole(file(endpoint.file), `${JSON.stringify(saved.print)}\n`);
    // The definitions are rewritten only when the server changed them (or the file is missing), so a
    // watched file's history is its server's history. Its takenAt is when that version was first
    // seen; how recently it was confirmed is the endpoint's lastListed.
    if (!endpoint.signedIn) return;
    const watchedPath = file(watchedFile(endpoint.signedIn));
    if (!saved.reread || !(await readSnapshot(watchedPath))) await writeWhole(watchedPath, snapshotText(saved.snapshot));
  }

  // Servers watched with a login. A token that is not set is recorded as a missed check, once the server is being watched.
  for (const [vendor, server] of Object.entries(signedInServers)) {
    const hasToken = Boolean(tokenFor(server, environment)?.trim());
    const endpoint = watched.get(vendor) ?? (hasToken ? watchedEndpoint(vendor, server.url, startedAt) : null);
    if (!endpoint) continue;
    watched.set(vendor, endpoint);
    endpoint.url = server.url;
    const at = clock().toISOString();
    const scan = await scanSignedIn(vendor, environment, fetchImpl);
    if (scan.outcome === "unsafe-connection") throw new Error("Certificate checking is switched off here, so no token was sent.");
    if (scan.outcome === "token-echoed") log(`${vendor}: the server sent the token back. Nothing it returned was kept. Replace that token.`);
    const result: CheckResult = scan.outcome === "answered" ? scan.result : scan.outcome === "no-token" ? { outcome: "no-token" } : { outcome: "not-usable", detail: "the server sent the token back" };
    await record(endpoint, result, at);
    log(`${vendor}: ${endpoint.outcome}${checkReason(result, endpoint.outcome)}${endpoint.tools !== undefined ? `, ${endpoint.outcome === "listed" ? "" : "last listed "}${endpoint.tools} tools` : ""}`);
  }

  // Each result is recorded as soon as it arrives, so the run holds one list at a time per check, not all of them.
  const plan = planChecks(byUrl.values(), startedAt, { maxChecks: options.maxChecks, perHost: options.perHost, perSite: options.perSite });
  log(`planned ${plan.length} checks`);
  const deadline = Date.parse(startedAt) + options.budgetMinutes * 60_000;
  const { done, notStarted } = await crawl(plan, async (endpoint) => {
    const at = clock().toISOString();
    const result = await withinTime(listTools(endpoint.url, { ...(fetchImpl ? { fetchImpl } : {}), timeoutMs: 15_000 }), options.checkTimeoutMs ?? 60_000);
    await record(endpoint, result, at);
    return endpoint.outcome;
  }, { concurrency: options.concurrency, hostGapMs: options.hostGapMs, deadline, now: () => clock().getTime() });
  log(`checked ${done.length}, not started ${notStarted.length}, changed ${changed}, could not process ${failed}`);

  const endpoints = [...byUrl.values(), ...watched.values()].sort(byId);
  const reports = new Map<string, AuthorityReport>();
  for (const endpoint of watched.values()) {
    const snapshot = endpoint.lastListed ? await readSnapshot(file(watchedFile(endpoint.signedIn as string))) : null;
    if (snapshot) reports.set(endpoint.id, authorityOf(snapshot));
  }
  const { feed, servers } = buildFeed(endpoints, reports, registry, clock().toISOString());
  await writeWhole(file("endpoints.jsonl"), endpoints.map((endpoint) => JSON.stringify(endpoint)).join("\n") + (endpoints.length ? "\n" : ""));
  await writeWhole(file("registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
  await writeWhole(file("feed.json"), `${JSON.stringify(feed)}\n`);
  await writeWhole(file("servers.json"), `${JSON.stringify(servers)}\n`);
  await writeWhole(file("lookup.json"), `${JSON.stringify({ version: 1, generatedAt: feed.generatedAt, rows: lookupOf(servers) })}\n`);

  return {
    registry, planned: plan.length, checked: done.length, notStarted: notStarted.length, changed,
    watched: [...watched.entries()].map(([vendor, endpoint]) => ({ vendor, outcome: endpoint.outcome ?? "not checked" })),
  };
}
