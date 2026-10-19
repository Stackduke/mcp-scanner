import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { confined } from "./authority.ts";
import { listTools } from "./client.ts";
import { diffSnapshots } from "./diff.ts";
import { writeWhole } from "./files.ts";
import { readLockfile, writeLockfile } from "./lockfile.ts";
import { defaultKeyVariable, makeAdapter, sendableName } from "./models.ts";
import { runReplay } from "./replay.ts";
import { loadReplay, sha256 } from "./replay-cases.ts";
import { measure } from "./replay-measures.ts";
import { describeReplay } from "./replay-report.ts";
import { listToolsStdio, programEnvironment, splitCommand } from "./stdio.ts";
import { takeSnapshot } from "./snapshot.ts";
import { printable } from "./text.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * `replay`: run a team's cases through its model with the tools approved at a git ref and with
 * the tools the server lists now, and report how the agent's behaviour moved. A local command:
 * it writes the report to standard output, and to files when asked.
 *
 * Exit codes: 0 the report was written (or nothing changed, so nothing was replayed); 2 the
 * arguments, settings or cases are wrong; 3 the server asks for a sign-in; 4 the server could
 * not be listed, or the model API failed, or the job hit its cap of model calls.
 */
const isLoopback = (host: string) => host === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]";
// Keys for the model APIs are kept from the server's program, as the CI tokens already are.
const modelKeyVariables = Object.values(defaultKeyVariable);
const fieldWords: Record<string, string> = { title: "title", description: "description", inputSchema: "input schema", outputSchema: "output schema", annotations: "annotations" };

function gitShow(ref: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["show", `${ref}:./${file.split(path.sep).join("/")}`], { maxBuffer: 16_000_000 }, (error, stdout) => (error ? reject(new Error("git could not show it")) : resolve(stdout)));
  });
}

const definitionsHash = (tools: ToolDefinition[]) => sha256(writeLockfile(tools.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({ name, title, description, inputSchema, outputSchema, annotations }))));

