import { assessTool, canDo, confined, day, listed, plural, seriousFirst, sentenceList, shownName, shownSource } from "./authority.ts";
import type { AuthorityKind } from "./authority.ts";
import { diffSnapshots } from "./diff.ts";
import type { ChangedField } from "./diff.ts";
import { findInTool } from "./findings.ts";
import { descriptionSuggests, nameSuggests } from "./risk.ts";
import { toolKey } from "./snapshot.ts";
import type { CapabilityClass, Snapshot, SnapshotTool } from "./types.ts";

/**
 * One page per agent: every server its config lists, every tool on each, the tool's kind, how
 * the kind was reached, whether the text checks flagged it, and what changed since the last
 * saved look. Then up to three rules worth setting, as suggestions.
 *
 * It keeps the scanner's rules. Every kind is read the more serious way (see authority.ts), the
 * server's descriptions are never quoted, and nothing here says a tool or a server is safe.
 *
 * The JSON form (`reachJson`) holds only the fields the collector may send: server address,
 * tool name, kind, label source, fingerprint, the yes/no findings flag, scan time and collector
 * version, plus the agent's label and each server's status. Changes and suggested rules are
 * worked out from two reports, so they are left out of it.
 */

/** How a tool's kind was reached. "annotation" is the server's own hint, taken as given unless something says more. */
export type LabelSource = "annotation" | "name" | "description" | "none";

export type ServerOutcome =
  | { status: "listed"; snapshot: Snapshot; previous: Snapshot | null; saved?: boolean }
  | { status: "sign-in-required"; httpStatus: number }
  | { status: "unreachable" | "not-usable"; detail: string }
  /** A local program, which `reach` starts only with --run-local. */
  | { status: "not-run" }
  | { status: "switched-off" }
  | { status: "bad-entry"; detail: string };

export interface ServerLook {
  /** The server's name in the agent's config. */
  name: string;
  /** Where it is: "https://host/path" with nothing private in it, or "local: <name>". */
  address: string;
  outcome: ServerOutcome;
}

export interface AgentLook { label: string; servers: ServerLook[] }

export interface ReachTool {
  /** Safe to print: cut down to the characters a tool name normally has, dots written "[.]". */
  shown: string;
  /** The tool's name for machines: the characters a tool name normally has, nothing else. */
  name: string;
  kind: AuthorityKind;
  does: CapabilityClass[];
  labelSource: LabelSource;
  /** This report would not take the server's label or the name at face value, and counted the tool the more serious way. */
  disputed: boolean;
  broad: boolean;
  fingerprint: string;
  /** The text checks found words aimed at the model, hidden characters, or pointers at secrets. Yes/no only. */
  hiddenInstructions: boolean;
  /** Since the last saved look. Absent when there was none, or the tool is as it was. */
  change?: "new" | "changed";
  /** For a changed tool: what changed, and the kind it had before when that differs. */
  changedFields?: ChangedField[];
  wasKind?: AuthorityKind;
}

export interface ServerReach {
  name: string;
  address: string;
  outcome: ServerOutcome;
  tools: ReachTool[];
  /** Tools in the last saved look and not in this one. */
  removed: Array<{ shown: string; kind: AuthorityKind }>;
  /** When the last saved look was taken, if there was one. */
  comparedWith: string | null;
}

export type RuleId = "block-flagged" | "approve-money" | "hold-destructive" | "approve-free-form" | "reapprove-changed" | "review-unclear" | "approve-send" | "log-writes" | "check-account";

export interface SuggestedRule {
  id: RuleId;
  /** The rule, as a person would set it. */
  rule: string;
  /** Why, from this report. */
  why: string;
  tools: Array<{ server: string; tool: string }>;
}

export interface AgentReach { label: string; servers: ServerReach[]; rules: SuggestedRule[] }

const machineName = (tool: { name: string; variant?: string }) => {
  const name = confined(tool.name, /[^A-Za-z0-9_.-]+/g, 128) || "(no name)";
  const variant = confined(tool.variant, /[^A-Za-z0-9_.-]+/g, 60);
  return variant ? `${name}#${variant}` : name;
};

/** Whether the text checks found something that may be aimed at the model. A mismatch between label and name is not counted here: the kind already shows it. */
export function hiddenInstructions(tool: SnapshotTool): boolean {
  return findInTool(tool).some((finding) => finding.rule !== "annotation-mismatch" && finding.severity !== "low");
}

