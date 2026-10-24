import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { authorityOf } from "./authority.ts";
import type { AuthorityReport } from "./authority.ts";
import { listTools, userAgent } from "./client.ts";
import { crawl } from "./crawl.ts";
import { readSnapshot, snapshotText, writeWhole } from "./files.ts";
import { readRegistry } from "./registry.ts";
import type { RegistryRead } from "./registry.ts";
import { catalog, publicList } from "./catalog.ts";
import type { PublicServer } from "./catalog.ts";
import { scanSignedIn, signedInServers, tokenFor } from "./signed-in.ts";
import { buildFeed, endpointId, groupsOfPrint, lookupOf, mergeRegistry, planChecks, readPrint, recordCheck, siteOf, watchedEndpoint, watchedOf } from "./tracker.ts";
import type { CheckResult, Endpoint, FeedWatched, RegistryState } from "./tracker.ts";

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
 *
 * Servers tracked privately (every server that needs a sign-in, since 24 October 2026) keep the same
 * kind of files in a second, private folder: endpoints.jsonl, lists/, watched/ and a feed.json holding
 * only their entries. Nothing about them is written to the public folder, and when no private folder
 * is given they are not scanned at all. The official servers in catalog/tracker-public.json, which
 * answer with no sign-in, are checked on every run and shown on the page.
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
  /**
   * The private folder for servers tracked privately. Without it they are skipped: what they list
   * must never land in the public folder.
   */
  privateDataDir?: string;
  /** The servers the page shows that answer with no sign-in. Default: catalog/tracker-public.json. */
  publicServers?: readonly PublicServer[];
}

