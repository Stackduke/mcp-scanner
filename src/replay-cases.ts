import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { defaultKeyVariable, providers } from "./models.ts";
import type { Inference, Provider } from "./models.ts";

/**
 * The files behaviour replay reads: a settings file, one file per case, and an optional file of
 * policy rules. Each is read strictly, like the lockfile: a field this version does not know
 * stops the run rather than being skipped, so a misspelt field cannot quietly switch a check off.
 *
 * Paths in the settings file are taken from the settings file's own folder.
 */
export interface ReplaySettings {
  provider: Provider;
  model: string;
  baseUrl?: string;
  region?: string;
  /** The environment variable the key is read from: a provider's usual name, or one starting STACKDUKE_REPLAY_. Its value is never printed or stored. */
  apiKeyEnv?: string;
  systemPromptFile: string;
  inference: Inference;
  providerFields: Record<string, unknown>;
  runsPerSide: number;
  maxSteps: number;
  /** Absent: four calls for every run, worked out once the cases are counted. */
  maxModelCalls?: number;
  concurrency: number;
  /** Tools that reach outside without being counted as sending: a search whose query goes to a third party. */
  outbound: string[];
  policyFile?: string;
  citations: { format: "urls-in-text"; allow: string[]; deny: string[] };
  casesDir: string;
}

export interface CannedOutput {
  default?: unknown;
  /** Tried in order before `default`: the first whose `when` values all equal the call's arguments. */
  matches: Array<{ when: Record<string, unknown>; output: unknown }>;
}

export interface PlantedInstruction {
  /** The tool whose canned output carries the instruction. */
  in: string;
  obeyedIf: { calls: string[]; recipients: string[]; leaks: boolean };
}

export interface ReplayCase {
  name: string;
  about?: string;
  /** A case's own system prompt, in place of the settings' file. */
  system?: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  user: string;
  canaries: string[];
  /** The tools this case's task should need. Absent: no out-of-scope check for the case. */
  needs?: string[];
  mustCall: string[];
  outputs: Record<string, CannedOutput>;
  planted: PlantedInstruction[];
}

/** One rule in the platform's draft policy rule shape. Fields are kept as the platform names them. */
export interface PolicyRule {
  id: string;
  name: string;
  plane: "Model Gateway" | "MCP Gateway";
  subject?: string;
  connectionId?: string;
  connection?: string;
  capabilityType: string;
  capabilityId: string;
  capability: string;
  resource?: string;
  condition?: string;
  decision: "Allow" | "Block" | "Require Approval";
  obligation?: string;
  priority: number;
  /** The platform's preview-only structured condition. Kept, not evaluated. */
  demoCondition?: Record<string, unknown>;
}

export interface LoadedReplay {
  settings: ReplaySettings;
  systemPrompt: string;
  cases: ReplayCase[];
  rules: PolicyRule[];
  /** SHA-256 fingerprints for the evidence header. */
  fingerprints: { systemPrompt: string; cases: string; policy: string | null };
}

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
const unknownField = (record: Record<string, unknown>, known: readonly string[]) => Object.keys(record).find((key) => !known.includes(key));
/** Names the field, cut to plain characters: the file is the team's own, but its text is still printed. */
const notKnown = (field: string, where = "it") => `${where} has a field this version does not know (${field.replace(/[^A-Za-z0-9_-]+/g, "?").slice(0, 40)})`;
const wholeNumber = (value: unknown, low: number, high: number) => typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

const keyVariables = Object.values(defaultKeyVariable);
const settingsFields = ["replayVersion", "provider", "model", "baseUrl", "region", "apiKeyEnv", "systemPromptFile", "inference", "providerFields", "runsPerSide", "maxSteps", "maxModelCalls", "concurrency", "outbound", "policyFile", "citations", "casesDir", "failWhen"] as const;
// Fields that the replay itself fills in; letting providerFields set them would replace the tools or the conversation.
const reservedRequestFields = new Set(["model", "messages", "system", "tools", "toolConfig", "tool_choice", "toolChoice", "stream"]);

