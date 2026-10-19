import { printable } from "./text.ts";

/**
 * The model APIs behaviour replay can drive, behind one small interface. Each adapter turns MCP
 * tool definitions into its API's tool format, sends a conversation, and reads back the text,
 * the tool calls and the tokens used. Requests go out with `fetch`; there is no SDK.
 *
 * Shapes, as checked in each provider's documentation on 19 Oct 2026:
 * - Anthropic Messages: `tools[]` of `{ name, description, input_schema }`; the reply's `content`
 *   holds `tool_use` blocks `{ id, name, input }`; results go back first in the next user message
 *   as `tool_result` blocks `{ tool_use_id, content }`.
 * - OpenAI-compatible Chat Completions: `tools[]` of `{ type: "function", function: { name,
 *   description, parameters } }`; `choices[0].message.tool_calls[]` of `{ id, function: { name,
 *   arguments } }` with the arguments as JSON text; each result goes back as a `role: "tool"`
 *   message with `tool_call_id`.
 * - Bedrock Converse: `toolConfig.tools[]` of `{ toolSpec: { name, description, inputSchema: {
 *   json } } }`; `output.message.content` holds `toolUse` blocks `{ toolUseId, name, input }`;
 *   results go back in a user message as `toolResult` blocks `{ toolUseId, content: [{ text }] }`.
 *   Signed in with a Bedrock API key sent as a bearer token.
 */
export type Provider = "anthropic" | "chat-completions" | "bedrock-converse";
export const providers: Provider[] = ["anthropic", "chat-completions", "bedrock-converse"];

/** Where each provider's key is read from when the settings name no other variable. */
export const defaultKeyVariable: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  "chat-completions": "OPENAI_API_KEY",
  "bedrock-converse": "AWS_BEARER_TOKEN_BEDROCK",
};

/** A tool as a model is given it: the parts of an MCP definition a client passes on. */
export interface ModelTool { name: string; description?: string; inputSchema: Record<string, unknown> }

export interface ModelCall {
  /** The provider's id for the call, used to match its result. */
  id: string;
  name: string;
  /** The arguments as parsed JSON, or the raw text when a provider sent text that is not JSON. */
  input: unknown;
  /** The arguments as text, for matching values in them. */
  inputText: string;
}

export type Turn =
  | { role: "user"; text: string }
  /** `raw` is the provider's own message, sent back unchanged so nothing in it is lost. */
  | { role: "assistant"; text: string; calls: ModelCall[]; raw?: unknown }
  | { role: "results"; results: Array<{ id: string; name: string; text: string }> };

export interface ModelReply {
  text: string;
  calls: ModelCall[];
  raw: unknown;
  usage: { input: number; output: number };
  stop: string;
}

export interface ModelAdapter {
  send(system: string, turns: Turn[], tools: ModelTool[]): Promise<ModelReply>;
}

export interface Inference { maxTokens?: number; temperature?: number; topP?: number }

export interface AdapterConfig {
  provider: Provider;
  model: string;
  /** Without one, the provider's own address. */
  baseUrl?: string;
  /** Bedrock's region, for its default address. */
  region?: string;
  /** Never printed, logged or stored. Absent only for a Chat Completions server on this machine. */
  apiKey?: string;
  inference: Inference;
  /** Extra request fields passed through unchanged. Bedrock receives them as `additionalModelRequestFields`. */
  providerFields: Record<string, unknown>;
  timeoutMs?: number;
}

/** A request that failed. `retryable` is true for rate limits and server errors. */
export class ModelError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryable: boolean, retryAfterMs?: number) { super(message); this.retryable = retryable; this.retryAfterMs = retryAfterMs; }
}

/** Tool names every supported API accepts. Others are refused, not renamed: a renamed tool is a different tool to the model. */
export const sendableName = /^[A-Za-z0-9_-]{1,64}$/;

const largestReply = 8_000_000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const objectSchema = (schema: Record<string, unknown>) => (schema.type === "object" ? schema : { type: "object", properties: {} });
const nonEmpty = (text: string) => (text.trim() ? text : "(no content)");

function callFromJsonText(id: string, name: string, text: string): ModelCall {
  try { return { id, name, input: JSON.parse(text) as unknown, inputText: text }; } catch { return { id, name, input: text, inputText: text }; }
}