async function scannerVersion(): Promise<string> {
  try { return String((JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version ?? "unknown"); } catch { return "unknown"; }
}

export async function replayCommand(rest: string[]): Promise<number> {
  const split = rest.indexOf("--");
  const before = split === -1 ? rest : rest.slice(0, split);
  let program = split === -1 ? [] : rest.slice(split + 1);
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (const item of before) {
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const match = /^--(settings|lockfile|before|summary|json|timeout|command)=(.*)$/s.exec(item);
    if (!match || options.has(match[1] as string)) { console.error(`replay does not take ${item.split("=")[0]}, or took it twice.`); return 2; }
    options.set(match[1] as string, match[2] as string);
  }
  if (options.has("command")) {
    const parts = splitCommand(options.get("command") as string);
    if (!parts?.[0]) { console.error("--command needs a program, with any quotes closed."); return 2; }
    if (program.length) { console.error("Give the program either after -- or with --command, not both."); return 2; }
    program = parts;
  }
  const url = positional[0];
  if (positional.length > 1 || (url && program.length) || (!url && !program[0])) { console.error("replay takes one server: a web address, or a program after --."); return 2; }
  const ref = options.get("before");
  // A ref is passed to git as one argument; one starting with "-" could still be read as an option.
  if (!ref || ref.startsWith("-") || !/^[A-Za-z0-9_./@^~{}-]{1,200}$/.test(ref)) { console.error("replay needs --before=<git ref>, such as main or HEAD: the lockfile at that ref is the approved side."); return 2; }
  const timeoutText = options.get("timeout");
  if (timeoutText !== undefined && !(/^\d{1,3}$/.test(timeoutText) && Number(timeoutText) >= 1 && Number(timeoutText) <= 600)) { console.error("--timeout takes a whole number of seconds from 1 to 600."); return 2; }
  let target = "the local program given";
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { console.error("That is not a web address."); return 2; }
    if (parsed.username || parsed.password) { console.error("A web address with a user name or password in it is refused."); return 2; }
    if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(parsed.hostname)))) { console.error("replay reads https:// addresses, and http:// only on this machine (localhost)."); return 2; }
    target = `the server at \`${confined(parsed.host, /[^A-Za-z0-9.:[\]-]+/g, 80) || "?"}\``;
  }

  let loaded: Awaited<ReturnType<typeof loadReplay>>;
  try { loaded = await loadReplay(options.get("settings") || "stackduke-replay/replay.json"); } catch (error) { console.error(`Nothing was replayed: ${printable(error instanceof Error ? error.message : "the settings could not be read", 300)}.`); return 2; }
  const { settings } = loaded;
  const keyVariable = settings.apiKeyEnv ?? defaultKeyVariable[settings.provider];
  const apiKey = process.env[keyVariable] || undefined;
  const localServer = settings.provider === "chat-completions" && settings.baseUrl !== undefined && isLoopback(new URL(settings.baseUrl).hostname);
  if (!apiKey && !localServer) { console.error(`Set ${keyVariable} in the environment to the key for ${settings.provider}. It is read from there only, and never printed or stored.`); return 2; }

  const lockfilePath = options.get("lockfile") || "stackduke.lock.json";
  const relative = path.relative(process.cwd(), path.resolve(lockfilePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) { console.error("The lockfile must be inside the current folder, so git can show it at the ref."); return 2; }
  let approvedText: string;
  try { approvedText = await gitShow(ref, relative); } catch { console.error(`The lockfile ${printable(relative)} could not be read at ${printable(ref)}. Is it committed there, and is this a git repository?`); return 2; }
  const approved = readLockfile(approvedText);
  if (!approved.ok) { console.error(`The lockfile at ${printable(ref)} could not be read: ${approved.reason}.`); return 2; }
  const beforeTools: ToolDefinition[] = approved.lockfile.tools.map(({ accepted: _accepted, ...tool }) => tool);

  const timeoutMs = timeoutText === undefined ? undefined : Number(timeoutText) * 1000;
  const env = Object.fromEntries(Object.entries(programEnvironment(process.env)).filter(([name]) => ![...modelKeyVariables, keyVariable].includes(name)));
  const listed = url ? await listTools(url, timeoutMs ? { timeoutMs } : {}) : await listToolsStdio(program, { env, ...(timeoutMs ? { timeoutMs } : {}) });
  if (listed.outcome !== "listed") {
    if (listed.outcome === "sign-in-required") { console.error(`The tools of ${target} could not be listed: it asks for a sign-in (HTTP ${listed.status}), and replay sends no credential to it.`); return 3; }
    console.error(`The tools of ${target} could not be listed: ${listed.outcome}, ${printable(listed.detail)}.`);
    return 4;
  }
  const afterTools = takeSnapshot("after", listed.tools).tools.map(({ hash: _hash, variant: _variant, ...tool }) => tool);
  const tools = { before: beforeTools, after: afterTools };

  const unsendable = [...new Set([...beforeTools, ...afterTools].map((tool) => tool.name).filter((name) => !sendableName.test(name)))];
  if (unsendable.length) { console.error(`${unsendable.length} tool name(s) are not accepted by model APIs (letters, digits, "_" and "-", up to 64 characters), and are not renamed, since a renamed tool is a different tool to the model: ${unsendable.slice(0, 10).map((name) => printable(name, 60)).join(", ")}.`); return 2; }

  const hashes = { before: definitionsHash(beforeTools), after: definitionsHash(afterTools) };
  if (hashes.before === hashes.after) { console.log(`No tool definition differs from the lockfile at ${printable(ref)}, so nothing was replayed and no model was called.`); return 0; }

  const adapter = makeAdapter({ provider: settings.provider, model: settings.model, ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}), ...(settings.region ? { region: settings.region } : {}), ...(apiKey ? { apiKey } : {}), inference: settings.inference, providerFields: settings.providerFields });
  const total = loaded.cases.length * 2 * settings.runsPerSide;
  console.error(`Replaying ${loaded.cases.length} case(s), ${settings.runsPerSide} runs a side, ${total} runs in all, with ${settings.provider} ${printable(settings.model, 80)}. At most ${settings.maxModelCalls} model calls.`);
  let result: Awaited<ReturnType<typeof runReplay>>;
  try {
    result = await runReplay({ adapter, settings, systemPrompt: loaded.systemPrompt, cases: loaded.cases, tools, onRunDone: (done) => { if (done % 10 === 0 || done === total) console.error(`  ${done} of ${total} runs done`); } });
  } catch (error) {
    console.error(`The replay stopped and reports nothing: ${printable(error instanceof Error ? error.message : "the model API failed", 300)}.`);
    return 4;
  }

  const measured = measure(result.runs, loaded.cases, tools, settings, loaded.rules);
  const diff = diffSnapshots(takeSnapshot("before", beforeTools, undefined, ""), takeSnapshot("after", afterTools, undefined, ""));
  const changes = {
    added: diff.added.map((tool) => tool.name),
    removed: diff.removed.map((tool) => tool.name),
    changed: diff.changed.map((change) => ({ name: change.name, fields: change.fields.map((field) => fieldWords[field] ?? field) })),
  };
  const inference = settings.inference;
  const sent = [
    inference.maxTokens !== undefined ? `max tokens ${inference.maxTokens}` : "",
    inference.temperature !== undefined ? `temperature ${inference.temperature}` : "",
    inference.topP !== undefined ? `top p ${inference.topP}` : "",
    Object.keys(settings.providerFields).length ? `provider fields ${Object.keys(settings.providerFields).map((key) => `\`${confined(key, /[^A-Za-z0-9_.-]+/g, 40) || "?"}\``).join(", ")}` : "",
  ].filter(Boolean);
  const evidence = {
    toolsBefore: hashes.before, toolsAfter: hashes.after, ref, target,
    provider: settings.provider, model: settings.model, settingsShown: sent.length ? sent.join(", ") : "the provider's default settings",
    systemPrompt: loaded.fingerprints.systemPrompt,
    cases: { hash: loaded.fingerprints.cases, count: loaded.cases.length },
    policy: loaded.fingerprints.policy ? { hash: loaded.fingerprints.policy, count: loaded.rules.length } : null,
    scanner: await scannerVersion(),
    date: new Date().toISOString(),
    runsPerSide: settings.runsPerSide, runs: result.runs.length, modelCalls: result.modelCalls,
    tokens: result.runs.reduce((sum, run) => ({ input: sum.input + run.usage.input, output: sum.output + run.usage.output }), { input: 0, output: 0 }),
  };
  const markdown = describeReplay(evidence, changes, measured, loaded.cases);
  console.log(markdown);
  const summaryPath = options.get("summary");
  if (summaryPath) await writeWhole(summaryPath, markdown);
  const jsonPath = options.get("json");
  // The JSON holds the model's answers and arguments as they were: for the team's own CI or machine, never a public comment.
  if (jsonPath) await writeWhole(jsonPath, `${JSON.stringify({ evidence, changes, settings, measures: measured, runs: result.runs }, null, 2)}\n`);
  return 0;
}
