import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { track } from "../src/track.ts";
import type { Endpoint, Feed, FeedServer } from "../src/tracker.ts";
import type { ToolDefinition } from "../src/types.ts";

/**
 * Runs of the tracker over one open server whose every look is scripted: a list of tools, or a failure. Each look
 * starts with initialize, so the looks are counted there. Nothing leaves this process.
 */
type Look = ToolDefinition[] | (() => Response);
const day = 24 * 3_600_000;
const start = Date.parse("2026-11-20T04:17:00.000Z");
const url = "https://open.example.com/mcp";
const timingOut = () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
const refusing = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); };
const unresolved = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }); };
const answering = (status: number, headers: Record<string, string> = {}) => () => new Response("{}", { status, headers });

const listA: ToolDefinition[] = [{ name: "get_page", annotations: { readOnlyHint: true } }];
const listB: ToolDefinition[] = [...listA, { name: "send_invoice" }];
const listC: ToolDefinition[] = [{ name: "get_page", description: "Another wording.", annotations: { readOnlyHint: true } }];

async function tracker(dataDir?: string) {
  const dir = dataDir ?? await mkdtemp(path.join(tmpdir(), "tracker-outcomes-"));
  let script: Look[] = [];
  let looks = 0;
  let current: Look = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const address = String(input);
    if (address.startsWith("https://registry.modelcontextprotocol.io/")) return Response.json({ servers: [{ server: { name: "com.example/open", remotes: [{ type: "streamable-http", url }] } }], metadata: {} });
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    if (body.method === "initialize") {
      current = script[looks] ?? script.at(-1) ?? [];
      looks += 1;
      if (typeof current === "function") return current();
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "Open" } } });
    }
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: current } });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  let runs = 0;
  return {
    dataDir: dir,
    /** One run, a day after the last, whose looks go as scripted. Returns the run's summary, the looks made and the endpoint. */
    async run(...looksScripted: Look[]) {
      script = looksScripted; looks = 0;
      const at = start + runs * day;
      runs += 1;
      const summary = await track({ dataDir: dir, readRegistry: true, maxChecks: 10, perHost: 5, perSite: 50, concurrency: 1, hostGapMs: 0, budgetMinutes: 5, publicServers: [], environment: {}, fetchImpl, now: () => new Date(at) });
      const [line] = (await readFile(path.join(dir, "endpoints.jsonl"), "utf8")).trim().split("\n");
      return { summary, looks, endpoint: JSON.parse(line ?? "{}") as Endpoint };
    },
  };
}

test("a timeout, a refused connection or a 5xx is tried once more at once, and the retry is recorded", async () => {
  for (const [name, failure, errorClass, status] of [["a timeout", timingOut, "timeout", "-"], ["a refused connection", refusing, "connect", "-"], ["503", answering(503), "http_5xx", "503"]] as const) {
    const cleared = await (await tracker()).run(failure, listA);
    assert.equal(cleared.looks, 2, name);
    assert.equal(cleared.endpoint.outcome, "listed", name);
    assert.equal(cleared.endpoint.checks.length, 1, `${name}: one check, not a miss and then a listing`);
    assert.deepEqual(cleared.endpoint.lastCheck, { errorClass: "ok", status: 200, protocolVersion: "2025-06-18", retries: 1 }, name);
    assert.deepEqual(cleared.endpoint.checkDetails, [`${cleared.endpoint.lastChecked} ok 200 1`], `${name}: a listing that needed a retry says so`);

    const failed = await (await tracker()).run(failure);
    assert.equal(failed.looks, 2, `${name}: one retry, no more`);
    assert.equal(failed.endpoint.lastCheck?.errorClass, errorClass, name);
    assert.equal(failed.endpoint.lastCheck?.retries, 1, name);
    assert.deepEqual(failed.endpoint.checkDetails, [`${failed.endpoint.lastChecked} ${errorClass} ${status} 1`], name);
  }
});

test("a failure that will not clear up in seconds is recorded at once, with its class", async () => {
  for (const [name, failure, errorClass, status] of [
    ["a name that does not resolve", unresolved, "dns", undefined],
    ["a 401 naming a way in", answering(401, { "WWW-Authenticate": "Bearer" }), "http_4xx_auth", 401],
    ["a 403 naming none", answering(403), "http_4xx_other", 403],
    ["a 404", answering(404), "http_4xx_other", 404],
    ["a page that is not JSON", () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }), "invalid_json", 200],
    ["JSON that is not MCP", () => Response.json({ hello: "world" }), "protocol_error", 200],
  ] as const) {
    const { looks, endpoint } = await (await tracker()).run(failure);
    assert.equal(looks, 1, name);
    assert.deepEqual(endpoint.lastCheck, { errorClass, ...(status ? { status } : {}), retries: 0 }, name);
    assert.deepEqual(endpoint.checkDetails, [`${endpoint.lastChecked} ${errorClass} ${status ?? "-"} 0`], name);
  }
});

