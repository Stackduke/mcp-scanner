import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ListingStopped, ReplyTooLarge, listOver } from "./client.ts";
import type { ListToolsResult, RpcMessage } from "./client.ts";

/**
 * Lists the tools of an MCP server that runs as a local program: start the command, speak MCP
 * over its standard input and output (one JSON-RPC message per line), ask for the tool list,
 * and stop the program. It never calls a tool.
 *
 * This runs whatever command it is given, with this process's environment, so it is for a
 * server the person running the check already trusts to run, such as their own in their own CI.
 * The tracker never uses it.
 *
 * What the program writes is untrusted. Lines on standard output that are not JSON-RPC are
 * skipped. Standard error is kept only as a short tail, for the caller to show, made printable,
 * when the listing fails.
 */
export interface StdioOptions {
  /** How long to wait for each reply. The first one includes the program starting up. */
  timeoutMs?: number;
  maxPages?: number;
  /** The program's environment. Defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type StdioResult = ListToolsResult & { stderrTail?: string };

const maxLineBytes = 4_000_000;
const maxTotalBytes = 8_000_000;
const stderrKept = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Stops the program and anything it started. It was started in a group of its own for this. */
function stop(child: ChildProcessWithoutNullStreams): void {
  child.stdin.end();
  // The group is signalled even when the program itself has ended, since what it started may not have.
  if (child.pid === undefined) return;
  const signal = (name: NodeJS.Signals) => { try { if (process.platform === "win32") child.kill(name); else process.kill(-(child.pid as number), name); } catch { /* already gone */ } };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 2_000).unref();
}

export async function listToolsStdio(command: string[], { timeoutMs = 60_000, maxPages = 50, env = process.env, cwd }: StdioOptions = {}): Promise<StdioResult> {
  const [program, ...args] = command;
  if (!program) return { outcome: "not-usable", detail: "no command was given" };

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], env, ...(cwd ? { cwd } : {}), detached: process.platform !== "win32", windowsHide: true });
  } catch (error) {
    return { outcome: "unreachable", detail: `the program could not be started (${error instanceof Error ? error.name : "unknown"})` };
  }

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-stderrKept); });

  // Replies by request id. Anything else the program sends is skipped, or refused if it is a request.
  const waiting = new Map<number, { resolve: (reply: RpcMessage) => void; reject: (error: Error) => void }>();
  let ended: Error | null = null;
  const endAll = (error: Error) => {
    if (ended) return;
    ended = error;
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  };

  let buffer = Buffer.alloc(0), total = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    total += chunk.byteLength;
    if (total > maxTotalBytes) { endAll(new ReplyTooLarge()); stop(child); return; }
    buffer = Buffer.concat([buffer, chunk]);
    for (let newline = buffer.indexOf(10); newline !== -1; newline = buffer.indexOf(10)) {
      const line = buffer.subarray(0, newline).toString("utf8").trim();
      buffer = buffer.subarray(newline + 1);
      if (line) receive(line);
    }
    if (buffer.byteLength > maxLineBytes) { endAll(new ReplyTooLarge()); stop(child); }
  });

  // A last message without its newline is still read when the program closes its output.
  child.stdout.on("end", () => { const line = buffer.toString("utf8").trim(); buffer = Buffer.alloc(0); if (line) receive(line); });

  function receive(line: string) {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (!isRecord(message)) return;
    const id = message.id;
    // A request from the program. This client offers no capabilities, so it answers that it has none.
    if (typeof message.method === "string") {
      if (typeof id === "string" || typeof id === "number") write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (typeof id !== "number" || !(isRecord(message.result) || isRecord(message.error))) return;
    const pending = waiting.get(id);
    if (!pending) return;
    waiting.delete(id);
    pending.resolve(message as RpcMessage);
  }

  function write(message: Record<string, unknown>) {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  child.stdin.on("error", () => undefined);
  child.on("error", (error: NodeJS.ErrnoException) => endAll(new ListingStopped({ outcome: "unreachable", detail: `the program could not be started (${error.code ?? error.name})` })));
  // "close" comes after the program's output has all been read, so a last reply is not lost.
  child.on("close", (code, signal) => endAll(new ListingStopped({ outcome: "unreachable", detail: `the program ended before it answered (${signal ? `signal ${signal}` : `exit code ${code}`})` })));

  const result = await listOver({
    request(body) {
      if (ended) return Promise.reject(ended);
      const id = body.id as number;
      return new Promise<RpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new ListingStopped({ outcome: "unreachable", detail: `no reply within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${timeoutMs} ms`}` })); }, timeoutMs);
        waiting.set(id, { resolve: (reply) => { clearTimeout(timer); resolve(reply); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        write(body);
      });
    },
    async notify(body) { if (!ended) write(body); },
  }, maxPages);

  stop(child);
  return result.outcome === "listed" || !stderr.trim() ? result : { ...result, stderrTail: stderr };
}

/**
 * What the program's environment leaves out. In CI these let a program write into later steps
 * (GitHub's workflow command files, through which it could set variables or a PATH for the step
 * that holds a token, or write into the job summary) or act as the pipeline itself (its tokens).
 * A server has no need of them to list its tools. This narrows what a program can reach; it is
 * not a sandbox, since the program still runs as the same user on the same machine.
 */
const withheld = new Set([
  "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STATE", "GITHUB_STEP_SUMMARY", "GITHUB_TOKEN", "GH_TOKEN",
  "ACTIONS_RUNTIME_TOKEN", "ACTIONS_RUNTIME_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_CACHE_URL", "ACTIONS_RESULTS_URL",
  "CI_JOB_TOKEN", "CI_JOB_JWT", "CI_JOB_JWT_V1", "CI_JOB_JWT_V2", "CI_REGISTRY_PASSWORD", "CI_DEPLOY_PASSWORD",
]);

export function programEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !withheld.has(name.toUpperCase())));
}

/**
 * Splits a command written as one line into a program and its arguments, the way a shell would
 * for plain words and quotes. Nothing else a shell does happens here: no variables, globs,
 * pipes or redirection. Returns null when a quote is left open.
 */
export function splitCommand(line: string): string[] | null {
  const parts: string[] = [];
  let current = "", inWord = false, quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    if (quote === "'") { if (character === "'") quote = null; else current += character; continue; }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "\\" && ['"', "\\", "$", "`"].includes(line[index + 1] ?? "")) { current += line[index + 1]; index += 1; }
      else current += character;
      continue;
    }
    if (/\s/.test(character)) { if (inWord) { parts.push(current); current = ""; inWord = false; } continue; }
    inWord = true;
    if (character === "'" || character === '"') quote = character;
    else if (character === "\\" && index + 1 < line.length) { current += line[index + 1]; index += 1; }
    else current += character;
  }
  if (quote) return null;
  if (inWord) parts.push(current);
  return parts;
}