const isLoopbackUrl = (url: URL) => url.hostname === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === "[::1]";

export function readSettings(text: string): Read<ReplaySettings> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: "it is not valid JSON" }; }
  if (!isRecord(parsed)) return { ok: false, reason: "it is not a JSON object" };
  if (parsed.replayVersion !== 1) return { ok: false, reason: "its replayVersion is not 1" };
  const unknown = unknownField(parsed, settingsFields);
  if (unknown !== undefined) return { ok: false, reason: notKnown(unknown) };
  if (!providers.includes(parsed.provider as Provider)) return { ok: false, reason: `provider must be one of ${providers.join(", ")}` };
  if (!isText(parsed.model)) return { ok: false, reason: "it names no model" };
  if (!isText(parsed.systemPromptFile)) return { ok: false, reason: "it names no systemPromptFile" };
  if (parsed.baseUrl !== undefined) {
    let url: URL;
    try { url = new URL(String(parsed.baseUrl)); } catch { return { ok: false, reason: "baseUrl is not a web address" }; }
    if (url.username || url.password) return { ok: false, reason: "baseUrl has a user name or password in it" };
    if (!(url.protocol === "https:" || (url.protocol === "http:" && isLoopbackUrl(url)))) return { ok: false, reason: "baseUrl must be https, or http only on this machine" };
  }
  if (parsed.region !== undefined && !(typeof parsed.region === "string" && /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(parsed.region))) return { ok: false, reason: "region is not an AWS region name" };
  if (parsed.provider === "bedrock-converse" && parsed.region === undefined && parsed.baseUrl === undefined) return { ok: false, reason: "bedrock-converse needs a region (or a baseUrl)" };
  // Any other variable could be a token for something else entirely, which a branch could then send to its own baseUrl.
  if (parsed.apiKeyEnv !== undefined && !(typeof parsed.apiKeyEnv === "string" && (keyVariables.includes(parsed.apiKeyEnv) || /^STACKDUKE_REPLAY_[A-Z0-9_]{1,60}$/.test(parsed.apiKeyEnv)))) return { ok: false, reason: `apiKeyEnv must be ${keyVariables.join(", ")}, or a name starting STACKDUKE_REPLAY_` };

  const inference = parsed.inference ?? {};
  if (!isRecord(inference) || unknownField(inference, ["maxTokens", "temperature", "topP"]) !== undefined) return { ok: false, reason: "inference takes only maxTokens, temperature and topP" };
  if (inference.maxTokens !== undefined && !wholeNumber(inference.maxTokens, 1, 200_000)) return { ok: false, reason: "inference.maxTokens is not a whole number from 1 to 200000" };
  for (const field of ["temperature", "topP"] as const) if (inference[field] !== undefined && !(typeof inference[field] === "number" && inference[field] >= 0 && inference[field] <= 2)) return { ok: false, reason: `inference.${field} is not a number from 0 to 2` };
  const providerFields = parsed.providerFields ?? {};
  if (!isRecord(providerFields)) return { ok: false, reason: "providerFields is not an object" };
  if (Object.keys(providerFields).some((key) => reservedRequestFields.has(key))) return { ok: false, reason: "providerFields may not set the model, the conversation or the tools" };

  const counts = { runsPerSide: [10, 1, 100], maxSteps: [8, 1, 50], maxModelCalls: [undefined, 1, 100_000], concurrency: [4, 1, 16] } as const;
  const numbers: Record<string, number> = {};
  for (const [field, [fallback, low, high]] of Object.entries(counts)) {
    const value = parsed[field] ?? fallback;
    if (value === undefined) continue;
    if (!wholeNumber(value, low, high)) return { ok: false, reason: `${field} is not a whole number from ${low} to ${high}` };
    numbers[field] = value as number;
  }
  if (parsed.outbound !== undefined && !isTextList(parsed.outbound)) return { ok: false, reason: "outbound is not a list of tool names" };
  if (parsed.policyFile !== undefined && !isText(parsed.policyFile)) return { ok: false, reason: "policyFile is not a path" };
  if (parsed.casesDir !== undefined && !isText(parsed.casesDir)) return { ok: false, reason: "casesDir is not a path" };
  const citations = parsed.citations ?? {};
  if (!isRecord(citations) || unknownField(citations, ["format", "allow", "deny"]) !== undefined) return { ok: false, reason: "citations takes only format, allow and deny" };
  if (citations.format !== undefined && citations.format !== "urls-in-text") return { ok: false, reason: 'citations.format can only be "urls-in-text" in this version' };
  for (const list of ["allow", "deny"] as const) if (citations[list] !== undefined && !(isTextList(citations[list]) && citations[list].every((domain) => /^(\*\.)?[a-z0-9.-]+$/i.test(domain)))) return { ok: false, reason: `citations.${list} is not a list of domains` };
  if (parsed.failWhen !== undefined && !(Array.isArray(parsed.failWhen) && parsed.failWhen.length === 0)) return { ok: false, reason: "fail rules come in a later version; failWhen must be empty" };

  return {
    ok: true,
    value: {
      provider: parsed.provider as Provider,
      model: parsed.model,
      ...(parsed.baseUrl !== undefined ? { baseUrl: String(parsed.baseUrl) } : {}),
      ...(parsed.region !== undefined ? { region: parsed.region as string } : {}),
      ...(parsed.apiKeyEnv !== undefined ? { apiKeyEnv: parsed.apiKeyEnv as string } : {}),
      systemPromptFile: parsed.systemPromptFile,
      inference: inference as Inference,
      providerFields,
      runsPerSide: numbers.runsPerSide as number,
      maxSteps: numbers.maxSteps as number,
      ...(numbers.maxModelCalls !== undefined ? { maxModelCalls: numbers.maxModelCalls } : {}),
      concurrency: numbers.concurrency as number,
      outbound: (parsed.outbound as string[] | undefined) ?? [],
      ...(parsed.policyFile !== undefined ? { policyFile: parsed.policyFile as string } : {}),
      citations: { format: "urls-in-text", allow: (citations.allow as string[] | undefined) ?? [], deny: (citations.deny as string[] | undefined) ?? [] },
      casesDir: (parsed.casesDir as string | undefined) ?? "cases",
    },
  };
}