function kindOf(tool: SnapshotTool): AuthorityKind {
  return assessTool(tool).tool.kind;
}

function readTool(tool: SnapshotTool): ReachTool {
  const assessed = assessTool(tool).tool;
  let labelSource: LabelSource = assessed.basis === "server" ? "annotation" : assessed.basis;
  // Where a label was raised (the server's own, or one read from the name), say what raised it.
  if (assessed.disputed && assessed.kind !== "unclear") {
    labelSource = nameSuggests(tool).includes(assessed.kind) ? "name" : descriptionSuggests(tool).includes(assessed.kind) ? "description" : labelSource;
  }
  if (assessed.kind === "unclear") labelSource = "none";
  return {
    shown: shownName(tool),
    name: machineName(tool),
    kind: assessed.kind,
    does: assessed.does,
    labelSource,
    disputed: assessed.disputed,
    broad: assessed.broad,
    fingerprint: tool.hash,
    hiddenInstructions: hiddenInstructions(tool),
  };
}

function readServer(look: ServerLook): ServerReach {
  const base = { name: look.name, address: look.address, outcome: look.outcome, removed: [], comparedWith: null };
  if (look.outcome.status !== "listed") return { ...base, tools: [] };
  const { snapshot, previous } = look.outcome;
  const tools = snapshot.tools.map(readTool);
  if (!previous) return { ...base, tools };

  const diff = diffSnapshots(previous, snapshot);
  const added = new Set(diff.added.map(toolKey));
  const changed = new Map(diff.changed.map((change) => [change.name, change]));
  snapshot.tools.forEach((tool, index) => {
    const reached = tools[index] as ReachTool;
    const key = toolKey(tool);
    if (added.has(key)) reached.change = "new";
    const change = changed.get(key);
    if (change) {
      reached.change = "changed";
      reached.changedFields = change.fields;
      const was = kindOf(change.before);
      if (was !== reached.kind) reached.wasKind = was;
    }
  });
  return { ...base, tools, removed: diff.removed.map((tool) => ({ shown: shownName(tool), kind: kindOf(tool) })), comparedWith: previous.takenAt };
}

/**
 * Up to three rules, most serious first, each from something this report found. Fewer when
 * fewer apply: a rule with nothing behind it is not suggested to fill the list.
 */
export function suggestRules(servers: ServerReach[]): SuggestedRule[] {
  const pick = (test: (tool: ReachTool) => boolean) => servers.flatMap((server) => server.tools.filter(test).map((tool) => ({ server: server.name, tool: tool.shown })));
  const toolsWord = (count: number) => (count === 1 ? "1 tool" : `${count} tools`);
  const candidates: Array<Omit<SuggestedRule, "why"> & { why: (count: number) => string }> = [
    { id: "block-flagged", rule: "Block the flagged tools until a person has read what they tell the agent", why: (count) => `The text checks flagged ${toolsWord(count)} for words aimed at the model, hidden characters or pointers at secrets.`, tools: pick((tool) => tool.hiddenInstructions) },
    { id: "approve-money", rule: "Require a person's approval before any money tool runs", why: (count) => `${toolsWord(count)} may move or spend money.`, tools: pick((tool) => tool.does.includes("money")) },
    { id: "hold-destructive", rule: "Hold destructive tools until a person approves each call", why: (count) => `${toolsWord(count)} may make changes that cannot be undone.`, tools: pick((tool) => tool.does.includes("destructive")) },
    { id: "approve-free-form", rule: "Require approval for tools that take free-form input such as SQL or a shell command", why: (count) => `${toolsWord(count)} take${count === 1 ? "s" : ""} free-form input, so ${count === 1 ? "it" : "they"} may do more than ${count === 1 ? "its label says" : "their labels say"}.`, tools: pick((tool) => tool.broad) },
    { id: "reapprove-changed", rule: "Re-approve changed tools before an agent uses them again", why: (count) => `${toolsWord(count)} changed since the last saved look. A changed tool can carry new instructions.`, tools: pick((tool) => tool.change === "changed") },
    { id: "review-unclear", rule: "Review the unclear tools, and treat them as able to change things until someone has", why: (count) => `Nothing reliable says what ${toolsWord(count)} do${count === 1 ? "es" : ""}.`, tools: pick((tool) => tool.kind === "unclear") },
    { id: "approve-send", rule: "Require approval before an agent sends messages or publishes", why: (count) => `${toolsWord(count)} may send things to other people in your name.`, tools: pick((tool) => tool.does.includes("send")) },
    { id: "log-writes", rule: "Log every call to a tool that creates or changes things", why: (count) => `${toolsWord(count)} may create or change things.`, tools: pick((tool) => tool.does.includes("write")) },
    { id: "check-account", rule: "Check what the account behind each server can see", why: (count) => `${toolsWord(count)} hand data to the agent, and an agent can pass what it knows into any tool.`, tools: pick((tool) => tool.kind === "read") },
  ];
  return candidates.filter((candidate) => candidate.tools.length).slice(0, 3).map(({ why, ...candidate }) => ({ ...candidate, why: why(candidate.tools.length) }));
}

