import { MAX_BODY_BYTES, PROTOCOL_VERSIONS, SERVER_TITLE } from "./config.ts";
import type { AssetFetcher } from "./data.ts";
import { handleRpc } from "./mcp.ts";
import type { QueueStore } from "./queue.ts";

/**
 * A read-only MCP server (Streamable HTTP, JSON answers only) that answers from the tracker data
 * deployed with it. Routes: POST /mcp, GET /health, GET /. Everything else is 404, and the data
 * files are reachable only through the ASSETS binding (`run_worker_first` in wrangler.jsonc).
 */

export interface Env {
  ASSETS: AssetFetcher;
  /** The crawl queue (KV). Without it, unknown addresses are answered but not queued. */
  CRAWL_QUEUE?: QueueStore;
  /** Workers rate limiting. Without them (unit tests), there is no limit. */
  RATE_LIMITER?: RateLimiter;
  /** A tighter limit on adding addresses to the crawl queue. */
  QUEUE_LIMITER?: RateLimiter;
}

interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id",
};

/**
 * The client's name travels in the session id this server hands out at initialize
 * (`<name>~<random>`), so each tool call can be logged with it without storing anything.
 * The session id is not secret and grants nothing: every request is answered the same way.
 */
const CLIENT_NAME = /^[A-Za-z0-9._-]{1,40}$/;
export function clientFromSession(sessionId: string | null): string {
  if (!sessionId) return "unknown";
  const name = sessionId.slice(0, Math.max(0, sessionId.lastIndexOf("~")));
  return CLIENT_NAME.test(name) ? name : "unknown";
}
function sessionFor(clientName: string | undefined): string {
  const name = clientName?.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${name && CLIENT_NAME.test(name) ? name : "unknown"}~${crypto.randomUUID()}`;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

/** Reads at most `max` bytes of a body; null if it is longer. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
    if (url.pathname === "/" && request.method === "GET") {
      return json({ name: SERVER_TITLE, mcp_endpoint: "/mcp", transport: "streamable-http", about: "A read-only MCP server that answers from a public MCP tool tracker's published data." });
    }
    if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    // GET would open an event stream and DELETE would end a session; this stateless server offers neither.
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS", ...CORS_HEADERS });

    // The caller's address is the rate limiters' key, used only for counting inside Cloudflare; it is not logged.
    const caller = request.headers.get("cf-connecting-ip") || "unknown";
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: caller });
      if (!success) return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many requests. Try again in a minute." } }, 429, { "retry-after": "60", ...CORS_HEADERS });
    }

    const protocolVersion = request.headers.get("mcp-protocol-version");
    if (protocolVersion && !(PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) return json({ error: "unsupported_protocol_version", supported: PROTOCOL_VERSIONS }, 400, CORS_HEADERS);
    if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return json({ error: "unsupported_media_type", expected: "application/json" }, 415, CORS_HEADERS);

    const body = await readCapped(request.body, MAX_BODY_BYTES);
    if (body === null) return json({ error: "payload_too_large", max_bytes: MAX_BODY_BYTES }, 413, CORS_HEADERS);

    const queueLimiter = env.QUEUE_LIMITER;
    let reply;
    try {
      reply = await handleRpc(body, {
        assets: env.ASSETS,
        queue: env.CRAWL_QUEUE,
        queueAllowed: queueLimiter ? async () => (await queueLimiter.limit({ key: caller })).success : undefined,
        now: new Date(),
        client: clientFromSession(request.headers.get("mcp-session-id")),
        log: (line) => console.log(line),
      });
    } catch {
      // A fixed line only, so nothing from the request reaches the logs; caught, so the runtime does not log it either.
      console.error("lookup: internal error");
      return json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, 500, CORS_HEADERS);
    }
    const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff", ...CORS_HEADERS };
    if ("clientName" in reply) headers["mcp-session-id"] = sessionFor(reply.clientName);
    if (reply.body === null) return new Response(null, { status: reply.status, headers });
    headers["content-type"] = "application/json; charset=utf-8";
    return new Response(reply.body, { status: reply.status, headers });
  },
};
