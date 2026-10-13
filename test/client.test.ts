import assert from "node:assert/strict";
import { test } from "node:test";
import { listTools, readRpcReply, readTool } from "../src/client.ts";

type Sent = { headers: Record<string, string>; body: Record<string, unknown> };
function fakeServer(...responses: Array<Response | Error>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const next = responses.shift();
    if (!next) throw new Error("no response prepared");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, sent };
}
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json", ...headers } });
const hello = (headers: Record<string, string> = {}) => json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "Demo", version: "1.2.3" }, capabilities: {} } }, headers);
const accepted = () => new Response(null, { status: 202 });
const tools = (list: unknown[], nextCursor?: string) => json({ jsonrpc: "2.0", id: 2, result: { tools: list, ...(nextCursor ? { nextCursor } : {}) } });

test("lists tools after the handshake and never sends a credential or calls a tool", async () => {
  const { fetchImpl, sent } = fakeServer(hello({ "Mcp-Session-Id": "session-1" }), accepted(), tools([{ name: "read_file", description: "Reads a file." }]));
  const result = await listTools("https://example.test/mcp", { fetchImpl });
  assert.deepEqual(result, { outcome: "listed", server: { name: "Demo", version: "1.2.3" }, tools: [{ name: "read_file", description: "Reads a file." }] });
  assert.deepEqual(sent.map((request) => request.body.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.ok(sent.every((request) => !Object.keys(request.headers).some((name) => name.toLowerCase() === "authorization")));
  assert.equal(sent[2]?.headers["Mcp-Session-Id"], "session-1");
});

test("reads a reply sent as an event stream", async () => {
  const stream = new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search" }] } })}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const { fetchImpl } = fakeServer(hello(), accepted(), stream);
  const result = await listTools("https://example.test/mcp", { fetchImpl });
  assert.equal(result.outcome, "listed");
  assert.deepEqual(result.outcome === "listed" ? result.tools : [], [{ name: "search" }]);
});

test("follows pages of tools to the end", async () => {
  const paged = fakeServer(hello(), accepted(), tools([{ name: "a" }], "next"), tools([{ name: "b" }]));
  const all = await listTools("https://example.test/mcp", { fetchImpl: paged.fetchImpl });
  assert.deepEqual(all.outcome === "listed" ? all.tools.map((tool) => tool.name) : [], ["a", "b"]);
  assert.deepEqual(paged.sent[3]?.body.params, { cursor: "next" });
});

test("a list that does not end, or is not a list, is refused instead of being reported as complete", async () => {
  // A partial list would make the missing tools look removed in the next comparison.
  const endless = fakeServer(hello(), accepted(), tools([{ name: "a" }], "more"), tools([{ name: "b" }], "more"));
  assert.deepEqual(await listTools("https://example.test/mcp", { fetchImpl: endless.fetchImpl, maxPages: 2 }), { outcome: "not-usable", detail: "the tool list did not end after 2 pages" });
  const noList = fakeServer(hello(), accepted(), json({ jsonrpc: "2.0", id: 2, result: {} }));
  assert.deepEqual(await listTools("https://example.test/mcp", { fetchImpl: noList.fetchImpl }), { outcome: "not-usable", detail: "tools/list returned no list of tools" });
});

test("a reply larger than the limit is refused without being read to the end", async () => {
  let pulled = 0;
  const endlessBody = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1_000_000)); } });
  const { fetchImpl } = fakeServer(new Response(endlessBody, { status: 200, headers: { "Content-Type": "application/json" } }));
  assert.deepEqual(await listTools("https://example.test/mcp", { fetchImpl }), { outcome: "not-usable", detail: "a reply was larger than this scanner accepts" });
  assert.ok(pulled < 12, `read ${pulled} MB of an endless body`);
});

test("redirects are refused, so a server cannot send the scanner somewhere else", async () => {
  const options: RequestInit[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => { options.push(init ?? {}); return new Response("", { status: 401 }); }) as typeof fetch;
  await listTools("https://example.test/mcp", { fetchImpl });
  assert.equal(options[0]?.redirect, "error");
});

test("a server that wants a sign-in is reported as that, at either step", async () => {
  assert.deepEqual(await listTools("https://example.test/mcp", { fetchImpl: fakeServer(new Response("", { status: 401 })).fetchImpl }), { outcome: "sign-in-required", status: 401 });
  assert.deepEqual(await listTools("https://example.test/mcp", { fetchImpl: fakeServer(hello(), accepted(), new Response("", { status: 403 })).fetchImpl }), { outcome: "sign-in-required", status: 403 });
});

test("an answer that is not MCP, an error status and a dead connection are told apart", async () => {
  assert.deepEqual(await listTools("https://example.test/mcp", { fetchImpl: fakeServer(new Response("<html>", { status: 200 })).fetchImpl }), { outcome: "not-usable", detail: "initialize returned no result" });
  assert.deepEqual(await listTools("https://example.test/mcp", { fetchImpl: fakeServer(new Response("", { status: 500 })).fetchImpl }), { outcome: "not-usable", detail: "initialize answered 500" });
  assert.deepEqual(await listTools("https://example.test/mcp", { fetchImpl: fakeServer(new TypeError("fetch failed")).fetchImpl }), { outcome: "unreachable", detail: "TypeError" });
  const refused = fakeServer(hello(), accepted(), json({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } }));
  assert.deepEqual(await listTools("https://example.test/mcp", { fetchImpl: refused.fetchImpl }), { outcome: "not-usable", detail: "tools/list was refused" });
});

test("a server that ignores the initialized notification is still listed", async () => {
  const { fetchImpl } = fakeServer(hello(), new TypeError("connection reset"), tools([{ name: "a" }]));
  assert.equal((await listTools("https://example.test/mcp", { fetchImpl })).outcome, "listed");
});

test("only fields the protocol defines are kept, and only with the right shape", () => {
  assert.deepEqual(readTool({ name: "t", title: 3, description: "d", inputSchema: { type: "object" }, annotations: ["x"], extra: "dropped" }), { name: "t", description: "d", inputSchema: { type: "object" } });
  assert.equal(readTool({ description: "no name" }), null);
  assert.equal(readTool("tool"), null);
  assert.equal(readRpcReply("application/json", "not json"), null);
  assert.equal(readRpcReply("text/event-stream", "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}\n\n"), null);
});