export function reachOf(agent: AgentLook): AgentReach {
  const servers = agent.servers.map(readServer);
  return { label: agent.label, servers, rules: suggestRules(servers) };
}

/** The report the collector may send, and nothing more. See the note at the top of this file. */
export function reachJson(agents: AgentReach[], meta: { collectorVersion: string; scannedAt: string }) {
  return {
    format: "stackduke.reach.v1",
    collectorVersion: meta.collectorVersion,
    scannedAt: meta.scannedAt,
    agents: agents.map((agent) => ({
      agent: agent.label,
      servers: agent.servers.map((server) => ({
        server: server.address || server.name,
        status: server.outcome.status,
        ...(server.outcome.status === "listed" ? { scannedAt: server.outcome.snapshot.takenAt } : {}),
        tools: server.tools.map((tool) => ({ name: tool.name, kind: tool.kind, labelSource: tool.labelSource, fingerprint: tool.fingerprint, findings: { hiddenInstructions: tool.hiddenInstructions } })),
      })),
    })),
  };
}

const labelWords: Record<LabelSource, string> = { annotation: "server's label", name: "name", description: "description", none: "nothing" };
const notLookedAt = (outcome: ServerOutcome): string => {
  switch (outcome.status) {
    case "sign-in-required": return `asks for a sign-in (HTTP ${outcome.httpStatus}), and reach sends no credential`;
    case "unreachable": return `did not answer (${confined(outcome.detail, /[^A-Za-z0-9 ,()_.-]+/g, 80) || "no detail"})`;
    case "not-usable": return `answered, but not with a tool list reach can use (${confined(outcome.detail, /[^A-Za-z0-9 ,()_.-]+/g, 80) || "no detail"})`;
    case "not-run": return "runs as a local program, which reach starts only with --run-local";
    case "switched-off": return "switched off in the config";
    case "bad-entry": return `not read: ${confined(outcome.detail, /[^A-Za-z0-9 ,()_.:/-]+/g, 120)}`;
    default: return "listed";
  }
};
const serverHeading = (server: { name: string; address: string }) => {
  if (!server.address) return server.name;
  const where = server.address.startsWith("local: ") ? "local program" : shownSource(server.address);
  return `${server.name} (${where})`;
};

