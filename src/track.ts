import { readFile } from "node:fs/promises";
import path from "node:path";
import { authorityOf } from "./authority.ts";
import type { AuthorityReport } from "./authority.ts";
import { listTools, userAgent } from "./client.ts";
import { crawl } from "./crawl.ts";
import { readSnapshot, snapshotText, writeWhole } from "./files.ts";
import { readRegistry } from "./registry.ts";
import type { RegistryRead } from "./registry.ts";
import { scanSignedIn, signedInServers, tokenFor } from "./signed-in.ts";
import { buildFeed, mergeRegistry, planChecks, readPrint, recordCheck, watchedEndpoint } from "./tracker.ts";
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

const byId = (a: Endpoint, b: Endpoint) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function track(options: TrackOptions): Promise<TrackSummary> {
  const { dataDir, environment, fetchImpl, log = () => undefined } = options;
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const file = (relative: string) => path.join(dataDir, relative);

  const all = await readEndpoints(file("endpoints.jsonl"));
  const byUrl = new Map(all.filter((endpoint) => !endpoint.signedIn).map((endpoint) => [endpoint.url, endpoint]));
  const watched = new Map(all.filter((endpoint) => endpoint.signedIn).map((endpoint) => [endpoint.signedIn as string, endpoint]));

  const none: RegistryState = { readAt: "", complete: false, entries: 0, endpoints: 0, attemptedAt: "", attemptOk: false };
  let registry: RegistryState = { ...none, ...(await readJson<Partial<RegistryState>>(file("registry.json"))) };
  if (options.readRegistry) {
    const read: RegistryRead = await readRegistry({ userAgent, ...(fetchImpl ? { fetchImpl } : {}) });
    log(`registry: ${read.entries.length} entries in ${read.pages} pages${read.complete ? "" : ", stopped before the end"}`);
    // An empty read is a registry that did not answer, not a registry with nothing in it.
    registry = { ...registry, attemptedAt: startedAt, attemptOk: read.entries.length > 0 && read.complete };
    if (read.entries.length) {
      mergeRegistry(byUrl, read, startedAt);
      registry = { ...registry, readAt: startedAt, complete: read.complete, entries: read.entries.length, endpoints: new Set(read.entries.flatMap((entry) => entry.urls)).size };
    }
  }

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
    if (endpoint.signedIn) await writeWhole(file(watchedFile(endpoint.signedIn)), snapshotText(saved.snapshot));
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
    await record(endpoint, scan.outcome === "answered" ? scan.result : scan.outcome === "no-token" ? { outcome: "no-token" } : { outcome: "not-usable", detail: "the server sent the token back" }, at);
    log(`${vendor}: ${endpoint.outcome}${endpoint.tools !== undefined ? `, ${endpoint.tools} tools` : ""}`);
  }

  // Each result is recorded as soon as it arrives, so the run holds one list at a time per check, not all of them.
  const plan = planChecks(byUrl.values(), startedAt, { maxChecks: options.maxChecks, perHost: options.perHost, perSite: options.perSite });
  log(`planned ${plan.length} checks`);
  const deadline = Date.parse(startedAt) + options.budgetMinutes * 60_000;
  const { done, notStarted } = await crawl(plan, async (endpoint) => {
    const at = clock().toISOString();
    let result: CheckResult;
    try { result = await listTools(endpoint.url, { ...(fetchImpl ? { fetchImpl } : {}), timeoutMs: 15_000 }); }
    catch { result = { outcome: "unreachable", detail: "error" }; }
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

  return {
    registry, planned: plan.length, checked: done.length, notStarted: notStarted.length, changed,
    watched: [...watched.entries()].map(([vendor, endpoint]) => ({ vendor, outcome: endpoint.outcome ?? "not checked" })),
  };
}
