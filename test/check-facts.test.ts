import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { listToolsWithFacts } from "../src/client.ts";

/**
 * Why a check ended as it did, from servers on this machine only: each error class from a real local socket where one
 * can produce it, and from the error fetch would throw where it cannot (a name that does not resolve).
 */
async function serve(handler: (request: IncomingMessage, response: ServerResponse, method: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => handler(request, response, (JSON.parse(body || "{}") as { method?: string }).method ?? ""));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const json = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(value));
};
/** A server that answers initialize with `initialize`, and lists one tool. */
const mcp = (initialize: (response: ServerResponse) => void, list?: (response: ServerResponse) => void) => (_request: IncomingMessage, response: ServerResponse, method: string) => {
  if (method === "initialize") return initialize(response);
  if (method === "tools/list") return list ? list(response) : json(response, 200, { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "get_page" }] } });
  response.writeHead(202).end();
};
const agreed = (version: unknown) => (response: ServerResponse) => json(response, 200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: version, serverInfo: { name: "Local" } } });

async function factsFrom(handler: Parameters<typeof serve>[0], timeoutMs = 2_000) {
  const server = await serve(handler);
  try { return await listToolsWithFacts(server.url, { timeoutMs }); } finally { await server.close(); }
}

test("a check that lists tools is ok, with the status and the protocol version the server agreed", async () => {
  const { result, facts } = await factsFrom(mcp(agreed("2025-06-18")));
  assert.equal(result.outcome, "listed");
  assert.deepEqual(facts, { errorClass: "ok", status: 200, protocolVersion: "2025-06-18" });
});

test("a protocol version that is not an identifier is not kept: it is the server's own text", async () => {
  const { facts } = await factsFrom(mcp(agreed("2025-06-18 <script>")));
  assert.deepEqual(facts, { errorClass: "ok", status: 200 });
});

test("a server that never answers in time is a timeout", async () => {
  const { result, facts } = await factsFrom(() => undefined, 150);
  assert.equal(result.outcome, "unreachable");
  assert.equal(facts.errorClass, "timeout");
  assert.equal(facts.status, undefined);
});

test("a port nobody listens on is a connect failure", async () => {
  const server = await serve(() => undefined);
  const { url } = server;
  await server.close();
  const { result, facts } = await listToolsWithFacts(url, { timeoutMs: 2_000 });
  assert.equal(result.outcome, "unreachable");
  assert.equal(facts.errorClass, "connect");
});

test("a TLS handshake that fails is a tls failure", async () => {
  // https to a server that speaks plain http: the handshake cannot complete.
  const server = await serve(mcp(agreed("2025-06-18")));
  try {
    const { result, facts } = await listToolsWithFacts(server.url.replace("http:", "https:"), { timeoutMs: 2_000 });
    assert.equal(result.outcome, "unreachable");
    assert.equal(facts.errorClass, "tls");
  } finally { await server.close(); }
});

test("a name that does not resolve is a dns failure, marked temporary when the name server says it may clear up", async () => {
  for (const [code, expected] of [["ENOTFOUND", { errorClass: "dns" }], ["EAI_AGAIN", { errorClass: "dns", temporary: true }]] as const) {
    const fetchImpl = (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ${code}`), { code }) }); }) as typeof fetch;
    const { result, facts } = await listToolsWithFacts("https://nowhere.invalid/mcp", { fetchImpl });
    assert.equal(result.outcome, "unreachable", code);
    assert.deepEqual(facts, expected, code);
  }
});

test("an error that is not the network's is a protocol_error, not a connect failure to retry", async () => {
  const fetchImpl = (async () => { throw new RangeError("a bug, not a network"); }) as typeof fetch;
  const { result, facts } = await listToolsWithFacts("https://example.test/mcp", { fetchImpl });
  assert.equal(result.outcome, "unreachable");
  assert.equal(facts.errorClass, "protocol_error");
  const reset = (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }); }) as typeof fetch;
  assert.equal((await listToolsWithFacts("https://example.test/mcp", { fetchImpl: reset })).facts.errorClass, "connect");
});

test("a 401 or 403 that says how to log in is an auth wall; one that does not is told apart", async () => {
  const bearer = { "WWW-Authenticate": 'Bearer resource_metadata="https://127.0.0.1/.well-known/oauth-protected-resource"' };
  for (const status of [401, 403]) {
    const walled = await factsFrom(mcp((response) => json(response, status, {}, bearer)));
    assert.deepEqual(walled.result, { outcome: "sign-in-required", status });
    assert.deepEqual(walled.facts, { errorClass: "http_4xx_auth", status });
  }
  // A firewall or bot wall: still recorded as needing a sign-in, as before, but its class says it named no way in.
  const blocked = await factsFrom(mcp((response) => json(response, 403, { error: "forbidden" })));
  assert.deepEqual(blocked.result, { outcome: "sign-in-required", status: 403 });
  assert.deepEqual(blocked.facts, { errorClass: "http_4xx_other", status: 403 });
  const listBlocked = await factsFrom(mcp(agreed("2025-06-18"), (response) => json(response, 401, {})));
  assert.deepEqual(listBlocked.facts, { errorClass: "http_4xx_other", status: 401, protocolVersion: "2025-06-18" }, "a 401 to tools/list with no way in named");
});

test("another 4xx is http_4xx_other, and a 5xx is http_5xx, whether to initialize or to tools/list", async () => {
  const missing = await factsFrom(mcp((response) => json(response, 404, {})));
  assert.deepEqual(missing.result, { outcome: "not-usable", detail: "initialize answered 404" });
  assert.deepEqual(missing.facts, { errorClass: "http_4xx_other", status: 404 });
  const down = await factsFrom(mcp((response) => json(response, 503, {})));
  assert.deepEqual(down.facts, { errorClass: "http_5xx", status: 503 });
  const listFails = await factsFrom(mcp(agreed("2025-06-18"), (response) => { response.writeHead(500).end("oops"); }));
  assert.equal(listFails.result.outcome, "not-usable");
  assert.deepEqual(listFails.facts, { errorClass: "http_5xx", status: 500, protocolVersion: "2025-06-18" });
});

test("a body that is not JSON is invalid_json; JSON that is not an MCP answer, or a redirect, is a protocol_error", async () => {
  const html = await factsFrom(mcp((response) => { response.writeHead(200, { "Content-Type": "text/html" }).end("<html>"); }));
  assert.deepEqual(html.result, { outcome: "not-usable", detail: "initialize returned no result" });
  assert.deepEqual(html.facts, { errorClass: "invalid_json", status: 200 });
  const notMcp = await factsFrom(mcp((response) => json(response, 200, { hello: "world" })));
  assert.deepEqual(notMcp.facts, { errorClass: "protocol_error", status: 200 });
  const noList = await factsFrom(mcp(agreed("2025-06-18"), (response) => json(response, 200, { jsonrpc: "2.0", id: 2, result: { items: [] } })));
  assert.deepEqual(noList.result, { outcome: "not-usable", detail: "tools/list returned no list of tools" });
  assert.equal(noList.facts.errorClass, "protocol_error");
  // This client never follows a redirect. The server did answer, so the letter is not-usable, matching the class.
  const moved = await factsFrom(mcp((response) => { response.writeHead(302, { Location: "https://127.0.0.1/elsewhere" }).end(); }));
  assert.deepEqual(moved.result, { outcome: "not-usable", detail: "the server answered with a redirect" });
  assert.equal(moved.facts.errorClass, "protocol_error");
});