export interface TrackSummary {
  registry: RegistryState;
  planned: number;
  checked: number;
  notStarted: number;
  changed: number;
  /** Published servers watched with a login. Servers tracked privately are counted only, so the public log names none. */
  watched: Array<{ vendor: string; outcome: string }>;
  privately: number;
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
  return new Set(servers.flatMap((server) => (!server.tracker.publish && "forbidden" in server.tracker && server.tracker.forbidden ? [siteOf(server.url), siteOf(server.site)] : [])));
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

/**
 * A failure that may clear up within minutes, so a watched server gets a second look before it is recorded: no answer
 * at all (a timeout or a dropped connection), or an initialize answered 424 (a backend still starting), 429 (too many
 * requests) or 5xx (the server's own error). A refused login, a missing token or a list the scanner cannot use would
 * be the same a few minutes later, so those are recorded at once.
 */
const mayClearUp = (result: CheckResult): boolean =>
  result.outcome === "unreachable" || (result.outcome === "not-usable" && /^initialize answered (424|429|5\d\d)$/.test(result.detail));

/** Where a group of servers keeps its files: the public folder or the private one. */
interface Store {
  file: (relative: string) => string;
  /** Servers watched with a login whose files live here, by vendor. */
  watched: Map<string, Endpoint>;
}

const plainUrl = (url: string) => url.replace(/\/$/, "");

export async function track(options: TrackOptions): Promise<TrackSummary> {
  const { dataDir, environment, fetchImpl, log = () => undefined, privateDataDir } = options;
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const file = (relative: string) => path.join(dataDir, relative);
  const privateFile = (relative: string) => path.join(privateDataDir ?? "", relative);

  const published = (vendor: string | undefined) => vendor !== undefined && signedInServers[vendor]?.publish === true;
  const all = await readEndpoints(file("endpoints.jsonl"));
  const byUrl = new Map(all.filter((endpoint) => !endpoint.signedIn).map((endpoint) => [endpoint.url, endpoint]));
  const publicStore: Store = { file, watched: new Map(all.filter((endpoint) => published(endpoint.signedIn)).map((endpoint) => [endpoint.signedIn as string, endpoint])) };
  const privateAll = privateDataDir ? await readEndpoints(privateFile("endpoints.jsonl")) : [];
  const privateStore: Store = { file: privateFile, watched: new Map(privateAll.filter((endpoint) => endpoint.signedIn).map((endpoint) => [endpoint.signedIn as string, endpoint])) };

  // A server watched with a login that is no longer published leaves the public folder. When it is now
  // tracked privately and the private folder has no history for it yet, its history moves there first.
  const leaving = all.filter((endpoint) => endpoint.signedIn && !published(endpoint.signedIn));
  // Without the private folder the history would be dropped, not moved, so the run stops before touching anything.
  const stranded = leaving.filter((endpoint) => signedInServers[endpoint.signedIn as string] !== undefined && !privateStore.watched.has(endpoint.signedIn as string));
  if (stranded.length && privateDataDir === undefined) {
    throw new Error(`${stranded.length} servers now tracked privately still have their history in the public data, and no private data folder was given to move it to. Nothing was changed. Run with --private-data once it can be checked out.`);
  }
  for (const endpoint of leaving) {
    const vendor = endpoint.signedIn as string;
    const moves = privateDataDir !== undefined && signedInServers[vendor] !== undefined && !privateStore.watched.has(vendor);
    for (const relative of [watchedFile(vendor), ...(endpoint.file ? [endpoint.file] : [])]) {
      if (moves) {
        await mkdir(path.dirname(privateFile(relative)), { recursive: true });
        // Only a file that is not there is skipped; any other failure stops the run before the public copy is removed.
        await copyFile(file(relative), privateFile(relative)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
      await rm(file(relative), { force: true });
    }
    if (moves) privateStore.watched.set(vendor, endpoint);
  }
  if (leaving.length) log(`${leaving.length} servers watched with a login are no longer published, and left the public data`);

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
  async function record(endpoint: Endpoint, result: CheckResult, at: string, store: Pick<Store, "file"> = publicStore): Promise<void> {
    const latestChange = endpoint.changes[0];
    const previous = result.outcome === "listed" && endpoint.file ? readPrint(await readJson(store.file(endpoint.file))) : null;
    if (result.outcome === "listed" && endpoint.lastListed && !previous && store === publicStore) log(`${endpoint.id}: its saved list is missing, so this look starts afresh`);
    let saved: ReturnType<typeof recordCheck> = null;
    try { saved = recordCheck(endpoint, result, at, previous); }
    catch {
      if (store === publicStore) failed += 1;
      recordCheck(endpoint, { outcome: "not-usable", detail: "the list could not be processed" }, at, null);
    }
    // The public log's count leaves out servers tracked privately, so it says nothing about them.
    if (endpoint.changes[0] !== latestChange && store === publicStore) changed += 1;
    if (!saved || !endpoint.file) return;
    await writeWhole(store.file(endpoint.file), `${JSON.stringify(saved.print)}\n`);
    // The definitions are rewritten only when the server changed them (or the file is missing), so a
    // watched file's history is its server's history. Its takenAt is when that version was first
    // seen; how recently it was confirmed is the endpoint's lastListed.
    if (!endpoint.signedIn) return;
    const watchedPath = store.file(watchedFile(endpoint.signedIn));
    if (!saved.reread || !(await readSnapshot(watchedPath))) await writeWhole(watchedPath, snapshotText(saved.snapshot));
  }

  /** One look at a server watched with a login, as the result to record. */
  async function lookSignedIn(vendor: string): Promise<CheckResult> {
    const scan = await scanSignedIn(vendor, environment, fetchImpl);
    if (scan.outcome === "unsafe-connection") throw new Error("Certificate checking is switched off here, so no token was sent.");
    // A privately tracked server is not named in this public log.
    if (scan.outcome === "token-echoed") log(`${published(vendor) ? vendor : "a privately tracked server"}: the server sent the token back. Nothing it returned was kept. Replace that token.`);
    return scan.outcome === "answered" ? scan.result : scan.outcome === "no-token" ? { outcome: "no-token" } : { outcome: "not-usable", detail: "the server sent the token back" };
  }
  const lookOpen = (url: string) => withinTime(listTools(url, { ...(fetchImpl ? { fetchImpl } : {}), timeoutMs: 15_000 }), options.checkTimeoutMs ?? 60_000);
  const logLook = (name: string, endpoint: Endpoint, result: CheckResult) => log(`${name}: ${endpoint.outcome}${checkReason(result, endpoint.outcome)}${endpoint.tools !== undefined ? `, ${endpoint.outcome === "listed" ? "" : "last listed "}${endpoint.tools} tools` : ""}`);

  // Servers looked at on every run, before the crawl. A failure that may clear up (Grafana Cloud's stack, say,
  // sleeps when unused and answers 424 for minutes while it starts) gets one more look after the crawl, and only
  // the second look is recorded. A privately tracked server is looked at and recorded, but this public log
  // only counts them.
  interface Look { endpoint: Endpoint; look: () => Promise<CheckResult>; store: Store; name?: string }
  const lookAgain: Look[] = [];
  let privately = 0, skippedPrivately = 0;
  async function lookNow({ endpoint, look, store, name }: Look): Promise<void> {
    const at = clock().toISOString();
    const result = await look();
    if (mayClearUp(result)) {
      if (name) log(`${name}: ${result.outcome}${checkReason(result, result.outcome)}, so it will be checked again after the crawl`);
      lookAgain.push({ endpoint, look, store, ...(name ? { name } : {}) });
      return;
    }
    await record(endpoint, result, at, store);
    if (name) logLook(name, endpoint, result);
  }

  // Servers watched with a login. A token that is not set is recorded as a missed check, once the server is being watched.
  for (const [vendor, server] of Object.entries(signedInServers)) {
    const store = server.publish ? publicStore : privateStore;
    if (!server.publish && privateDataDir === undefined) { skippedPrivately += 1; continue; }
    const hasToken = Boolean(tokenFor(server, environment)?.trim());
    const endpoint = store.watched.get(vendor) ?? (hasToken ? watchedEndpoint(vendor, server.url, startedAt) : null);
    if (!endpoint) continue;
    store.watched.set(vendor, endpoint);
    endpoint.url = server.url;
    if (!server.publish) privately += 1;
    await lookNow({ endpoint, look: () => lookSignedIn(vendor), store, ...(server.publish ? { name: vendor } : {}) });
  }
  if (skippedPrivately) log(`${skippedPrivately} privately tracked servers were not looked at: no private data folder was given`);

  // The official servers the page shows that answer with no sign-in, whether or not the crawl would reach them today.
  const official = new Set<string>();
  const publicServers = options.publicServers ?? publicList.servers;
  const looks: Look[] = [];
  for (const server of publicServers) {
    const url = plainUrl(server.url);
    const endpoint = byUrl.get(url) ?? byUrl.get(`${url}/`) ?? { id: endpointId(server.url), url: server.url, names: [], firstSeen: startedAt, inRegistry: false, checks: [], changes: [] };
    byUrl.set(endpoint.url, endpoint);
    official.add(endpoint.url);
    looks.push({ endpoint, look: () => lookOpen(endpoint.url), store: publicStore, name: server.id });
  }
  // A few at a time, in the list's order, so one slow server does not hold the rest back for long.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, looks.length) }, async () => {
    while (next < looks.length) await lookNow(looks[next++] as Look);
  }));