function describeAgent(agent: AgentReach): string[] {
  const looked = agent.servers.filter((server) => server.outcome.status === "listed");
  const notLooked = agent.servers.filter((server) => server.outcome.status !== "listed");
  const tools = looked.flatMap((server) => server.tools);
  const lines: string[] = [`Agent reach: ${agent.label}`];
  const taken = looked.map((server) => (server.outcome as { snapshot: Snapshot }).snapshot.takenAt).sort()[0];
  lines.push(`${plural(agent.servers.length, "server")} listed, ${looked.length} looked at${taken ? ` on ${day(taken)}` : ""}.`, "");

  if (!tools.length) {
    lines.push(looked.length ? "The servers looked at listed no tools, so this report cannot say what the agent could do through them." : "No server could be looked at, so this report cannot say what the agent could do.");
  } else {
    const counts = seriousFirst.map((kind) => [kind, tools.filter((tool) => tool.kind === kind).length] as const).filter(([, count]) => count);
    lines.push(`${plural(tools.length, "tool")}: ${counts.map(([kind, count]) => `${count} ${kind}`).join(", ")}.`);
    const can = (["read", "write", "destructive", "send", "money"] as const).filter((kind) => tools.some((tool) => tool.does.includes(kind)));
    if (can.length) lines.push(`Through these servers the agent can ${sentenceList(can.map((kind) => canDo[kind]))}.`);
    const unclear = tools.filter((tool) => tool.kind === "unclear").length;
    if (unclear) lines.push(`${unclear === 1 ? "One tool" : `${unclear} tools`} could not be labelled, so it may be able to do more than that.`);
    if (notLooked.length) lines.push(`${plural(notLooked.length, "server")} could not be looked at, so the agent may reach more than this shows.`);
  }

  for (const server of looked) {
    lines.push("", `${serverHeading(server)}: ${plural(server.tools.length, "tool")}`);
    if (!server.tools.length) continue;
    const sorted = [...server.tools].sort((a, b) => seriousFirst.indexOf(a.kind) - seriousFirst.indexOf(b.kind));
    const width = Math.min(40, Math.max(4, ...sorted.map((tool) => tool.shown.length + (tool.disputed ? 1 : 0))));
    const row = (kind: string, name: string, label: string, check: string, change: string) => `  ${kind.padEnd(13)}${name.padEnd(width + 2)}${label.padEnd(16)}${check.padEnd(12)}${change}`.trimEnd();
    lines.push(row("Kind", "Tool", "Label from", "Text check", server.comparedWith ? "Since last look" : ""));
    for (const tool of sorted.slice(0, 500)) {
      const change = tool.change === "new" ? "new" : tool.change === "changed" ? `changed (${(tool.changedFields ?? []).join(", ")}${tool.wasKind ? `; was ${tool.wasKind}` : ""})` : "";
      lines.push(row(tool.kind, `${tool.shown}${tool.disputed ? "*" : ""}`, labelWords[tool.labelSource], tool.hiddenInstructions ? "flagged" : "-", change));
    }
    if (sorted.length > 500) lines.push(`  … and ${sorted.length - 500} more`);
  }

  if (notLooked.length) {
    lines.push("", "Not looked at:");
    for (const server of notLooked) lines.push(`  - ${serverHeading(server)}: ${notLookedAt(server.outcome)}`);
  }

  if (looked.length) {
    lines.push("", "Since the last saved look:");
    for (const server of looked) {
      const saved = (server.outcome as { saved?: boolean }).saved;
      if (!server.comparedWith) { lines.push(`  - ${server.name}: first look, nothing saved to compare with. ${saved ? "This look is saved for next time." : "Run with --save to keep this look for next time."}`); continue; }
      const added = server.tools.filter((tool) => tool.change === "new"), changed = server.tools.filter((tool) => tool.change === "changed");
      const parts = [
        ...(added.length ? [`${added.length} new (${listed(added.map((tool) => tool.shown), 8)})`] : []),
        ...(server.removed.length ? [`${server.removed.length} removed (${listed(server.removed.map((tool) => tool.shown), 8)})`] : []),
        ...(changed.length ? [`${changed.length} changed (${listed(changed.map((tool) => tool.shown), 8)})`] : []),
      ];
      lines.push(`  - ${server.name}, compared with ${day(server.comparedWith)}: ${parts.length ? parts.join("; ") : "no tool added, removed or changed"}.${saved ? " This look is saved." : ""}`);
    }
  }

  if (agent.rules.length) {
    lines.push("", "Suggested rules (suggestions only; nothing here enforces them):");
    agent.rules.forEach((rule, index) => {
      lines.push(`  ${index + 1}. ${rule.rule}.`, `     ${rule.why} Applies to: ${listed(rule.tools.map((tool) => (looked.length > 1 ? `${tool.server}/${tool.tool}` : tool.tool)), 8)}.`);
    });
  }
  return lines;
}

const limits = [
  "About these labels:",
  "  - Labels are guesses from what each server says about itself: its own hints, its tool names and the first sentence of each description. Where those disagree, the more serious label is used. Nobody has tested what any tool does, and no tool was called.",
  "  - \"Label from\" says what each label rests on. A star (*) marks a tool this report would not take at face value and counted the more serious way; `authority` explains each one.",
  "  - \"Text check\" says whether a pattern check flagged the tool's text for words aimed at the model, hidden characters or pointers at secrets. A dash means nothing matched, not that the text is safe.",
  "  - This is not a safety rating, and it does not list what a server cannot do. A missing label proves nothing.",
  "  - Only the servers in the config were looked at, with no sign-in. A signed-in account may be shown other tools, and an agent may reach servers its config does not list.",
  "  - The servers' descriptions are not quoted. Only tool names appear, and a server chooses those.",
];

export function describeReach(agents: AgentReach[]): string {
  const lines: string[] = [];
  agents.forEach((agent, index) => { if (index) lines.push("", "-".repeat(60), ""); lines.push(...describeAgent(agent)); });
  lines.push("", ...limits);
  return lines.join("\n");
}