test("a list that changes and reads back as before on a second read is unstable, and no change is recorded", async () => {
  const server = await tracker();
  await server.run(listA);
  const savedFile = async (endpoint: Endpoint) => readFile(path.join(server.dataDir, endpoint.file ?? ""), "utf8");
  const before = (await server.run(listA)).endpoint;
  const listBefore = await savedFile(before);

  const { summary, looks, endpoint } = await server.run(listB, listA);
  assert.equal(looks, 2, "read again once");
  assert.equal(summary.changed, 0);
  assert.equal(summary.unstable, 1);
  assert.deepEqual(endpoint.changes, []);
  assert.equal(endpoint.unstable, endpoint.lastChecked);
  assert.equal(endpoint.listHash, before.listHash, "the saved list stands");
  assert.equal(endpoint.tools, 1);
  assert.equal(await savedFile(endpoint), listBefore, "the saved list is not rewritten");
  assert.equal(endpoint.lastListed, before.lastListed, "the saved list was last confirmed the run before");
  assert.equal(endpoint.lastCheck?.unstable, true);
  assert.equal(endpoint.checkDetails?.at(-1), `${endpoint.lastChecked} ok 200 0 unstable`);
  const servers = JSON.parse(await readFile(path.join(server.dataDir, "servers.json"), "utf8")) as FeedServer[];
  assert.equal(servers[0]?.unstable, endpoint.lastChecked, "the page can show it");
  const feed = JSON.parse(await readFile(path.join(server.dataDir, "feed.json"), "utf8")) as Feed;
  assert.deepEqual(feed.changes, []);
});

test("a list that changes to yet another list on the second read is unstable too", async () => {
  const server = await tracker();
  await server.run(listA);
  const { summary, endpoint } = await server.run(listB, listC);
  assert.equal(summary.unstable, 1);
  assert.deepEqual(endpoint.changes, []);
  assert.equal(endpoint.tools, 1);
});

test("a list that changes and reads the same on a second read is recorded as changed today", async () => {
  const server = await tracker();
  const first = (await server.run(listA)).endpoint;
  const { summary, looks, endpoint } = await server.run(listB, listB);
  assert.equal(looks, 2);
  assert.equal(summary.changed, 1);
  assert.equal(summary.unstable, 0);
  assert.equal(endpoint.changes[0]?.at, endpoint.lastChecked);
  assert.equal(endpoint.changes[0]?.since, first.lastListed);
  assert.deepEqual(endpoint.changes[0]?.added, ["send_invoice"]);
  assert.equal(endpoint.unstable, undefined);
  assert.equal(endpoint.tools, 2);
  assert.equal(endpoint.checkDetails, undefined, "a listing at the first attempt has nothing more to say");
});

test("a second read that lists nothing proves no flapping, so the change it was checking stands", async () => {
  const server = await tracker();
  await server.run(listA);
  const { summary, endpoint } = await server.run(listB, answering(404));
  assert.equal(summary.changed, 1);
  assert.equal(endpoint.unstable, undefined);
  assert.equal(endpoint.tools, 2);
});

test("a list that is not different is not read again", async () => {
  const server = await tracker();
  await server.run(listA);
  assert.equal((await server.run(listA, listB)).looks, 1);
});

test("data written before these facts were recorded is read as before, and its checks keep their shape", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "tracker-outcomes-"));
  // An endpoint as the tracker wrote it before: checks as `<time> <code>`, no lastCheck, checkDetails or unstable.
  const old: Endpoint = { id: "0123456789ab", url, names: ["com.example/open"], firstSeen: "2026-10-20T04:17:00.000Z", inRegistry: true, lastChecked: "2026-11-05T04:17:00.000Z", outcome: "unreachable", outcomeSince: "2026-11-01T04:17:00.000Z", checks: ["2026-11-01T04:17:00.000Z U", "2026-11-05T04:17:00.000Z U"], changes: [] };
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "endpoints.jsonl"), `${JSON.stringify(old)}\n`);
  const server = await tracker(dataDir);
  const { looks, endpoint } = await server.run(answering(404));
  assert.equal(looks, 1, "its rest is over, so it is looked at");
  assert.deepEqual(endpoint.checks.slice(0, 2), old.checks, "older checks are kept as they were");
  assert.ok(endpoint.checks.every((check) => /^\S+ [LSNUT]$/.test(check)), "every check keeps the `<time> <code>` shape readers match on");
  assert.deepEqual(endpoint.checkDetails, [`${endpoint.lastChecked} http_4xx_other 404 0`], "details start with the first check that has them");
  const feed = JSON.parse(await readFile(path.join(dataDir, "feed.json"), "utf8")) as Feed;
  assert.equal(feed.version, 1);
  assert.equal(feed.coverage.notUsable, 1);
});