/** Posts JSON and reads JSON back. An error says only the status and the provider's short message, with the key taken out. */
async function post(config: AdapterConfig, fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const hide = (text: string) => (config.apiKey ? text.split(config.apiKey).join("[key]") : text);
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(config.timeoutMs ?? 120_000) });
  } catch (error) {
    throw new ModelError(`the request to the model API failed (${hide(printable(error instanceof Error ? error.message : "no reason given", 160))})`, true);
  }
  const text = await response.text();
  if (text.length > largestReply) throw new ModelError("the model API's reply was larger than a reply should be", false);
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* reported below */ }
  if (!response.ok) {
    const said = isRecord(parsed) ? (isRecord(parsed.error) ? parsed.error.message : parsed.message ?? parsed.Message) : undefined;
    const why = typeof said === "string" ? `: ${hide(printable(said, 200))}` : "";
    const retryAfter = Number(response.headers.get("retry-after"));
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new ModelError(`the model API answered HTTP ${response.status}${why}`, retryable, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  if (!isRecord(parsed)) throw new ModelError("the model API's reply was not a JSON object", false);
  return parsed;
}

const numberOr0 = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const withoutSlash = (url: string) => url.replace(/\/+$/, "");

function anthropic(config: AdapterConfig, fetchImpl: typeof fetch): ModelAdapter {
  const url = `${withoutSlash(config.baseUrl ?? "https://api.anthropic.com")}/v1/messages`;
  return {
    async send(system, turns, tools) {
      const messages = turns.map((turn) => {
        if (turn.role === "user") return { role: "user", content: turn.text };
        if (turn.role === "assistant") return { role: "assistant", content: Array.isArray(turn.raw) ? turn.raw : turn.text };
        return { role: "user", content: turn.results.map((result) => ({ type: "tool_result", tool_use_id: result.id, content: nonEmpty(result.text) })) };
      });
      const body = {
        model: config.model,
        max_tokens: config.inference.maxTokens ?? 1024,
        ...(system ? { system } : {}),
        messages,
        tools: tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), input_schema: objectSchema(tool.inputSchema) })),
        ...(config.inference.temperature !== undefined ? { temperature: config.inference.temperature } : {}),
        ...(config.inference.topP !== undefined ? { top_p: config.inference.topP } : {}),
        ...config.providerFields,
      };
      const reply = await post(config, fetchImpl, url, { "x-api-key": config.apiKey ?? "", "anthropic-version": "2023-06-01" }, body);
      const content = Array.isArray(reply.content) ? reply.content.filter(isRecord) : [];
      const usage = isRecord(reply.usage) ? reply.usage : {};
      return {
        text: content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("\n"),
        calls: content.filter((block) => block.type === "tool_use").map((block) => ({ id: String(block.id ?? ""), name: String(block.name ?? ""), input: block.input ?? {}, inputText: JSON.stringify(block.input ?? {}) })),
        raw: content,
        usage: { input: numberOr0(usage.input_tokens) + numberOr0(usage.cache_creation_input_tokens) + numberOr0(usage.cache_read_input_tokens), output: numberOr0(usage.output_tokens) },
        stop: String(reply.stop_reason ?? ""),
      };
    },
  };
}

