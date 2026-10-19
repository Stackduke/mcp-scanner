import { ModelError } from "./models.ts";
import type { ModelAdapter, ModelCall, ModelTool, Turn } from "./models.ts";
import type { ReplayCase, ReplaySettings } from "./replay-cases.ts";
import { canonical } from "./snapshot.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * Behaviour replay's loop. Each case runs through the model several times with one side's tool
 * definitions. No tool is ever called: each call the model makes is answered with the case's
 * canned output, and the run goes on until the model answers without a call or runs out of steps.
 */
export type Side = "before" | "after";

export interface RecordedCall {
  tool: string;
  input: unknown;
  inputText: string;
  /** Which model turn made the call, from 1. */
  step: number;
  /** False when the case had no canned output for the call. */
  scripted: boolean;
  /** False when the side's tool list has no tool of that name. */
  known: boolean;
}

export interface RunRecord {
  case: string;
  side: Side;
  index: number;
  calls: RecordedCall[];
  /** The text of the model's last reply. */
  answer: string;
  steps: number;
  outOfSteps: boolean;
  /** Every tool output the model was given in this run, and the model turn that asked for it. */
  received: Array<{ tool: string; text: string; step: number }>;
  usage: { input: number; output: number };
}

export interface ReplayJob {
  adapter: ModelAdapter;
  settings: Pick<ReplaySettings, "runsPerSide" | "maxSteps" | "concurrency"> & { maxModelCalls: number };
  systemPrompt: string;
  cases: ReplayCase[];
  tools: Record<Side, ToolDefinition[]>;
  /** Waits between retries. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  onRunDone?: (done: number, total: number) => void;
}

export interface ReplayResult {
  runs: RunRecord[];
  modelCalls: number;
}

/** The job stopped before it finished: a model API error that retrying did not cure, or the call cap. */
export class ReplayStopped extends Error {}

const noOutput = "No result.";
const noSuchTool = "No such tool.";
const attempts = 3;

export const toModelTools = (tools: ToolDefinition[]): ModelTool[] =>
  tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: typeof tool.inputSchema === "object" && tool.inputSchema !== null && !Array.isArray(tool.inputSchema) ? (tool.inputSchema as Record<string, unknown>) : { type: "object", properties: {} } }));

const outputText = (output: unknown) => (typeof output === "string" ? output : JSON.stringify(output, null, 2));

/** The canned output for one call, or null when the case has none for it. */
export function cannedOutput(replayCase: ReplayCase, call: { name: string; input: unknown }): string | null {
  if (!Object.hasOwn(replayCase.outputs, call.name)) return null;
  const outputs = replayCase.outputs[call.name] as ReplayCase["outputs"][string];
  const args = typeof call.input === "object" && call.input !== null && !Array.isArray(call.input) ? (call.input as Record<string, unknown>) : {};
  const match = outputs.matches.find((entry) => Object.entries(entry.when).every(([key, value]) => key in args && canonical(args[key]) === canonical(value)));
  if (match) return outputText(match.output);
  return "default" in outputs ? outputText(outputs.default) : null;
}

export async function runReplay(job: ReplayJob): Promise<ReplayResult> {
  const sleep = job.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const modelTools: Record<Side, ModelTool[]> = { before: toModelTools(job.tools.before), after: toModelTools(job.tools.after) };
  const names: Record<Side, Set<string>> = { before: new Set(job.tools.before.map((tool) => tool.name)), after: new Set(job.tools.after.map((tool) => tool.name)) };
  const tasks: Array<{ replayCase: ReplayCase; side: Side; index: number }> = [];
  for (const replayCase of job.cases) for (const side of ["before", "after"] as const) for (let index = 0; index < job.settings.runsPerSide; index += 1) tasks.push({ replayCase, side, index });

  let modelCalls = 0;
  let stopped: Error | null = null;
  const runs: RunRecord[] = [];

  async function ask(system: string, turns: Turn[], tools: ModelTool[]) {
    for (let attempt = 1; ; attempt += 1) {
      if (stopped) throw stopped;
      if (modelCalls >= job.settings.maxModelCalls) throw new ReplayStopped(`the job reached its cap of ${job.settings.maxModelCalls} model calls before it finished`);
      modelCalls += 1;
      try {
        return await job.adapter.send(system, turns, tools);
      } catch (error) {
        if (!(error instanceof ModelError) || !error.retryable || attempt >= attempts) throw new ReplayStopped(error instanceof Error ? error.message : "the model API failed");
        await sleep(Math.min(error.retryAfterMs ?? 1000 * 2 ** (attempt - 1), 30_000));
      }
    }
  }

  async function runOne({ replayCase, side, index }: (typeof tasks)[number]): Promise<RunRecord> {
    const system = replayCase.system ?? job.systemPrompt;
    const turns: Turn[] = [...replayCase.history.map((turn): Turn => (turn.role === "user" ? { role: "user", text: turn.text } : { role: "assistant", text: turn.text, calls: [] })), { role: "user", text: replayCase.user }];
    const record: RunRecord = { case: replayCase.name, side, index, calls: [], answer: "", steps: 0, outOfSteps: false, received: [], usage: { input: 0, output: 0 } };
    for (;;) {
      if (record.steps >= job.settings.maxSteps) { record.outOfSteps = true; break; }
      const reply = await ask(system, turns, modelTools[side]);
      record.steps += 1;
      record.usage.input += reply.usage.input;
      record.usage.output += reply.usage.output;
      record.answer = reply.text;
      if (!reply.calls.length) break;
      turns.push({ role: "assistant", text: reply.text, calls: reply.calls, raw: reply.raw });
      const results = reply.calls.map((call: ModelCall) => {
        const known = names[side].has(call.name);
        const canned = known ? cannedOutput(replayCase, call) : null;
        record.calls.push({ tool: call.name, input: call.input, inputText: call.inputText, step: record.steps, scripted: canned !== null, known });
        const text = !known ? noSuchTool : canned ?? noOutput;
        record.received.push({ tool: call.name, text, step: record.steps });
        return { id: call.id, name: call.name, text };
      });
      turns.push({ role: "results", results });
    }
    return record;
  }

  let next = 0;
  let done = 0;
  async function worker() {
    while (!stopped && next < tasks.length) {
      const task = tasks[next++] as (typeof tasks)[number];
      try {
        runs.push(await runOne(task));
        job.onRunDone?.(++done, tasks.length);
      } catch (error) {
        stopped ??= error instanceof Error ? error : new ReplayStopped("the run failed");
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(job.settings.concurrency, tasks.length) }, worker));
  if (stopped) throw stopped;
  const order = new Map(job.cases.map((replayCase, position) => [replayCase.name, position]));
  runs.sort((a, b) => (order.get(a.case) ?? 0) - (order.get(b.case) ?? 0) || (a.side === b.side ? 0 : a.side === "before" ? -1 : 1) || a.index - b.index);
  return { runs, modelCalls };
}