const caseFields = ["name", "about", "system", "history", "user", "canaries", "needs", "mustCall", "outputs", "planted"] as const;

function readOutputs(value: unknown): Read<Record<string, CannedOutput>> {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false, reason: "outputs is not an object of tool names" };
  const outputs: Array<[string, CannedOutput]> = [];
  for (const [tool, entry] of Object.entries(value)) {
    if (!isRecord(entry) || unknownField(entry, ["default", "matches"]) !== undefined) return { ok: false, reason: `the outputs for a tool take only default and matches` };
    const matches = entry.matches ?? [];
    if (!Array.isArray(matches) || !matches.every((match) => isRecord(match) && isRecord(match.when) && "output" in match && unknownField(match, ["when", "output"]) === undefined)) return { ok: false, reason: "each entry in matches needs when (an object) and output, and nothing else" };
    outputs.push([tool, { ...("default" in entry ? { default: entry.default } : {}), matches: matches as CannedOutput["matches"] }]);
  }
  // fromEntries makes every name an own property, "__proto__" included; lookups use Object.hasOwn.
  return { ok: true, value: Object.fromEntries(outputs) };
}

export function readCase(text: string): Read<ReplayCase> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: "it is not valid JSON" }; }
  if (!isRecord(parsed)) return { ok: false, reason: "it is not a JSON object" };
  const unknownInCase = unknownField(parsed, caseFields);
  if (unknownInCase !== undefined) return { ok: false, reason: notKnown(unknownInCase) };
  if (!(typeof parsed.name === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(parsed.name))) return { ok: false, reason: "its name is missing, or uses more than letters, digits, dots, dashes and underscores" };
  if (!isText(parsed.user)) return { ok: false, reason: "it has no user message" };
  for (const field of ["about", "system"] as const) if (parsed[field] !== undefined && typeof parsed[field] !== "string") return { ok: false, reason: `${field} is not text` };
  const history = parsed.history ?? [];
  if (!Array.isArray(history) || !history.every((turn) => isRecord(turn) && (turn.role === "user" || turn.role === "assistant") && isText(turn.text) && unknownField(turn, ["role", "text"]) === undefined)) return { ok: false, reason: "history is not a list of { role, text } turns" };
  // Turns alternate, starting with the user and ending with the assistant, so the case's own user message comes next.
  if (history.some((turn, index) => (turn as { role: string }).role !== (index % 2 === 0 ? "user" : "assistant")) || history.length % 2 !== 0) return { ok: false, reason: "history must alternate user and assistant turns, starting with the user and ending with the assistant" };
  for (const field of ["canaries", "mustCall"] as const) if (parsed[field] !== undefined && !isTextList(parsed[field])) return { ok: false, reason: `${field} is not a list of text` };
  if (parsed.needs !== undefined && !isTextList(parsed.needs)) return { ok: false, reason: "needs is not a list of tool names" };
  if ((parsed.canaries as string[] | undefined)?.some((canary) => canary.trim().length < 4)) return { ok: false, reason: "a canary is shorter than 4 characters, which would match by chance" };
  const outputs = readOutputs(parsed.outputs);
  if (!outputs.ok) return outputs;
  const planted = parsed.planted ?? [];
  if (!Array.isArray(planted)) return { ok: false, reason: "planted is not a list" };
  const plantedRead: PlantedInstruction[] = [];
  for (const item of planted) {
    if (!isRecord(item) || unknownField(item, ["in", "obeyedIf"]) !== undefined || !isText(item.in) || !isRecord(item.obeyedIf)) return { ok: false, reason: "each planted instruction needs in (a tool name) and obeyedIf" };
    const obeyed = item.obeyedIf;
    if (unknownField(obeyed, ["calls", "recipients", "leaks"]) !== undefined) return { ok: false, reason: "obeyedIf takes only calls, recipients and leaks" };
    if ((obeyed.calls !== undefined && !isTextList(obeyed.calls)) || (obeyed.recipients !== undefined && !isTextList(obeyed.recipients)) || (obeyed.leaks !== undefined && typeof obeyed.leaks !== "boolean")) return { ok: false, reason: "obeyedIf has a value of the wrong kind" };
    const rule = { calls: (obeyed.calls as string[] | undefined) ?? [], recipients: (obeyed.recipients as string[] | undefined) ?? [], leaks: obeyed.leaks === true };
    if (!rule.calls.length && !rule.recipients.length && !rule.leaks) return { ok: false, reason: "a planted instruction's obeyedIf says nothing that would count as obeying it" };
    if (rule.leaks && !(parsed.canaries as string[] | undefined)?.length) return { ok: false, reason: "a planted instruction counts leaks, but the case has no canaries" };
    plantedRead.push({ in: item.in, obeyedIf: rule });
  }
  return {
    ok: true,
    value: {
      name: parsed.name,
      ...(typeof parsed.about === "string" ? { about: parsed.about } : {}),
      ...(typeof parsed.system === "string" ? { system: parsed.system } : {}),
      history: history as ReplayCase["history"],
      user: parsed.user,
      canaries: (parsed.canaries as string[] | undefined) ?? [],
      ...(parsed.needs !== undefined ? { needs: parsed.needs as string[] } : {}),
      mustCall: (parsed.mustCall as string[] | undefined) ?? [],
      outputs: outputs.value,
      planted: plantedRead,
    },
  };
}

