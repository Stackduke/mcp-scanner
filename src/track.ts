import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { authorityOf } from "./authority.ts";
import type { AuthorityReport } from "./authority.ts";
import { listToolsWithFacts, userAgent } from "./client.ts";
import { crawl } from "./crawl.ts";
import { readSnapshot, snapshotText, writeWhole } from "./files.ts";
import { buildManifest, checkPrevious, folderDigest, writeManifest } from "./manifest.ts";
import type { RunCosign } from "./manifest.ts";
import { readRegistry } from "./registry.ts";
import type { RegistryRead } from "./registry.ts";
import { catalog, publicList } from "./catalog.ts";
import type { PublicServer } from "./catalog.ts";
import { scanSignedIn, signedInServers as catalogSignedIn, tokenFor } from "./signed-in.ts";
import type { SignedInServer } from "./signed-in.ts";
import { buildFeed, endpointId, groupsOfPrint, listHashOf, listHashOfResult, listOnSites, lookupOf, mergeRegistry, onSites, planChecks, readPrint, recordCheck, recordSkipped, rereadVerdict, siteOf, watchedEndpoint, watchedOf } from "./tracker.ts";
import type { CheckFacts, CheckResult, Endpoint, FeedWatched, RegistryState } from "./tracker.ts";

/**
 * One run of the public tracker, over a data folder:
 *
 *   endpoints.jsonl   every endpoint known, one per line: what the registry calls it, its recent checks and changes
 *   lists/            the latest tool list of each endpoint, as fingerprints, rewritten only when it changes
 *   watched/          the full definitions of each server watched with a login, rewritten only when they change
 *   registry.json     when the registry was last read, and whether to the end
 *   feed.json         what the web page reads: coverage, the servers watched with a login, recent changes
 *   servers.json      every endpoint that listed tools, with counts, for a searchable table
 *   manifest.json     the full sha256 of every file this run wrote, the method version, the scanner commit and the run
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
  /** The longest one request may take. Default 15 seconds. */
  requestTimeoutMs?: number;
  /**
   * The longest one attempt at a check may take, all its requests together. Default 45 seconds. A check that times
   * out, cannot connect or gets a 5xx may be tried once more, and a list that changed is read once more (that read
   * may be retried too), so one check makes at most four attempts. A look at a server watched with a login is held
   * to this as a whole.
   */
  attemptTimeoutMs?: number;
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
  /** For tests: what runs cosign when the folder the run starts from is checked against its signed manifest. */
  cosign?: RunCosign;
  /** The servers watched with a login. Default: the catalog's. */
  signedInServers?: Readonly<Record<string, SignedInServer>>;
}

export interface TrackSummary {
  registry: RegistryState;
  planned: number;
  checked: number;
  notStarted: number;
  changed: number;
  /** Public endpoints whose list changed and did not read the same when read again at once. */
  unstable: number;
  /** Endpoints not checked because their host had used its time for this run. */
  skipped: number;
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
async function withinTime(check: Promise<Looked>, ms: number): Promise<Looked> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Looked>((resolve) => { timer = setTimeout(() => resolve({ result: { outcome: "unreachable", detail: "TimeoutError" }, facts: { errorClass: "timeout" } }), ms); });
  try { return await Promise.race([check.catch((): Looked => ({ result: { outcome: "unreachable", detail: "error" }, facts: { errorClass: "protocol_error" } })), late]); }
  finally { clearTimeout(timer); }
}

/** Each request of a check may take 15 s, and one attempt, all its requests together, 45 s. */
export const defaultTimeouts = { requestMs: 15_000, attemptMs: 45_000 };

/** The most time the crawl spends on one host in a run. Past it, that host's other endpoints wait for the next run. */
export const hostBudgetMinutes = 10;
/** How long after the crawl's budget the second looks at watched servers may still start, inside the job's own limit. */
export const lookAgainMinutes = 10;