function chatCompletions(config: AdapterConfig, fetchImpl: typeof fetch): ModelAdapter {
  const url = `${withoutSlash(config.baseUrl ?? "https://api.openai.com/v1")}/chat/completions`;
  return {
    async send(system, turns, tools) {
      const messages: unknown[] = system ? [{ role: "system", content: system }] : [];
      for (const turn of turns) {
        if (turn.role === "user") messages.push({ role: "user", content: turn.text });
        else if (turn.role === "assistant") {
          // Only the fields every compatible server knows: some reject the extras others add.
          const raw = isRecord(turn.raw) ? turn.raw : {};
          messages.push({ role: "assistant", content: typeof raw.content === "string" ? raw.content : turn.text || null, ...(Array.isArray(raw.tool_calls) && raw.tool_calls.length ? { tool_calls: raw.tool_calls } : {}) });
        } else for (const result of turn.results) messages.push({ role: "tool", tool_call_id: result.id, content: nonEmpty(result.text) });
      }
      const body = {
        model: config.model,
        messages,
        tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: objectSchema(tool.inputSchema) } })),
        ...(config.inference.maxTokens !== undefined ? { max_tokens: config.inference.maxTokens } : {}),
        ...(config.inference.temperature !== undefined ? { temperature: config.inference.temperature } : {}),
        ...(config.inference.topP !== undefined ? { top_p: config.inference.topP } : {}),
        ...config.providerFields,
      };
      const reply = await post(config, fetchImpl, url, config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}, body);
      const choice = Array.isArray(reply.choices) && isRecord(reply.choices[0]) ? reply.choices[0] : {};
      const message = isRecord(choice.message) ? choice.message : {};
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
      const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter(isRecord).map((part) => (typeof part.text === "string" ? part.text : "")).join("\n") : "";
      const usage = isRecord(reply.usage) ? reply.usage : {};
      return {
        text: content,
        calls: toolCalls.map((call) => {
          const fn = isRecord(call.function) ? call.function : {};
          return callFromJsonText(String(call.id ?? ""), String(fn.name ?? ""), typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}));
        }),
        raw: { content: message.content ?? null, tool_calls: toolCalls },
        usage: { input: numberOr0(usage.prompt_tokens), output: numberOr0(usage.completion_tokens) },
        stop: String(choice.finish_reason ?? ""),
      };
    },
  };
}

function bedrockConverse(config: AdapterConfig, fetchImpl: typeof fetch): ModelAdapter {
  const base = withoutSlash(config.baseUrl ?? `https://bedrock-runtime.${config.region ?? ""}.amazonaws.com`);
  const url = `${base}/model/${encodeURIComponent(config.model)}/converse`;
  return {
    async send(system, turns, tools) {
      const messages = turns.map((turn) => {
        if (turn.role === "user") return { role: "user", content: [{ text: nonEmpty(turn.text) }] };
        if (turn.role === "assistant") return isRecord(turn.raw) ? turn.raw : { role: "assistant", content: [{ text: nonEmpty(turn.text) }] };
        return { role: "user", content: turn.results.map((result) => ({ toolResult: { toolUseId: result.id, content: [{ text: nonEmpty(result.text) }] } })) };
      });
      const inferenceConfig = {
        ...(config.inference.maxTokens !== undefined ? { maxTokens: config.inference.maxTokens } : {}),
        ...(config.inference.temperature !== undefined ? { temperature: config.inference.temperature } : {}),
        ...(config.inference.topP !== undefined ? { topP: config.inference.topP } : {}),
      };
      const body = {
        messages,
        ...(system ? { system: [{ text: system }] } : {}),
        toolConfig: { tools: tools.map((tool) => ({ toolSpec: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: { json: objectSchema(tool.inputSchema) } } })) },
        ...(Object.keys(inferenceConfig).length ? { inferenceConfig } : {}),
        ...(Object.keys(config.providerFields).length ? { additionalModelRequestFields: config.providerFields } : {}),
      };
      const reply = await post(config, fetchImpl, url, { authorization: `Bearer ${config.apiKey ?? ""}` }, body);
      const message = isRecord(reply.output) && isRecord(reply.output.message) ? reply.output.message : {};
      const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
      const usage = isRecord(reply.usage) ? reply.usage : {};
      return {
        text: content.filter((block) => typeof block.text === "string").map((block) => block.text as string).join("\n"),
        calls: content.filter((block) => isRecord(block.toolUse)).map((block) => {
          const use = block.toolUse as Record<string, unknown>;
          return { id: String(use.toolUseId ?? ""), name: String(use.name ?? ""), input: use.input ?? {}, inputText: JSON.stringify(use.input ?? {}) };
        }),
        raw: { role: "assistant", content },
        usage: { input: numberOr0(usage.inputTokens), output: numberOr0(usage.outputTokens) },
        stop: String(reply.stopReason ?? ""),
      };
    },
  };
}

export function makeAdapter(config: AdapterConfig, fetchImpl: typeof fetch = fetch): ModelAdapter {
  if (config.provider === "anthropic") return anthropic(config, fetchImpl);
  if (config.provider === "chat-completions") return chatCompletions(config, fetchImpl);
  return bedrockConverse(config, fetchImpl);
}
