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

export async function listTools(url: string, { fetchImpl = fetch, timeoutMs = 15_000, maxPages = 50, bearerToken }: ListToolsOptions = {}): Promise<ListToolsResult> {
  let sessionId: string | null = null;
  let received = 0;
  let initialized = false;
  if (bearerToken !== undefined && !/^https:\/\//i.test(url)) return { outcome: "not-usable", detail: "a token is only sent over https" };

  async function send(body: Record<string, unknown>): Promise<{ status: number; contentType: string; text: string }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": userAgent,
      "MCP-Protocol-Version": protocolVersion,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (bearerToken !== undefined) headers.Authorization = `Bearer ${bearerToken}`;
    const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    sessionId = response.headers.get("Mcp-Session-Id") ?? sessionId;
    const text = await readCapped(response, Math.min(maxBodyBytes, maxListBytes - received));
    received += text.length;
    return { status: response.status, contentType: response.headers.get("Content-Type") ?? "", text };
  }

  return listOver({
    async request(body) {
      const answer = await send(body);
      if (answer.status === 401 || answer.status === 403) throw new ListingStopped({ outcome: "sign-in-required", status: answer.status });
      if (!initialized && (answer.status < 200 || answer.status >= 300)) throw new ListingStopped({ outcome: "not-usable", detail: `initialize answered ${answer.status}` });
      initialized = true;
      return readRpcReply(answer.contentType, answer.text);
    },
    async notify(body) { await send(body); },
  }, maxPages);
}
