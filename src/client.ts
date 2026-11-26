import type { ToolDefinition } from "./types.ts";

/**
 * The smallest MCP client that can answer one question: what tools does this server offer?
 *
 * It speaks the Streamable HTTP transport, performs the handshake and asks for the tool list.
 * It never calls a tool and treats everything it receives as data. It sends a credential only
 * when the caller hands it one, only over https, and only to the address it was given.
 */
export type ListToolsResult =
  | { outcome: "listed"; server: { name?: string; version?: string }; tools: ToolDefinition[] }
  /** The server wants a login before it will say anything, or refused the one it was sent (401 or 403). */
  | { outcome: "sign-in-required"; status: number }
  /** An answer arrived, but not one this client can use. */
  | { outcome: "not-usable"; detail: string }
  /** No answer: DNS, connection, TLS or timeout. */
  | { outcome: "unreachable"; detail: string };

/**
 * Why a listing ended as it did, in the scanner's own terms, so a failed check can be told apart from another:
 * a login wall from a firewall's 403, a timeout from a server's own error.
 */
export type ErrorClass = "ok" | "timeout" | "dns" | "tls" | "connect" | "http_4xx_auth" | "http_4xx_other" | "http_5xx" | "protocol_error" | "invalid_json";

/** What one listing found out besides its result. Nothing in it is the server's own text, except a protocol version cut to identifier characters. */
export interface ListingFacts {
  errorClass: ErrorClass;
  /** The last HTTP status the server answered with. None when no answer came. */
  status?: number;
  /** The protocol version the server agreed to in its answer to initialize. */
  protocolVersion?: string;
  /** The failure says itself it may clear up: a name server that could not answer yet (EAI_AGAIN). Not kept. */
  temporary?: true;
}

export interface ListToolsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Stop after this many pages of tools, so a misbehaving server cannot hold the scan open. */
  maxPages?: number;
  /** Sent as `Authorization: Bearer`. The list that comes back is what this token is allowed to see. */
  bearerToken?: string;
}

const protocolVersion = "2025-06-18";
export const userAgent = "stackduke-mcp-scanner/0.2 (+https://stackduke.com/tracker)";
const maxBodyBytes = 4_000_000;
/** Across every page of one list. Far more than any real server sends. */
const maxListBytes = 8_000_000;
const maxTools = 2_000;
const longestName = 256;

export class ReplyTooLarge extends Error {}

/** Reads a reply a piece at a time and stops at the limit, so a huge or endless body cannot fill memory. */
export async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    received += value.byteLength;
    if (received > limit) { await reader.cancel().catch(() => undefined); throw new ReplyTooLarge(); }
    text += decoder.decode(value, { stream: true });
  }
}

export interface RpcMessage { result?: Record<string, unknown>; error?: { code?: number; message?: string } }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON-RPC reply inside a plain JSON body or a server-sent event stream. */
export function readRpcReply(contentType: string, body: string): RpcMessage | null {
  const candidates: string[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
  } else {
    candidates.push(body);
  }
  for (const text of candidates) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && (isRecord(parsed.result) || isRecord(parsed.error))) return parsed as RpcMessage;
    } catch { /* not this one */ }
  }
  return null;
}

/** Keeps only what the protocol defines for a tool, and only when it has the right shape. */
export function readTool(value: unknown): ToolDefinition | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name) return null;
  const tool: ToolDefinition = { name: value.name };
  if (typeof value.title === "string") tool.title = value.title;
  if (typeof value.description === "string") tool.description = value.description;
  if (value.inputSchema !== undefined) tool.inputSchema = value.inputSchema;
  if (value.outputSchema !== undefined) tool.outputSchema = value.outputSchema;
  if (isRecord(value.annotations)) tool.annotations = value.annotations;
  return tool;
}

/** Ends a listing early with this result. A transport throws it when it already knows the answer, such as a 401. */
export class ListingStopped extends Error {
  readonly result: ListToolsResult;
  constructor(result: ListToolsResult) { super(result.outcome); this.result = result; }
}

