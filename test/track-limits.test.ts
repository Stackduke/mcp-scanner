import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { signedInServers } from "../src/signed-in.ts";
import { defaultTimeouts, hostBudgetMinutes, track } from "../src/track.ts";
import type { HostsFile, TrackOptions } from "../src/track.ts";
import { recordCheck, recordSkipped } from "../src/tracker.ts";
import type { Endpoint } from "../src/tracker.ts";
import type { ToolDefinition } from "../src/types.ts";

/**
 * Runs of the tracker against servers answered in this process: flapping over many days, slow and hanging servers,
 * the per-host time budget, and the second looks after the crawl. Nothing leaves this process.
 */
const day = 24 * 3_600_000, minute = 60_000;
const start = Date.parse("2026-11-20T04:17:00.000Z");
const listA: ToolDefinition[] = [{ name: "get_page", annotations: { readOnlyHint: true } }];
const listB: ToolDefinition[] = [...listA, { name: "send_invoice" }];

type Handler = (url: string, method: string, signal: AbortSignal | undefined) => Promise<Response> | Response;
/** A server that answers as MCP, with the tools `tools()` gives at each listing. */
const mcp = (tools: (listing: number) => ToolDefinition[]) => {
  let listings = 0, current: ToolDefinition[] = [];
  return (body: { method: string; id?: number }) => {
    if (body.method === "initialize") { current = tools(listings); listings += 1; return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "Demo" } } }); }
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: current } });
    return new Response(null, { status: 202 });
  };
};
const hanging = (signal: AbortSignal | undefined) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
const timingOut = () => { throw new DOMException("The operation timed out.", "TimeoutError"); };