  // Each result is recorded as soon as it arrives, so the run holds one list at a time per check, not all of them.
  const plan = planChecks([...byUrl.values()].filter((endpoint) => !official.has(endpoint.url)), startedAt, { maxChecks: options.maxChecks, perHost: options.perHost, perSite: options.perSite });
  log(`planned ${plan.length} checks`);
  const deadline = Date.parse(startedAt) + options.budgetMinutes * 60_000;
  const { done, notStarted } = await crawl(plan, async (endpoint) => {
    const at = clock().toISOString();
    const result = await lookOpen(endpoint.url);
    await record(endpoint, result, at);
    return endpoint.outcome;
  }, { concurrency: options.concurrency, hostGapMs: options.hostGapMs, deadline, now: () => clock().getTime() });
  log(`checked ${done.length}, not started ${notStarted.length}, changed ${changed}, could not process ${failed}`);

  for (const { endpoint, look, store, name } of lookAgain) {
    const at = clock().toISOString();
    const result = await look();
    await record(endpoint, result, at, store);
    if (name) logLook(name, endpoint, result);
  }
  if (privately) log(`privately tracked: ${privately} servers looked at`);

  const reportsOf = async (store: Store) => {
    const reports = new Map<string, AuthorityReport>();
    for (const endpoint of store.watched.values()) {
      const snapshot = endpoint.lastListed ? await readSnapshot(store.file(watchedFile(endpoint.signedIn as string))) : null;
      if (snapshot) reports.set(endpoint.id, authorityOf(snapshot));
    }
    return reports;
  };
  const publicGroups = new Map<string, FeedWatched["groups"]>();
  for (const url of official) {
    const endpoint = byUrl.get(url);
    if (endpoint?.lastListed && endpoint.file) publicGroups.set(endpoint.id, groupsOfPrint(readPrint(await readJson(file(endpoint.file)))));
  }

  const endpoints = [...byUrl.values(), ...publicStore.watched.values()].sort(byId);
  const { feed, servers } = buildFeed(endpoints, await reportsOf(publicStore), registry, clock().toISOString(), publicGroups, publicServers);
  await writeWhole(file("endpoints.jsonl"), endpoints.map((endpoint) => JSON.stringify(endpoint)).join("\n") + (endpoints.length ? "\n" : ""));
  await writeWhole(file("registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
  await writeWhole(file("feed.json"), `${JSON.stringify(feed)}\n`);
  await writeWhole(file("servers.json"), `${JSON.stringify(servers)}\n`);
  await writeWhole(file("lookup.json"), `${JSON.stringify({ version: 1, generatedAt: feed.generatedAt, rows: lookupOf(servers) })}\n`);

  if (privateDataDir !== undefined) {
    const privateEndpoints = [...privateStore.watched.values()].sort(byId);
    await writeWhole(privateFile("endpoints.jsonl"), privateEndpoints.map((endpoint) => JSON.stringify(endpoint)).join("\n") + (privateEndpoints.length ? "\n" : ""));
    await writeWhole(privateFile("feed.json"), `${JSON.stringify({ version: 1, generatedAt: feed.generatedAt, watched: watchedOf(privateEndpoints, await reportsOf(privateStore)) })}\n`);
  }

  return {
    registry, planned: plan.length, checked: done.length, notStarted: notStarted.length, changed,
    watched: [...publicStore.watched.entries()].map(([vendor, endpoint]) => ({ vendor, outcome: endpoint.outcome ?? "not checked" })),
    privately,
  };
}