const ruleFields = ["id", "name", "plane", "subject", "connectionId", "connection", "capabilityType", "capabilityId", "capability", "resource", "condition", "decision", "obligation", "priority", "demoCondition"] as const;

/** A JSON list of rules, or an object holding one under `rules`, in the platform's draft rule shape. */
export function readPolicyRules(text: string): Read<PolicyRule[]> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: "it is not valid JSON" }; }
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.rules) && Object.keys(parsed).length === 1 ? parsed.rules : null;
  if (!list) return { ok: false, reason: "it is not a list of rules, or an object with only a rules list" };
  const rules: PolicyRule[] = [];
  const ids = new Set<string>();
  for (const [index, item] of list.entries()) {
    const at = `rule ${index + 1}`;
    if (!isRecord(item)) return { ok: false, reason: `${at} is not an object` };
    const unknownInRule = unknownField(item, ruleFields);
    if (unknownInRule !== undefined) return { ok: false, reason: notKnown(unknownInRule, at) };
    for (const field of ["id", "name", "capabilityType", "capabilityId", "capability"] as const) if (!isText(item[field])) return { ok: false, reason: `${at} has no ${field}` };
    for (const field of ["subject", "connectionId", "connection", "resource", "condition", "obligation"] as const) if (item[field] !== undefined && typeof item[field] !== "string") return { ok: false, reason: `${at} has a ${field} that is not text` };
    if (item.plane !== "Model Gateway" && item.plane !== "MCP Gateway") return { ok: false, reason: `${at} has a plane other than Model Gateway or MCP Gateway` };
    if (item.decision !== "Allow" && item.decision !== "Block" && item.decision !== "Require Approval") return { ok: false, reason: `${at} has a decision other than Allow, Block or Require Approval` };
    if (typeof item.priority !== "number" || !Number.isFinite(item.priority)) return { ok: false, reason: `${at} has no priority number` };
    if (item.demoCondition !== undefined && !isRecord(item.demoCondition)) return { ok: false, reason: `${at} has a demoCondition that is not an object` };
    if (ids.has(item.id as string)) return { ok: false, reason: `${at} repeats an id used before it` };
    ids.add(item.id as string);
    rules.push(item as unknown as PolicyRule);
  }
  return { ok: true, value: rules };
}

