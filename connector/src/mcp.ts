import { INSTRUCTIONS, LATEST_PROTOCOL_VERSION, MAX_RESULT_BYTES, PROTOCOL_VERSIONS, SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from "./config.ts";
import { DataUnavailable } from "./data.ts";
import type { AssetFetcher } from "./data.ts";
import type { QueueStore } from "./queue.ts";
import { isToolName, parseArguments, runTool, TOOLS } from "./tools.ts";

/**
 * JSON-RPC over one POST body: initialize, ping, tools/list and tools/call. Stateless, like
 * Stackduke Radar's handler this is adapted from: nothing is kept between requests except cached data.
 */

const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602;

export interface RpcContext {
  assets: AssetFetcher;
  queue?: QueueStore;
  queueAllowed?: () => Promise<boolean>;
  now: Date;
  /** The client's name, for the one log line each tool call writes. */
  client: string;
  log: (line: string) => void;
}

export interface RpcReply {
  status: number;
  body: string | null;
  /** For initialize: the client's name as the client gave it, to carry in the session id. */
  clientName?: string;
}

type Id = string | number;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function handleRpc(body: string, context: RpcContext): Promise<RpcReply> {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return errorReply(null, PARSE_ERROR, "Parse error: the body is not JSON", 400);
  }
  if (Array.isArray(message)) return errorReply(null, INVALID_REQUEST, "Batched JSON-RPC requests are not supported", 400);
  if (!isObject(message) || message.jsonrpc !== "2.0") return errorReply(null, INVALID_REQUEST, "Invalid Request: expected a JSON-RPC 2.0 message", 400);

  const method = typeof message.method === "string" ? message.method : null;
  const hasId = "id" in message && message.id !== undefined;
  if (method === null) {
    // A response from the client. This server sends no requests, so it is accepted and ignored.
    if (("result" in message || "error" in message) && hasId) return { status: 202, body: null };
    return errorReply(null, INVALID_REQUEST, "Invalid Request: no method", 400);
  }
  if (!hasId) return { status: 202, body: null };
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number") return errorReply(null, INVALID_REQUEST, "Invalid Request: id must be a string or number", 400);

  const params = message.params;
  switch (method) {
    case "initialize": {
      const requested = isObject(params) ? params.protocolVersion : undefined;
      const protocolVersion = (PROTOCOL_VERSIONS as readonly unknown[]).includes(requested) ? (requested as string) : LATEST_PROTOCOL_VERSION;
      const clientInfo = isObject(params) && isObject(params.clientInfo) ? params.clientInfo : {};
      const reply = resultReply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
      return { ...reply, clientName: typeof clientInfo.name === "string" ? clientInfo.name : undefined };
    }
    case "ping":
      return resultReply(id, {});
    case "tools/list":
      return resultReply(id, { tools: TOOLS });
    case "tools/call":
      return callTool(id, params, context);
    default:
      return errorReply(id, METHOD_NOT_FOUND, `Method not found: ${safeText(method)}`);
  }
}

async function callTool(id: Id, params: unknown, context: RpcContext): Promise<RpcReply> {
  if (!isObject(params) || typeof params.name !== "string") return errorReply(id, INVALID_PARAMS, "tools/call needs params.name");
  const tool = params.name;
  if (!isToolName(tool)) return errorReply(id, INVALID_PARAMS, `Unknown tool: ${safeText(tool)}. The tools are ${TOOLS.map((t) => t.name).join(" and ")}, and both only read published tracker data.`);

  // The only thing logged: which client called which tool, and when. Never the arguments.
  context.log(JSON.stringify({ event: "tool_call", client: context.client, tool, at: context.now.toISOString() }));

  // Bad arguments are a tool error, not a protocol error, so the model can read what was wrong and retry.
  const parsed = parseArguments(tool, params.arguments === undefined ? {} : params.arguments, context.now);
  if (typeof parsed === "string") return resultReply(id, toolError(`Invalid arguments for ${tool}: ${parsed}`));

  let outcome;
  try {
    outcome = await runTool(parsed, context);
  } catch (error) {
    if (!(error instanceof DataUnavailable)) throw error;
    return resultReply(id, toolError("The tracker data could not be read right now, so there is no answer. Try again in a few minutes."));
  }
  if (!outcome.ok) return resultReply(id, toolError(outcome.message));
  const text = JSON.stringify(outcome.answer);
  if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES) return resultReply(id, toolError("The answer is too large to return."));
  return resultReply(id, { content: [{ type: "text", text }], structuredContent: outcome.answer, isError: false });
}

/** Only echo method or tool names that look like identifiers. */
const safeText = (value: string) => (/^[A-Za-z0-9_./-]{1,64}$/.test(value) ? value : "(not shown)");
const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const resultReply = (id: Id, result: unknown): RpcReply => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id, result }) });
const errorReply = (id: Id | null, code: number, message: string, status = 200): RpcReply => ({ status, body: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) });
