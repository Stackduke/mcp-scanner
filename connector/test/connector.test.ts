import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildData, writeData } from "../scripts/build-data.ts";
import { LABEL_ACCURACY } from "../src/config.ts";
import type { AssetFetcher } from "../src/data.ts";
import worker, { clientFromSession } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import type { QueueStore } from "../src/queue.ts";
import { runTool, scannerCommand, TOOLS } from "../src/tools.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let dataDir: string;

/** The static-assets binding, reading the built files from disk. */
function assetsFrom(dir: string): AssetFetcher {
  return {
    async fetch(request: Request) {
      const relative = new URL(request.url).pathname.slice(1);
      if (!/^(meta\.json|[sn]\/[0-9a-f]{2}\.json)$/.test(relative)) return new Response("not found", { status: 404 });
      try {
        return new Response(readFileSync(path.join(dir, relative)), { headers: { "content-type": "application/json" } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  };
}

class MemoryQueue implements QueueStore {
  entries = new Map<string, { value: string; ttl?: number }>();
  async get(key: string) { return this.entries.get(key)?.value ?? null; }
  async put(key: string, value: string, options?: { expirationTtl?: number }) { this.entries.set(key, { value, ttl: options?.expirationTtl }); }
}

interface Setup { env: Env; queue: MemoryQueue; logs: string[] }
function setup(withQueue = true, assets = assetsFrom(dataDir)): Setup {
  const queue = new MemoryQueue();
  return { env: { ASSETS: assets, CRAWL_QUEUE: withQueue ? queue : undefined }, queue, logs: [] };
}

let nextId = 1;
async function rpc(s: Setup, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const original = console.log;
  console.log = (line: string) => s.logs.push(line);
  try {
    const response = await worker.fetch(
      new Request("https://lookup.test/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) }),
      s.env,
    );
    return { response, body: response.status === 202 ? null : ((await response.json()) as Record<string, any>) };
  } finally {
    console.log = original;
  }
}

async function call(s: Setup, name: string, args: unknown, headers: Record<string, string> = {}) {
  const { body } = await rpc(s, "tools/call", { name, arguments: args }, headers);
  return body?.result as { isError: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, any> };
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "lookup-test-"));
  await writeData(await buildData(path.join(here, "fixtures", "data"), "2026-11-01T12:00:00.000Z"), dataDir);
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

describe("build", () => {
  it("writes every shard and keeps forbidden servers out of the data entirely", () => {
    assert.equal(readdirSync(path.join(dataDir, "s")).length, 256);
    assert.equal(readdirSync(path.join(dataDir, "n")).length, 256);
    const everything = readdirSync(path.join(dataDir, "s")).map((file) => readFileSync(path.join(dataDir, "s", file), "utf8")).join("");
    assert.ok(!everything.includes("sentry"), "a server on a forbidden site or namespace was kept");
    const meta = JSON.parse(readFileSync(path.join(dataDir, "meta.json"), "utf8"));
    assert.equal(meta.servers, 5);
    assert.ok(meta.forbidden_sites.includes("sentry.io"));
  });

  it("keeps only identifier-like names, and no tool text", () => {
    const everything = readdirSync(path.join(dataDir, "s")).map((file) => readFileSync(path.join(dataDir, "s", file), "utf8")).join("");
    assert.ok(!/ignore/i.test(everything), "a name with spaces reached the data");
    assert.ok(!everything.includes("[object-object]"));
    assert.ok(!everything.includes("0123456789abcdef"), "field fingerprints are not needed and should not be copied");
  });
});

describe("protocol", () => {
  it("initializes, and carries the client's name in the session id", async () => {
    const s = setup();
    const { response, body } = await rpc(s, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-ai", version: "1" }, capabilities: {} });
    assert.equal(body?.result.protocolVersion, "2025-06-18");
    assert.equal(body?.result.serverInfo.name, "mcp-server-lookup");
    const session = response.headers.get("mcp-session-id") as string;
    assert.match(session, /^claude-ai~[0-9a-f-]{36}$/);
    assert.equal(clientFromSession(session), "claude-ai");
    assert.equal(clientFromSession("not a session"), "unknown");
    assert.equal(clientFromSession(null), "unknown");
  });

  it("lists two read-only tools with the annotations the directories ask for", async () => {
    const { body } = await rpc(setup(), "tools/list");
    const tools = body?.result.tools as Array<Record<string, any>>;
    assert.deepEqual(tools.map((tool) => tool.name), ["check_mcp_server", "mcp_server_changes"]);
    for (const tool of tools) {
      assert.ok(tool.name.length <= 64);
      assert.ok(tool.title);
      assert.deepEqual(
        { title: tool.annotations.title, readOnlyHint: tool.annotations.readOnlyHint, destructiveHint: tool.annotations.destructiveHint, openWorldHint: tool.annotations.openWorldHint },
        { title: tool.title, readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      );
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });

  it("promotes nothing in its own descriptions", async () => {
    const { body } = await rpc(setup(), "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const ownWords = JSON.stringify([TOOLS.map(({ title, description, inputSchema }) => ({ title, description, inputSchema })), body?.result.instructions, body?.result.serverInfo]);
    assert.ok(!/stackduke|best|trusted|recommend|safe to/i.test(ownWords), ownWords);
  });

  it("answers protocol mistakes with the right errors", async () => {
    const s = setup();
    assert.equal((await rpc(s, "tools/call", { name: "delete_server", arguments: {} })).body?.error.code, -32602);
    assert.equal((await rpc(s, "resources/list")).body?.error.code, -32601);
    assert.equal((await rpc(s, "tools/list", undefined, { "mcp-protocol-version": "1999-01-01" })).response.status, 400);
    const get = await worker.fetch(new Request("https://lookup.test/mcp"), s.env);
    assert.equal(get.status, 405);
    const big = await worker.fetch(new Request("https://lookup.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(20_000) }), s.env);
    assert.equal(big.status, 413);
    const note = await worker.fetch(new Request("https://lookup.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), s.env);
    assert.equal(note.status, 202);
    assert.equal((await worker.fetch(new Request("https://lookup.test/s/00.json"), s.env)).status, 404, "data files are not served directly");
  });
});

describe("check_mcp_server: found", () => {
  it("answers for a featured server by address, with labels, page and the accuracy note", async () => {
    const result = await call(setup(), "check_mcp_server", { url_or_name: "https://mcp.aave.com/" });
    assert.equal(result.isError, false);
    const answer = result.structuredContent as Record<string, any>;
    assert.equal(answer.status, "found");
    assert.equal(answer.server.listed_as, "featured");
    assert.equal(answer.server.page, "https://stackduke.com/tracker/aave");
    assert.deepEqual(answer.tools.kind_counts, { money: 1, write: 1, read: 2 });
    assert.deepEqual(answer.tools.names_by_kind.money, ["prepare_order"]);
    assert.ok(answer.labels_note.includes("machine guesses"));
    assert.ok(answer.labels_note.includes(LABEL_ACCURACY));
    assert.match(answer.text_checks, /^Not published/);
    assert.equal(answer.data_as_of, "2026-11-01T11:42:19.864Z");
    assert.deepEqual(JSON.parse(result.content[0]?.text as string), answer, "the text item carries the same answer");
  });

  it("finds an address without or with its trailing slash, by registry name, short name or featured name", async () => {
    const s = setup();
    for (const query of ["https://mcp.aave.com", "com.aave/mcp", "Aave", "  AAVE  "]) {
      assert.equal((await call(s, "check_mcp_server", { url_or_name: query })).structuredContent?.server.url, "https://mcp.aave.com/", query);
    }
    assert.equal((await call(s, "check_mcp_server", { url_or_name: "https://notes-two.example.org/mcp" })).structuredContent?.server.url, "https://notes-two.example.org/mcp/");
    assert.equal((await call(s, "check_mcp_server", { url_or_name: "weather" })).structuredContent?.server.listed_as, "community");
  });

  it("lists the candidates when a name matches several servers", async () => {
    const answer = (await call(setup(), "check_mcp_server", { url_or_name: "notes" })).structuredContent as Record<string, any>;
    assert.equal(answer.status, "several_matches");
    assert.equal(answer.total, 2);
    assert.deepEqual(answer.matches.map((match: any) => match.url).sort(), ["https://notes-one.example.net/mcp", "https://notes-two.example.org/mcp/"]);
  });

  it("says when the latest check did not list tools", async () => {
    const answer = (await call(setup(), "check_mcp_server", { url_or_name: "com.example/flaky" })).structuredContent as Record<string, any>;
    assert.equal(answer.checks.latest_outcome, "unreachable");
    assert.match(answer.summary, /did not list tools \(unreachable\)/);
    assert.equal(answer.tools.names_not_shown, 1, "the withheld name is counted, not shown");
  });

  it("keeps server-written names out of every sentence it writes", async () => {
    const s = setup();
    for (const [tool, query] of [["check_mcp_server", "weather"], ["check_mcp_server", "Aave"], ["mcp_server_changes", "Aave"]] as const) {
      const answer = (await call(s, tool, { url_or_name: query })).structuredContent as Record<string, any>;
      for (const name of ["delete_forecast", "email_report", "get_forecast", "prepare_order", "get_markets", "old_tool", "weather", "com.aave"]) {
        assert.ok(!answer.summary.includes(name), `${name} appeared in a summary`);
      }
      assert.ok(!JSON.stringify(answer).toLowerCase().includes("ignore"), "a name that reads as an instruction came through");
    }
  });

  it("warns when the data is old", async () => {
    const outcome = await runTool({ tool: "check_mcp_server", query: "Aave" }, { assets: assetsFrom(dataDir), now: new Date("2026-11-04T00:00:00Z") });
    assert.ok(outcome.ok && String(outcome.answer.summary).includes("more than 36 hours old"));
  });
});

describe("mcp_server_changes", () => {
  it("returns the kept changes with the window each happened in", async () => {
    const answer = (await call(setup(), "mcp_server_changes", { url_or_name: "https://mcp.aave.com/" })).structuredContent as Record<string, any>;
    assert.equal(answer.status, "found");
    assert.equal(answer.changes.length, 2);
    assert.deepEqual(answer.changes[0].seen_between, { after: "2026-10-28T10:40:14.276Z", before: "2026-10-28T17:08:30.098Z" });
    assert.deepEqual(answer.changes[0].more_serious, [{ name: "prepare_order", kind: "money" }]);
    assert.deepEqual(answer.changes[1].removed, ["old_tool"], "the instruction-like name is withheld");
    assert.equal(answer.changes[1].counts.removed, 2, "but still counted");
  });

  it("filters by since, and says what was watched when nothing changed", async () => {
    const s = setup();
    const recent = (await call(s, "mcp_server_changes", { url_or_name: "Aave", since: "2026-10-25" })).structuredContent as Record<string, any>;
    assert.equal(recent.changes.length, 1);
    assert.equal(recent.since, "2026-10-25T00:00:00.000Z");
    const none = (await call(s, "mcp_server_changes", { url_or_name: "weather", since: "2026-10-01T00:00:00Z" })).structuredContent as Record<string, any>;
    assert.equal(none.changes.length, 0);
    assert.match(none.summary, /No change was seen since 2026-10-01\. The tracker checked this server 16 times/);
    assert.match(none.summary, /Tracking began on 2026-10-16/);
  });
});

describe("unknown servers", () => {
  it("says not tracked, gives the local command, and queues a public address once", async () => {
    const s = setup();
    const first = (await call(s, "check_mcp_server", { url_or_name: "https://new.example.com/mcp" })).structuredContent as Record<string, any>;
    assert.equal(first.status, "not_tracked");
    assert.equal(first.queued, "queued");
    assert.equal(first.scan_on_your_machine, "npx @stackduke/mcp-scanner check https://new.example.com/mcp");
    assert.match(first.summary, /cannot say whether or when it will be checked/);
    assert.ok(first.labels_note.includes(LABEL_ACCURACY));
    assert.equal(s.queue.entries.size, 1);
    const [key, entry] = [...s.queue.entries][0] as [string, { value: string; ttl?: number }];
    assert.match(key, /^queue:[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(JSON.parse(entry.value)).sort(), ["queued_at", "url"], "only the address and the time are stored");
    assert.ok(entry.ttl);
    const second = (await call(s, "mcp_server_changes", { url_or_name: "https://new.example.com/mcp" })).structuredContent as Record<string, any>;
    assert.equal(second.queued, "queued", "a second request looks the same as a first, so it reveals nothing about others");
    assert.equal(s.queue.entries.size, 1);
  });

  it("answers without queuing when there is no queue, or only a name", async () => {
    assert.equal((await call(setup(false), "check_mcp_server", { url_or_name: "https://new.example.com/mcp" })).structuredContent?.queued, "not_queued");
    const s = setup();
    const answer = (await call(s, "check_mcp_server", { url_or_name: "io.github.nobody/nothing" })).structuredContent as Record<string, any>;
    assert.equal(answer.status, "not_tracked");
    assert.equal(answer.query_kind, "name");
    assert.equal(s.queue.entries.size, 0);
  });

  it("puts only plain addresses into the command, so it is safe to paste into any shell", () => {
    for (const url of ["https://x.example.com/a'b", "https://x.example.com/$(id)", "https://evil.example/mcp?a&calc", "https://x.example.com/100%25"]) {
      assert.equal(scannerCommand(url), "npx @stackduke/mcp-scanner check <server address>", url);
    }
    assert.equal(scannerCommand("https://x.example.com/v1/mcp"), "npx @stackduke/mcp-scanner check https://x.example.com/v1/mcp");
  });

  for (const url of ["https://mcp.example.com/mcp?api_key=SECRET123", "https://mcp.example.com/sk_live_51HxQ2bL9xYz/mcp", "https://mcp.example.com/u/0123456789abcdef0123456789abcdef"]) {
    it(`never stores an address that may hold a key: ${url}`, async () => {
      const s = setup();
      const answer = (await call(s, "check_mcp_server", { url_or_name: url })).structuredContent as Record<string, any>;
      assert.equal(answer.status, "not_tracked");
      assert.equal(answer.queued, "not_queued");
      assert.match(answer.summary, /never stored/);
      assert.equal(s.queue.entries.size, 0);
    });
  }

  it("stops adding to the queue when the caller is over its queue limit, and still answers", async () => {
    const queue = new MemoryQueue();
    const outcome = await runTool({ tool: "check_mcp_server", query: "https://new.example.com/mcp" }, { assets: assetsFrom(dataDir), queue, queueAllowed: async () => false, now: new Date() });
    assert.ok(outcome.ok);
    assert.equal(outcome.answer.queued, "not_queued");
    assert.equal(queue.entries.size, 0);
  });

  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    it(`treats the name ${name} as an ordinary unknown name`, async () => {
      const result = await call(setup(), "check_mcp_server", { url_or_name: name });
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent?.status, "not_tracked");
    });
  }
});

describe("forbidden and unpublished servers", () => {
  for (const query of ["https://mcp.sentry.dev/mcp", "https://eu.sentry.io/mcp", "Sentry", "intercom", "io.sentry/mcp", "io.sentry/proxy"]) {
    it(`returns nothing about ${query}, and queues nothing`, async () => {
      const s = setup();
      for (const tool of ["check_mcp_server", "mcp_server_changes"]) {
        const result = await call(s, tool, { url_or_name: query });
        assert.equal(result.isError, false);
        assert.deepEqual(Object.keys(result.structuredContent as object).sort(), ["data_as_of", "labels_note", "scan_on_your_machine", "status", "summary"]);
        assert.equal(result.structuredContent?.status, "no_data");
        assert.equal(result.structuredContent?.scan_on_your_machine, "npx @stackduke/mcp-scanner check <server address>");
      }
      assert.equal(s.queue.entries.size, 0);
    });
  }

  it("says nothing about catalog servers the tracker does not publish, and does not queue them", async () => {
    const s = setup();
    for (const query of ["https://api.githubcopilot.com/mcp/", "https://api.githubcopilot.com/mcp", "GitHub", "linear"]) {
      assert.equal((await call(s, "check_mcp_server", { url_or_name: query })).structuredContent?.status, "no_data", query);
    }
    assert.equal(s.queue.entries.size, 0);
  });
});

describe("bad input", () => {
  const cases: Array<[string, unknown]> = [
    ["plain http", { url_or_name: "http://example.com/mcp" }],
    ["localhost", { url_or_name: "https://localhost:3000/mcp" }],
    ["a private name", { url_or_name: "https://printer.local/mcp" }],
    ["an IP address", { url_or_name: "https://10.0.0.1/mcp" }],
    ["a login in the address", { url_or_name: "https://user:pass@example.com/mcp" }],
    ["empty", { url_or_name: "   " }],
    ["too long", { url_or_name: `https://example.com/${"a".repeat(600)}` }],
    ["control characters", { url_or_name: "aave\u0007" }],
    ["odd characters in a name", { url_or_name: "aave; rm -rf /" }],
    ["missing", {}],
    ["not a string", { url_or_name: 42 }],
    ["an extra argument", { url_or_name: "Aave", verbose: true }],
    ["not an object", ["Aave"]],
  ];
  for (const [label, args] of cases) {
    it(`refuses ${label} with a tool error`, async () => {
      const s = setup();
      const result = await call(s, "check_mcp_server", args);
      assert.equal(result.isError, true);
      assert.ok(result.content[0]?.text);
      assert.equal(result.structuredContent, undefined);
      assert.equal(s.queue.entries.size, 0);
    });
  }

  for (const since of ["yesterday", "2026-02-31", "2999-01-01", "2026-10-01T00:00:00+02:00", 20261001]) {
    it(`refuses since=${since}`, async () => {
      const result = await call(setup(), "mcp_server_changes", { url_or_name: "Aave", since });
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text as string, /since must be a date/);
    });
  }

  it("answers an unexpected failure with a JSON-RPC error and a fixed log line", async () => {
    const failing: AssetFetcher = { fetch: async () => { throw new TypeError("boom"); } };
    const s = setup(true, failing);
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      const { response, body } = await rpc(s, "tools/call", { name: "check_mcp_server", arguments: { url_or_name: "https://private-thing.example.com/mcp" } });
      assert.equal(response.status, 500);
      assert.equal(body?.error.code, -32603);
    } finally {
      console.error = original;
    }
    assert.deepEqual(errors, ["lookup: internal error"]);
  });

  it("says plainly when the data cannot be read", async () => {
    const broken: AssetFetcher = { fetch: async () => new Response("gone", { status: 404 }) };
    const result = await call(setup(true, broken), "check_mcp_server", { url_or_name: "Aave" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text as string, /could not be read right now/);
  });
});

describe("logging", () => {
  it("logs one line per tool call: client name, tool and time, and nothing else", async () => {
    const s = setup();
    const { response } = await rpc(s, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Claude Desktop", version: "1" } });
    const session = response.headers.get("mcp-session-id") as string;
    await rpc(s, "tools/list", undefined, { "mcp-session-id": session });
    await call(s, "check_mcp_server", { url_or_name: "https://secret-project.example.com/mcp" }, { "mcp-session-id": session });
    await call(s, "mcp_server_changes", { url_or_name: "Aave" });
    assert.equal(s.logs.length, 2, "initialize and tools/list log nothing");
    const [first, second] = s.logs.map((line) => JSON.parse(line));
    assert.deepEqual(Object.keys(first).sort(), ["at", "client", "event", "tool"]);
    assert.equal(first.client, "Claude-Desktop");
    assert.equal(first.tool, "check_mcp_server");
    assert.equal(second.client, "unknown");
    assert.ok(!s.logs.join("").includes("secret-project"), "arguments are never logged");
  });
});