async function run(options: { dir?: string; urls: string[]; handle: (url: string, body: { method: string; id?: number }, signal: AbortSignal | undefined) => Promise<Response> | Response; now?: () => Date; more?: Partial<TrackOptions> }) {
  const dataDir = options.dir ?? await mkdtemp(path.join(tmpdir(), "tracker-limits-"));
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://registry.modelcontextprotocol.io/")) return Response.json({ servers: options.urls.map((address, index) => ({ server: { name: `com.example/server-${index}`, remotes: [{ type: "streamable-http", url: address }] } })), metadata: {} });
    return options.handle(url, JSON.parse(String(init?.body)) as { method: string; id?: number }, init?.signal ?? undefined);
  }) as typeof fetch;
  const summary = await track({ dataDir, readRegistry: true, maxChecks: 50, perHost: 30, perSite: 50, concurrency: 1, hostGapMs: 0, budgetMinutes: 120, publicServers: [], environment: {}, fetchImpl, now: options.now ?? (() => new Date(start)), ...options.more });
  const endpoints = (await readFile(path.join(dataDir, "endpoints.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Endpoint);
  return { dataDir, summary, endpoints, byUrl: (url: string) => endpoints.find((endpoint) => endpoint.url === url) as Endpoint };
}

/** Day after day over one server: `serve` is that server, whose listings are counted across all the days. */
async function days(count: number, serve: ReturnType<typeof mcp>) {
  const url = "https://flaps.example.com/mcp";
  const dir = await mkdtemp(path.join(tmpdir(), "tracker-limits-"));
  const results = [];
  for (let index = 0; index < count; index += 1) {
    const at = start + index * day;
    results.push(await run({ dir, urls: [url], handle: (_url, body) => serve(body), now: () => new Date(at) }));
  }
  return results.map((result) => ({ summary: result.summary, endpoint: result.byUrl(url) }));
}

test("a list that alternates every listing is held back one run only: by its second day the change is recorded, marked unstable", async () => {
  // The first listing gives the old list; after that, every first read gives the new one and every re-read the old.
  const results = await days(8, mcp((listing) => (listing === 0 || listing % 2 === 0 ? listA : listB)));
  const [, first, second] = results;
  assert.equal(first?.summary.changed, 0, "day 1 of the flapping: held back");
  assert.equal(first?.summary.unstable, 1);
  assert.equal(second?.summary.changed, 1, "day 2: recorded");
  assert.equal(second?.endpoint.changes[0]?.unstable, true);
  assert.deepEqual(second?.endpoint.changes[0]?.added, ["send_invoice"]);
  assert.equal(second?.endpoint.tools, 2, "the saved list is the one the server now gives first");
  assert.equal(second?.endpoint.changes[0]?.since, new Date(start).toISOString(), "since the old list was last confirmed, not the held-back run");
  assert.ok(results.reduce((sum, result) => sum + result.summary.changed, 0) >= 1);
});

test("a list with a value that differs on every read is not frozen: a tool added later is recorded", async () => {
  const results = await days(8, mcp((listing) => [{ name: "get_page", description: `request ${listing}` }, ...(listing >= 6 ? [{ name: "send_invoice" }] : [])]));
  assert.equal(results[1]?.summary.unstable, 1);
  assert.equal(results[2]?.summary.changed, 1, "recorded by the second day of flapping");
  const last = results.at(-1)?.endpoint;
  assert.equal(last?.tools, 2);
  assert.ok(last?.changes.some((change) => change.added.includes("send_invoice")), "the added tool is seen");
});

test("a clean run between two flaps does not start the hold-back again: the second flap is recorded", async () => {
  // Listings: day 0 A; day 1 B then A (held back); day 2 A (same as saved: no re-read); day 3 B then A (recorded).
  const script = [listA, listB, listA, listA, listB, listA];
  const results = await days(4, mcp((listing) => script[listing] ?? listA));
  assert.deepEqual(results.map((result) => [result.summary.changed, result.summary.unstable]), [[0, 0], [0, 1], [0, 0], [1, 1]]);
  assert.equal(results[3]?.endpoint.changes[0]?.unstable, true);
  assert.equal(results[3]?.endpoint.changes[0]?.since, new Date(start + 2 * day).toISOString(), "since the clean run that confirmed the old list");
});

test("flapping on odd days and reading clean on even days, for 30 days, cannot hide the new list", async () => {
  const url = "https://flaps.example.com/mcp";
  const dir = await mkdtemp(path.join(tmpdir(), "tracker-limits-"));
  let changed = 0, firstRecorded = -1;
  for (let index = 0; index <= 30; index += 1) {
    let read = 0;
    const serve = mcp(() => (index % 2 === 1 && read++ === 0 ? listB : listA));
    const at = start + index * day;
    const { summary, byUrl } = await run({ dir, urls: [url], handle: (_url, body) => serve(body), now: () => new Date(at) });
    changed += summary.changed;
    if (firstRecorded < 0 && byUrl(url).changes.some((change) => change.added.includes("send_invoice"))) firstRecorded = index;
  }
  assert.equal(firstRecorded, 3, "held back on day 1 only");
  assert.ok(changed > 1);
});

test("a canary that serves the new list to one read in five is recorded on its second flap", async () => {
  // Every fifth listing gets the new list. Day 4 flaps (held back), days 5 to 7 read clean, day 8 flaps: recorded.
  const results = await days(12, mcp((listing) => (listing % 5 === 4 ? listB : listA)));
  const recorded = results.findIndex((result) => result.endpoint.changes.some((change) => change.added.includes("send_invoice")));
  assert.equal(results[4]?.summary.unstable, 1);
  assert.equal(recorded, 8);
});

test("a real change that arrives with a value differing on every read is dated from the last time the old list was seen", async () => {
  const results = await days(3, mcp((listing) => (listing === 0 ? listA : listB.map((tool) => ({ ...tool, description: `read ${listing}` })))));
  assert.equal(results[1]?.summary.changed, 0);
  assert.equal(results[1]?.endpoint.lastListed, new Date(start).toISOString(), "a held-back run does not count as confirming the old list");
  assert.equal(results[2]?.endpoint.changes[0]?.since, new Date(start).toISOString());
  assert.equal(results[2]?.endpoint.changes[0]?.at, new Date(start + 2 * day).toISOString());
});

test("one check makes at most four attempts: a retried first read, then a retried second read", async () => {
  const url = "https://four.example.com/mcp";
  const dir = await mkdtemp(path.join(tmpdir(), "tracker-limits-"));
  await run({ dir, urls: [url], handle: (_url, body) => mcp(() => listA)(body) });
  let reads = 0;
  const changing = mcp(() => listB);
  const { summary } = await run({ dir, urls: [url], now: () => new Date(start + day), handle: (_url, body) => {
    if (body.method === "initialize" && reads++ % 2 === 0) return new Response("{}", { status: 503 });
    return changing(body);
  } });
  assert.equal(reads, 4);
  assert.equal(summary.changed, 1);
});

test("each request has 15 s and each attempt 45 s by default", () => {
  assert.deepEqual(defaultTimeouts, { requestMs: 15_000, attemptMs: 45_000 });
});

test("a server whose every request is slow, but each within the request limit, is listed even when the total is longer than one request may take", async () => {
  const url = "https://slow.example.com/mcp";
  const serve = mcp(() => listA);
  const { byUrl } = await run({ urls: [url], handle: async (_url, body) => { await new Promise((resolve) => setTimeout(resolve, 120)); return serve(body); }, more: { requestTimeoutMs: 200, attemptTimeoutMs: 1_000 } });
  assert.equal(byUrl(url).outcome, "listed");
  assert.equal(byUrl(url).lastCheck?.retries, 0);
});

test("a server that hangs costs one request's limit per attempt, not the whole attempt's", async () => {
  const url = "https://hangs.example.com/mcp";
  const began = Date.now();
  const { byUrl } = await run({ urls: [url], handle: (_url, _body, signal) => hanging(signal), more: { requestTimeoutMs: 100, attemptTimeoutMs: 3_000 } });
  assert.equal(byUrl(url).lastCheck?.errorClass, "timeout");
  assert.ok(Date.now() - began < 2_000, `took ${Date.now() - began} ms`);
});

test("after one timeout on a host, its other checks in the run get no retry", async () => {
  const urls = ["https://hang.example.com/a", "https://hang.example.com/b"];
  const asked: string[] = [];
  const { byUrl } = await run({ urls, handle: (url, body) => { if (body.method === "initialize") asked.push(url); return timingOut(); } });
  assert.equal(asked.length, 3, "two attempts for the first, one for the second");
  assert.equal(byUrl(urls[0] as string).lastCheck?.retries, 1);
  assert.equal(byUrl(urls[1] as string).lastCheck?.retries, 0);
});

test("a retry and a second read wait the host's gap first", async () => {
  const url = "https://gap.example.com/mcp";
  const times: number[] = [];
  let looks = 0;
  const serve = mcp(() => listA);
  await run({ urls: [url], handle: (_url, body) => { if (body.method === "initialize") { times.push(Date.now()); looks += 1; if (looks === 1) return new Response("{}", { status: 503 }); } return serve(body); }, more: { hostGapMs: 80 } });
  assert.equal(times.length, 2);
  assert.ok((times[1] as number) - (times[0] as number) >= 75, "the retry waited");

  const dir = await mkdtemp(path.join(tmpdir(), "tracker-limits-"));
  const reread: number[] = [];
  const changing = mcp((listing) => (listing === 0 ? listA : listB));
  await run({ dir, urls: [url], handle: (_url, body) => changing(body) });
  await run({ dir, urls: [url], handle: (_url, body) => { if (body.method === "initialize") reread.push(Date.now()); return changing(body); }, now: () => new Date(start + day), more: { hostGapMs: 80 } });
  assert.equal(reread.length, 2, "read again once");
  assert.ok((reread[1] as number) - (reread[0] as number) >= 75, "the second read waited");
});

test(`a host past its ${hostBudgetMinutes} minutes is left for the next run, without a failure for its servers, and counted run after run`, async () => {
  const urls = ["https://busy.example.com/a", "https://busy.example.com/b", "https://busy.example.com/c", "https://calm.example.com/mcp"];
  const dir = await mkdtemp(path.join(tmpdir(), "tracker-limits-"));
  const serve = mcp(() => listA);
  const runOn = async (offset: number, minutesPerCheck: number) => {
    let clock = start + offset;
    return run({ dir, urls, now: () => new Date(clock), handle: (url, body) => { if (body.method === "initialize" && url.includes("busy")) clock += minutesPerCheck * minute; return serve(body); } });
  };
  const hostsFile = async () => JSON.parse(await readFile(path.join(dir, "hosts.json"), "utf8")) as HostsFile;

  const first = await runOn(0, 6);
  assert.equal(first.summary.skipped, 1);
  const left = first.byUrl("https://busy.example.com/c");
  assert.deepEqual(left.checks, [], "no check recorded against it");
  assert.equal(left.outcome, undefined);
  assert.equal(left.lastCheck, undefined, "it has never been checked, and a skip is not a check");
  assert.equal(left.lastSkipped, new Date(start + 12 * minute).toISOString());
  assert.deepEqual(left.checkDetails, [`${left.lastSkipped} host_budget_exceeded - 0`]);
  assert.equal(first.byUrl("https://calm.example.com/mcp").outcome, "listed", "other hosts go on");
  assert.deepEqual((await hostsFile()).hosts, { "busy.example.com": { overBudgetRuns: 1, lastOverBudget: new Date(start).toISOString() } });

  await runOn(day, 6);
  assert.equal((await hostsFile()).hosts["busy.example.com"]?.overBudgetRuns, 2, "counted in a row");
  const third = await runOn(2 * day, 0);
  assert.equal(third.summary.skipped, 0);
  assert.equal(third.byUrl("https://busy.example.com/c").outcome, "listed", "looked at once the host has time");
  assert.equal((await hostsFile()).hosts["busy.example.com"]?.overBudgetRuns, 0, "the count starts again; the host is kept");
  assert.equal(third.endpoints.length, 4, "no endpoint is removed");

  // A listed endpoint left for the next run keeps its last real check; the skip is recorded beside it.
  const fourth = await runOn(3 * day, 6);
  const kept = fourth.byUrl("https://busy.example.com/c");
  assert.equal(kept.lastSkipped, new Date(start + 3 * day + 12 * minute).toISOString());
  assert.deepEqual(kept.lastCheck, { errorClass: "ok", status: 200, protocolVersion: "2025-06-18", retries: 0 });
  assert.equal(kept.outcome, "listed");
});

test("a host that uses up its time on its last endpoint is counted as over too", async () => {
  const url = "https://slowest.example.com/mcp";
  let clock = start;
  const serve = mcp(() => listA);
  const { dataDir } = await run({ urls: [url], now: () => new Date(clock), handle: (_url, body) => { if (body.method === "initialize") clock += (hostBudgetMinutes + 1) * minute; return serve(body); } });
  const hosts = (JSON.parse(await readFile(path.join(dataDir, "hosts.json"), "utf8")) as HostsFile).hosts;
  assert.equal(hosts["slowest.example.com"]?.overBudgetRuns, 1);
});

test("the second looks after the crawl stop at their deadline, and a server not looked at again is recorded from its first look", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-limits-"));
  let clock = start;
  let flakyLooks = 0;
  const serve = mcp(() => listA);
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://registry.modelcontextprotocol.io/")) return Response.json({ servers: [{ server: { name: "com.example/open", remotes: [{ type: "streamable-http", url: "https://open.example.com/mcp" }] } }], metadata: {} });
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    if (url === "https://flaky.example.com/mcp" && body.method === "initialize") { flakyLooks += 1; return new Response("{}", { status: 424 }); }
    // The crawl runs long: by its end, the second looks' deadline has passed.
    if (url === "https://open.example.com/mcp" && body.method === "initialize") clock += 3 * 3_600_000;
    return serve(body);
  }) as typeof fetch;
  await track({ dataDir, readRegistry: true, maxChecks: 10, perHost: 5, perSite: 50, concurrency: 1, hostGapMs: 0, budgetMinutes: 55, publicServers: [{ id: "flaky", name: "Flaky", url: "https://flaky.example.com/mcp", site: "https://flaky.example.com" }], environment: {}, fetchImpl, now: () => new Date(clock) });
  const flaky = (await readFile(path.join(dataDir, "endpoints.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Endpoint).find((endpoint) => endpoint.url === "https://flaky.example.com/mcp");
  assert.equal(flakyLooks, 1, "not looked at again");
  assert.equal(flaky?.outcome, "not-usable");
  assert.equal(flaky?.lastChecked, new Date(start).toISOString(), "recorded at the time of its first look");
  assert.deepEqual(flaky?.lastCheck, { errorClass: "http_4xx_other", status: 424, retries: 0 });
});

test("a check's line is written only when its class or status differs from the check before, and the newest line before the kept checks stays", () => {
  const at = (index: number) => new Date(start + index * day).toISOString();
  const endpoint: Endpoint = { id: "0123456789ab", url: "https://example.com/mcp", names: [], firstSeen: at(-10), inRegistry: true, checks: [], changes: [] };
  const walled = { outcome: "sign-in-required" as const, status: 401 };
  recordCheck(endpoint, walled, at(0), null, { errorClass: "http_4xx_auth", status: 401 });
  recordCheck(endpoint, walled, at(1), null, { errorClass: "http_4xx_auth", status: 401 });
  recordCheck(endpoint, walled, at(2), null, { errorClass: "http_4xx_auth", status: 401 });
  assert.deepEqual(endpoint.checkDetails, [`${at(0)} http_4xx_auth 401 0`], "a wall that stays the same is one line");
  recordCheck(endpoint, { outcome: "sign-in-required", status: 403 }, at(3), null, { errorClass: "http_4xx_other", status: 403 });
  recordCheck(endpoint, walled, at(4), null, { errorClass: "http_4xx_auth", status: 401 });
  assert.equal(endpoint.checkDetails?.length, 3, "each change of class is a line");

  // 40 checks later, the lines before the kept checks are gone but for the newest, which still describes the oldest kept ones.
  for (let index = 5; index < 45; index += 1) recordCheck(endpoint, walled, at(index), null, { errorClass: "http_4xx_auth", status: 401 });
  assert.equal(endpoint.checks.length, 40);
  assert.deepEqual(endpoint.checkDetails, [`${at(4)} http_4xx_auth 401 0`]);

  // A skip is a line of its own and leaves the last check alone; the check after it, the same as before, gets a line again.
  recordSkipped(endpoint, at(45));
  assert.deepEqual(endpoint.lastCheck, { errorClass: "http_4xx_auth", status: 401, retries: 0 });
  recordCheck(endpoint, walled, at(46), null, { errorClass: "http_4xx_auth", status: 401 });
  assert.deepEqual(endpoint.checkDetails?.slice(-2), [`${at(45)} host_budget_exceeded - 0`, `${at(46)} http_4xx_auth 401 0`]);
});

test("a look at a server watched with a login that never answers is cut at one attempt's time", { timeout: 5_000 }, async () => {
  const privateDir = await mkdtemp(path.join(tmpdir(), "tracker-limits-private-"));
  const publicDir = await mkdtemp(path.join(tmpdir(), "tracker-limits-"));
  // A reply that never comes and ignores its abort signal: only the look's own cap can end it.
  const fetchImpl = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  await track({ dataDir: publicDir, privateDataDir: privateDir, readRegistry: false, maxChecks: 10, perHost: 5, perSite: 50, concurrency: 1, hostGapMs: 0, budgetMinutes: 5, publicServers: [], environment: { STACKDUKE_SCAN_GRAFANA_TOKEN: "test-token" }, fetchImpl, attemptTimeoutMs: 100, now: () => new Date(start) });
  const [grafana] = (await readFile(path.join(privateDir, "endpoints.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Endpoint);
  assert.equal(grafana?.outcome, "unreachable");
  assert.equal(grafana?.lastCheck?.errorClass, "timeout");
});

test("only a run on main sends the private notice or saves the private data", async () => {
  const text = await readFile(new URL("../.github/workflows/track.yml", import.meta.url), "utf8");
  const steps = new Map(text.split(/\n(?=      - name: )/).slice(1).map((block) => [/- name: (.+)/.exec(block)?.[1] as string, block]));
  for (const name of ["Private notice", "Key for saving the private data", "Commit the private data"]) {
    assert.match(/if: \$\{\{(.+)\}\}/.exec(steps.get(name) ?? "")?.[1] ?? "", /github\.ref == 'refs\/heads\/main' &&/, name);
  }
});

test("a server watched with a login is read again when its list changes, and a flapping list is held back there too", async () => {
  const privateDir = await mkdtemp(path.join(tmpdir(), "tracker-limits-private-"));
  const publicDir = await mkdtemp(path.join(tmpdir(), "tracker-limits-"));
  const grafanaUrl = signedInServers.grafana?.url as string;
  const serve = mcp((listing) => (listing === 1 ? listB : listA));
  let listings = 0;
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    if (String(input) === grafanaUrl && body.method === "initialize") listings += 1;
    return serve(body);
  }) as typeof fetch;
  const runOn = (at: number) => track({ dataDir: publicDir, privateDataDir: privateDir, readRegistry: false, maxChecks: 10, perHost: 5, perSite: 50, concurrency: 1, hostGapMs: 0, budgetMinutes: 5, publicServers: [], environment: { STACKDUKE_SCAN_GRAFANA_TOKEN: "test-token" }, fetchImpl, now: () => new Date(at) });
  await runOn(start);
  await runOn(start + day);
  assert.equal(listings, 3, "read again once on the second day");
  const [grafana] = (await readFile(path.join(privateDir, "endpoints.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Endpoint);
  assert.equal(grafana?.unstable, new Date(start + day).toISOString());
  assert.deepEqual(grafana?.changes, []);
  assert.equal(grafana?.tools, 1);
});