/**
 * Hosts that used up their time, by name: in how many runs in a row, and the last such run. It says how the tracker
 * spent its time, not that a server failed; nothing about a host or its endpoints is ever removed for this.
 */
export interface HostsFile { version: 1; hosts: Record<string, { overBudgetRuns: number; lastOverBudget?: string }> }

const pause = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** One look at a server: its result, and what it found out besides. */
interface Looked { result: CheckResult; facts: CheckFacts }

/** A failure worth one more attempt at once: no answer in time, no connection, or the server's own error. */
export const worthRetrying = (facts: CheckFacts & { temporary?: true }): boolean => facts.errorClass === "timeout" || facts.errorClass === "connect" || facts.errorClass === "http_5xx" || facts.temporary === true;

/**
 * Sites of vendors whose terms forbid publishing about their service, from the catalog: the site of
 * the MCP server's address, of the vendor's website, and of any other site the catalog lists as the
 * vendor's own (`sites`). No address on them is checked or kept, wherever the registry lists it.
 */
export function keptOffSites(servers = catalog.servers): Set<string> {
  return new Set(servers.flatMap((server) => (!server.tracker.publish && "forbidden" in server.tracker && server.tracker.forbidden ? [server.url, server.site, ...(server.tracker.sites ?? [])].map(siteOf) : [])));
}

const keptOff = (url: string, sites: Set<string>): boolean => onSites(url, sites);

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

/** The data folder's .gitattributes: every file is text with LF line endings, in the repository and in every checkout. */
export const dataAttributes = "* text eol=lf\n";