/** One way of reaching a server: send a request and read its reply, or send a notification. */
export interface Transport {
  request(body: Record<string, unknown>): Promise<RpcMessage | null>;
  notify(body: Record<string, unknown>): Promise<void>;
}

/**
 * The handshake, then every page of `tools/list`, over any transport. The limits are the same
 * whichever way the server is reached, so a list read over stdio is held to what one read over
 * HTTP is.
 */
export async function listOver(transport: Transport, maxPages = 50): Promise<ListToolsResult> {
  try {
    const initialized = await transport.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "stackduke-mcp-scanner", version: "0.2" } } });
    if (!initialized?.result) return { outcome: "not-usable", detail: "initialize returned no result" };
    const info = isRecord(initialized.result.serverInfo) ? initialized.result.serverInfo : {};
    const server = { ...(typeof info.name === "string" ? { name: info.name } : {}), ...(typeof info.version === "string" ? { version: info.version } : {}) };

    // The protocol asks for this notification before any request. Servers that do not need it ignore it.
    await transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);

    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const reply = await transport.request({ jsonrpc: "2.0", id: 2 + page, method: "tools/list", ...(cursor ? { params: { cursor } } : {}) });
      if (!reply?.result) return { outcome: "not-usable", detail: reply?.error?.message ? "tools/list was refused" : "tools/list returned no result" };
      if (!Array.isArray(reply.result.tools)) return { outcome: "not-usable", detail: "tools/list returned no list of tools" };
      for (const item of reply.result.tools) { const tool = readTool(item); if (tool) tools.push(tool); }
      // Past these, a list is not one a client could use, and keeping it would only cost the scan.
      if (tools.length > maxTools) return { outcome: "not-usable", detail: `more than ${maxTools} tools` };
      if (tools.some((tool) => tool.name.length > longestName)) return { outcome: "not-usable", detail: "a tool name longer than any client accepts" };
      cursor = typeof reply.result.nextCursor === "string" && reply.result.nextCursor ? reply.result.nextCursor : undefined;
      if (!cursor) return { outcome: "listed", server, tools };
    }
    // A list cut short would make the missing tools look removed in the next comparison.
    return { outcome: "not-usable", detail: `the tool list did not end after ${maxPages} pages` };
  } catch (error) {
    if (error instanceof ListingStopped) return error.result;
    if (error instanceof ReplyTooLarge) return { outcome: "not-usable", detail: "a reply was larger than this scanner accepts" };
    return { outcome: "unreachable", detail: error instanceof Error ? error.name : "unknown" };
  }
}

/** The error class of a request that got no usable answer, from the error fetch threw (or the timeout that cut it). */
const errorCode = (error: unknown): string => {
  const cause = error instanceof Error && isRecord(error.cause) ? error.cause : {};
  return String(cause.code ?? (isRecord(error) ? error.code : "") ?? "");
};

/** A refused redirect: fetch throws it, but the server did answer. */
const isRedirect = (error: unknown): boolean => error instanceof Error && isRecord(error.cause) && typeof error.cause.message === "string" && /redirect/i.test(error.cause.message);

export function errorClassOfError(error: unknown): ErrorClass {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  if (name === "TimeoutError") return "timeout";
  const code = errorCode(error);
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_NODATA|EAI_FAIL)$/.test(code)) return "dns";
  if (/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(code)) return "timeout";
  if (/CERT|TLS|SSL|^EPROTO$|^UNABLE_TO_VERIFY_LEAF_SIGNATURE$/.test(code)) return "tls";
  if (isRedirect(error)) return "protocol_error";
  // Only what fetch reports as a failed connection is one. Anything else is not the network's doing, and is not retried.
  if (/^(ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EPIPE|EADDRNOTAVAIL|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(code)) return "connect";
  if (error instanceof TypeError && /^fetch failed/.test(error.message)) return "connect";
  return "protocol_error";
}