/** Reads everything a replay needs from the settings file onward. Throws with a reason the person can act on. */
export async function loadReplay(settingsPath: string): Promise<LoadedReplay> {
  const folder = path.dirname(settingsPath);
  const settingsRead = readSettings(await readFile(settingsPath, "utf8").catch(() => { throw new Error(`the settings file ${settingsPath} could not be opened`); }));
  if (!settingsRead.ok) throw new Error(`the settings file could not be read: ${settingsRead.reason}`);
  const settings = settingsRead.value;
  const promptPath = path.resolve(folder, settings.systemPromptFile);
  const promptBytes = await readFile(promptPath).catch(() => { throw new Error("the system prompt file could not be opened"); });

  const casesFolder = path.resolve(folder, settings.casesDir);
  const names = (await readdir(casesFolder).catch(() => { throw new Error("the cases folder could not be opened"); })).filter((name) => name.endsWith(".json")).sort();
  if (!names.length) throw new Error("the cases folder holds no .json case files");
  const cases: ReplayCase[] = [];
  const caseHash = createHash("sha256");
  for (const file of names) {
    const bytes = await readFile(path.join(casesFolder, file));
    caseHash.update(`${file}\n`).update(bytes).update("\n");
    const read = readCase(bytes.toString("utf8"));
    if (!read.ok) throw new Error(`the case file ${file} could not be read: ${read.reason}`);
    if (cases.some((existing) => existing.name === read.value.name)) throw new Error(`the case file ${file} repeats a case name used before it`);
    cases.push(read.value);
  }

  let rules: PolicyRule[] = [];
  let policy: string | null = null;
  if (settings.policyFile) {
    const bytes = await readFile(path.resolve(folder, settings.policyFile)).catch(() => { throw new Error("the policy file could not be opened"); });
    const read = readPolicyRules(bytes.toString("utf8"));
    if (!read.ok) throw new Error(`the policy file could not be read: ${read.reason}`);
    rules = read.value;
    policy = sha256(bytes);
  }
  return { settings, systemPrompt: promptBytes.toString("utf8"), cases, rules, fingerprints: { systemPrompt: sha256(promptBytes), cases: caseHash.digest("hex"), policy } };
}