export async function track(options: TrackOptions): Promise<TrackSummary> {
  const { dataDir, environment, fetchImpl, log = () => undefined, privateDataDir } = options;
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const file = (relative: string) => path.join(dataDir, relative);
  // What this run writes to the public folder, by path relative to it, for the manifest.
  const written = new Set<string>();
  const writePublic = async (relative: string, text: string) => { await writeWhole(file(relative), text); written.add(relative); };
  const privateFile = (relative: string) => path.join(privateDataDir ?? "", relative);

  // Before anything changes: is the folder exactly the previous scan's, as signed? The answer is signed with
  // this scan's manifest, so a file changed between scans cannot quietly become part of this one.
  const previous = await checkPrevious(dataDir, { ...(environment.GITHUB_REPOSITORY ? { repository: environment.GITHUB_REPOSITORY } : {}), ...(options.cosign ? { cosign: options.cosign } : {}) });
  log(previous.verified ? "the data folder is exactly the previous scan's, as signed" : `the data folder is not exactly a signed scan's: ${previous.reason}`);
  // The tracker writes only plain files. Anything else (a link, say) came from elsewhere: it is removed, never
  // followed, so no write can leave the folder, and the scan goes on. Its start is already recorded as unclean.
  const { others } = await folderDigest(dataDir);
  for (const other of others) await rm(file(other), { force: true });
  if (others.length) log(`${others.length} entries in the data folder were not plain files, and were removed`);

  const signedInServers = options.signedInServers ?? catalogSignedIn;
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

  // Its saved list goes with it: nothing about a kept-off site stays in the public folder.
  for (const [url, endpoint] of byUrl) {
    if (!keptOff(endpoint.url, sites)) continue;
    byUrl.delete(url);
    if (endpoint.file) await rm(file(endpoint.file), { force: true });
  }
  // And any other saved list about a kept-off site, by the same test the uploader applies: one no endpoint names
  // any more, or one put back from an earlier scan, would otherwise stop every upload.
  let sweptLists = 0;
  for (const entry of await readdir(file("lists"), { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const relative = path.relative(dataDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    if (listOnSites(relative, await readFile(file(relative)), sites)) { await rm(file(relative), { force: true }); sweptLists += 1; }
  }
  if (sweptLists) log(`${sweptLists} saved lists about sites kept off were removed`);

  let changed = 0, failed = 0, unstable = 0;
  /**
   * Records one check. A list the scanner cannot handle (one nested too deeply, say) is that server's failure, not
   * the run's. A list that differs from the saved one is read again with `again` before it counts as a change.
   */
  async function record(endpoint: Endpoint, { result, facts }: Looked, at: string, store: Pick<Store, "file"> = publicStore, again?: () => Promise<Looked>): Promise<void> {
    const latestChange = endpoint.changes[0];
    const previous = result.outcome === "listed" && endpoint.file ? readPrint(await readJson(store.file(endpoint.file))) : null;
    if (result.outcome === "listed" && endpoint.lastListed && !previous && store === publicStore) log(`${endpoint.id}: its saved list is missing, so this look starts afresh`);
    const first = previous && again ? listHashOfResult(endpoint.url, result, at) : null;
    let flapping = false;
    if (previous && again && first !== null && first !== listHashOf(previous)) {
      await pause(options.hostGapMs);
      flapping = rereadVerdict(first, listHashOfResult(endpoint.url, (await again()).result, at)) === "unstable";
      if (flapping && store === publicStore) unstable += 1;
    }
    let saved: ReturnType<typeof recordCheck> = null;
    try { saved = recordCheck(endpoint, result, at, previous, { ...facts, ...(flapping ? { unstable: true } : {}) }); }
    catch {
      if (store === publicStore) failed += 1;
      recordCheck(endpoint, { outcome: "not-usable", detail: "the list could not be processed" }, at, null, { errorClass: "protocol_error", retries: facts.retries ?? 0 });
    }
    // The public log's count leaves out servers tracked privately, so it says nothing about them.
    if (endpoint.changes[0] !== latestChange && store === publicStore) changed += 1;
    if (!saved || !endpoint.file) return;
    if (store === publicStore) await writePublic(endpoint.file, `${JSON.stringify(saved.print)}\n`);
    else await writeWhole(store.file(endpoint.file), `${JSON.stringify(saved.print)}\n`);
    // The definitions are rewritten only when the server changed them (or the file is missing), so a
    // watched file's history is its server's history. Its takenAt is when that version was first
    // seen; how recently it was confirmed is the endpoint's lastListed.
    if (!endpoint.signedIn) return;
    const watchedPath = store.file(watchedFile(endpoint.signedIn));
    if (saved.reread && (await readSnapshot(watchedPath))) return;
    if (store === publicStore) await writePublic(watchedFile(endpoint.signedIn), snapshotText(saved.snapshot));
    else await writeWhole(watchedPath, snapshotText(saved.snapshot));
  }

  const requestMs = options.requestTimeoutMs ?? defaultTimeouts.requestMs, attemptMs = options.attemptTimeoutMs ?? defaultTimeouts.attemptMs;
  /** One look at a server watched with a login, as the result to record. */
  async function lookSignedIn(vendor: string): Promise<Looked> {
    // Held to one attempt's time as a whole, however many pages it reads. An error (a switched-off certificate check) still stops the run.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), attemptMs); });
    const scan = await Promise.race([scanSignedIn(vendor, environment, fetchImpl, signedInServers), late]).finally(() => clearTimeout(timer));
    if (scan === "late") return { result: { outcome: "unreachable", detail: "TimeoutError" }, facts: { errorClass: "timeout" } };
    if (scan.outcome === "unsafe-connection") throw new Error("Certificate checking is switched off here, so no token was sent.");
    // A privately tracked server is not named in this public log.
    if (scan.outcome === "token-echoed") log(`${published(vendor) ? vendor : "a privately tracked server"}: the server sent the token back. Nothing it returned was kept. Replace that token.`);
    if (scan.outcome === "answered") return { result: scan.result, facts: scan.facts };
    return scan.outcome === "no-token" ? { result: { outcome: "no-token" }, facts: {} } : { result: { outcome: "not-usable", detail: "the server sent the token back" }, facts: { errorClass: "protocol_error" } };
  }
  const attemptOpen = (url: string) => withinTime(listToolsWithFacts(url, { ...(fetchImpl ? { fetchImpl } : {}), timeoutMs: requestMs }), attemptMs);
  /** Hosts that timed out in this run: their later checks get no retry, so one hanging host cannot cost twice. */
  const timedOut = new Set<string>();
  /**
   * One look at a server with no sign-in: a second attempt, after the host's gap, when the first failed in a way that
   * may clear up and the host has not timed out already in this run.
   */
  async function lookOpen(url: string): Promise<Looked> {
    const host = new URL(url).hostname;
    const looked = await attemptOpen(url);
    if (!worthRetrying(looked.facts) || timedOut.has(host)) {
      if (looked.facts.errorClass === "timeout") timedOut.add(host);
      return { ...looked, facts: { ...looked.facts, retries: 0 } };
    }
    await pause(options.hostGapMs);
    const retried = await attemptOpen(url);
    if (looked.facts.errorClass === "timeout" || retried.facts.errorClass === "timeout") timedOut.add(host);
    return { ...retried, facts: { ...retried.facts, retries: 1 } };
  }
  const logLook = (name: string, endpoint: Endpoint, result: CheckResult) => log(`${name}: ${endpoint.outcome}${checkReason(result, endpoint.outcome)}${endpoint.tools !== undefined ? `, ${endpoint.outcome === "listed" ? "" : "last listed "}${endpoint.tools} tools` : ""}`);

  // Servers looked at on every run, before the crawl. A failure that may clear up (Grafana Cloud's stack, say,
  // sleeps when unused and answers 424 for minutes while it starts) gets one more look after the crawl, and only
  // the second look is recorded. A privately tracked server is looked at and recorded, but this public log
  // only counts them.
  interface Look { endpoint: Endpoint; look: () => Promise<Looked>; store: Store; name?: string }
  /** Each with the attempts already made, which the second look's retries add to. */
  const lookAgain: Array<Look & { attempts: number; first: Looked; at: string }> = [];
  let privately = 0, skippedPrivately = 0;
  async function lookNow({ endpoint, look, store, name }: Look): Promise<void> {
    const at = clock().toISOString();
    const looked = await look();
    const { result } = looked;
    if (mayClearUp(result)) {
      if (name) log(`${name}: ${result.outcome}${checkReason(result, result.outcome)}, so it will be checked again after the crawl`);
      lookAgain.push({ endpoint, look, store, attempts: (looked.facts.retries ?? 0) + 1, first: looked, at, ...(name ? { name } : {}) });
      return;
    }
    await record(endpoint, looked, at, store, look);
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
  // Each host has a share of the run's time. A host past it is left for the next run, and counted in hosts.json.
  const spent = new Map<string, number>(), crawledHosts = new Set<string>(), overBudget = new Set<string>();
  let skipped = 0;
  const { done, notStarted } = await crawl(plan, async (endpoint) => {
    const host = new URL(endpoint.url).hostname;
    crawledHosts.add(host);
    const at = clock().toISOString();
    if ((spent.get(host) ?? 0) >= hostBudgetMinutes * 60_000) {
      overBudget.add(host);
      recordSkipped(endpoint, at);
      skipped += 1;
      return endpoint.outcome;
    }
    const look = () => lookOpen(endpoint.url);
    await record(endpoint, await look(), at, publicStore, look);
    spent.set(host, (spent.get(host) ?? 0) + clock().getTime() - Date.parse(at));
    if ((spent.get(host) ?? 0) >= hostBudgetMinutes * 60_000) overBudget.add(host);
    return endpoint.outcome;
  }, { concurrency: options.concurrency, hostGapMs: options.hostGapMs, deadline, now: () => clock().getTime() });
  log(`checked ${done.length - skipped}, not started ${notStarted.length}, changed ${changed}, unstable ${unstable}, could not process ${failed}, left for hosts over their time ${skipped}`);

  // The second looks run one at a time after the crawl, so they get a deadline of their own inside the job's limit.
  // A server not looked at again by then is recorded from its first look.
  const lookAgainDeadline = deadline + lookAgainMinutes * 60_000;
  for (const { endpoint, look, store, name, attempts, first, at: firstAt } of lookAgain) {
    if (clock().getTime() >= lookAgainDeadline) {
      await record(endpoint, { ...first, facts: { ...first.facts, retries: attempts - 1 } }, firstAt, store);
      if (name) logLook(name, endpoint, first.result);
      continue;
    }
    const at = clock().toISOString();
    const looked = await look();
    await record(endpoint, { ...looked, facts: { ...looked.facts, retries: attempts + (looked.facts.retries ?? 0) } }, at, store, look);
    if (name) logLook(name, endpoint, looked.result);
  }

  const hostsFile = await readJson<HostsFile>(file("hosts.json"));
  const hosts: HostsFile["hosts"] = hostsFile?.version === 1 && typeof hostsFile.hosts === "object" && hostsFile.hosts !== null ? { ...hostsFile.hosts } : {};
  for (const host of Object.keys(hosts)) if (keptOff(`https://${host}/`, sites)) delete hosts[host];
  for (const host of crawledHosts) {
    const known = Object.hasOwn(hosts, host) ? hosts[host] : undefined;
    if (overBudget.has(host)) hosts[host] = { overBudgetRuns: (known?.overBudgetRuns ?? 0) + 1, lastOverBudget: startedAt };
    else if (known) hosts[host] = { ...known, overBudgetRuns: 0 };
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
  await writePublic("endpoints.jsonl", endpoints.map((endpoint) => JSON.stringify(endpoint)).join("\n") + (endpoints.length ? "\n" : ""));
  await writePublic("registry.json", `${JSON.stringify(registry, null, 2)}\n`);
  if (hostsFile || Object.keys(hosts).length) await writePublic("hosts.json", `${JSON.stringify({ version: 1, hosts: Object.fromEntries(Object.entries(hosts).sort(([a], [b]) => (a < b ? -1 : 1))) } satisfies HostsFile)}\n`);
  await writePublic("feed.json", `${JSON.stringify(feed)}\n`);
  await writePublic("servers.json", `${JSON.stringify(servers)}\n`);
  await writePublic("lookup.json", `${JSON.stringify({ version: 1, generatedAt: feed.generatedAt, rows: lookupOf(servers) })}\n`);
  // Every checkout keeps the files' line endings as committed (Git for Windows would otherwise turn them to
  // CRLF), so their hashes match the manifest on every system. Written once, and again only if it changed.
  if ((await readFile(file(".gitattributes"), "utf8").catch(() => null)) !== dataAttributes) await writePublic(".gitattributes", dataAttributes);
  // Last, so it covers everything above. The private folder has no manifest: its files are never published.
  await writeManifest(dataDir, await buildManifest({ dataDir, written, previous, scanStartedAt: startedAt, generatedAt: clock().toISOString(), registry, environment }));

  if (privateDataDir !== undefined) {
    const privateEndpoints = [...privateStore.watched.values()].sort(byId);
    await writeWhole(privateFile("endpoints.jsonl"), privateEndpoints.map((endpoint) => JSON.stringify(endpoint)).join("\n") + (privateEndpoints.length ? "\n" : ""));
    await writeWhole(privateFile("feed.json"), `${JSON.stringify({ version: 1, generatedAt: feed.generatedAt, watched: watchedOf(privateEndpoints, await reportsOf(privateStore)) })}\n`);
  }

  return {
    registry, planned: plan.length, checked: done.length - skipped, notStarted: notStarted.length, changed, unstable, skipped,
    watched: [...publicStore.watched.entries()].map(([vendor, endpoint]) => ({ vendor, outcome: endpoint.outcome ?? "not checked" })),
    privately,
  };
}