/** The error class of a listing that ended in `result`, from what the last exchange looked like. */
export function errorClassOf(result: ListToolsResult, last: { status?: number; authenticate: boolean; json: boolean; error?: unknown }): ErrorClass {
  if (result.outcome === "listed") return "ok";
  // A 401 or 403 is a login wall only when it says how to log in; otherwise it may be a firewall or a bot wall.
  if (result.outcome === "sign-in-required") return last.authenticate ? "http_4xx_auth" : "http_4xx_other";
  if (result.outcome === "unreachable") return errorClassOfError(last.error);
  if (last.status !== undefined && last.status >= 500) return "http_5xx";
  if (last.status !== undefined && last.status >= 400) return "http_4xx_other";
  if (/returned no result$/.test(result.detail) && !last.json) return "invalid_json";
  return "protocol_error";
}

/** Whether a body holds JSON at all: the whole body, or one event of a stream. */
function holdsJson(contentType: string, body: string): boolean {
  const candidates = contentType.includes("text/event-stream") ? body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()) : [body];
  return candidates.some((text) => { try { JSON.parse(text); return true; } catch { return false; } });
}

const protocolVersionShape = /^[A-Za-z0-9._-]{1,32}$/;

export async function listTools(url: string, options: ListToolsOptions = {}): Promise<ListToolsResult> {
  return (await listToolsWithFacts(url, options)).result;
}

/** `listTools`, with what the listing found out besides its result: why it ended so, the last status, the protocol version agreed. */
export async function listToolsWithFacts(url: string, { fetchImpl = fetch, timeoutMs = 15_000, maxPages = 50, bearerToken }: ListToolsOptions = {}): Promise<{ result: ListToolsResult; facts: ListingFacts }> {
  const last: { status?: number; authenticate: boolean; json: boolean; error?: unknown } = { authenticate: false, json: true };
  let agreedVersion: string | undefined;
  const withFacts = (result: ListToolsResult) => ({ result, facts: { errorClass: errorClassOf(result, last), ...(last.status !== undefined ? { status: last.status } : {}), ...(agreedVersion ? { protocolVersion: agreedVersion } : {}), ...(result.outcome === "unreachable" && errorCode(last.error) === "EAI_AGAIN" ? { temporary: true as const } : {}) } });
  let sessionId: string | null = null;
  let received = 0;
  let initialized = false;
  if (bearerToken !== undefined && !/^https:\/\//i.test(url)) return withFacts({ outcome: "not-usable", detail: "a token is only sent over https" });

  async function send(body: Record<string, unknown>): Promise<{ status: number; contentType: string; text: string }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": userAgent,
      "MCP-Protocol-Version": protocolVersion,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (bearerToken !== undefined) headers.Authorization = `Bearer ${bearerToken}`;
    try {
      const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      last.status = response.status;
      last.authenticate = Boolean(response.headers.get("WWW-Authenticate")?.trim());
      sessionId = response.headers.get("Mcp-Session-Id") ?? sessionId;
      const text = await readCapped(response, Math.min(maxBodyBytes, maxListBytes - received));
      received += text.length;
      return { status: response.status, contentType: response.headers.get("Content-Type") ?? "", text };
    } catch (error) {
      last.error = error;
      // The server answered, with a redirect this client will not follow: an answer it cannot use, not no answer.
      if (isRedirect(error)) throw new ListingStopped({ outcome: "not-usable", detail: "the server answered with a redirect" });
      throw error;
    }
  }

  return withFacts(await listOver({
    async request(body) {
      const answer = await send(body);
      if (answer.status === 401 || answer.status === 403) throw new ListingStopped({ outcome: "sign-in-required", status: answer.status });
      if (!initialized && (answer.status < 200 || answer.status >= 300)) throw new ListingStopped({ outcome: "not-usable", detail: `initialize answered ${answer.status}` });
      initialized = true;
      const reply = readRpcReply(answer.contentType, answer.text);
      last.json = reply !== null || holdsJson(answer.contentType, answer.text);
      const agreed = body.method === "initialize" ? reply?.result?.protocolVersion : undefined;
      if (typeof agreed === "string" && protocolVersionShape.test(agreed)) agreedVersion = agreed;
      return reply;
    },
    // A notification's answer says nothing about the listing, so it leaves the last exchange as it was.
    async notify(body) { const { status, authenticate } = last; await send(body); Object.assign(last, { status, authenticate }); },
  }, maxPages));
}
