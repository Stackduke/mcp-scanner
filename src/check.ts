import { assessTool, canDo, confined, plural, shownName } from "./authority.ts";
import type { AuthorityKind } from "./authority.ts";
import { diffSnapshots } from "./diff.ts";
import type { ChangedField, FieldChange, SnapshotDiff } from "./diff.ts";
import { findInTool } from "./findings.ts";
import { lockSnapshot, writeLockfile } from "./lockfile.ts";
import type { Lockfile, LockedTool } from "./lockfile.ts";
import type { FindingSeverity, Snapshot, SnapshotTool, ToolDefinition } from "./types.ts";

/**
 * The pre-deploy check: the tools a server lists now, against the tools its repository has
 * approved in `stackduke.lock.json`.
 *
 * It fails when a tool was added, removed or changed and the lockfile was not updated; when a
 * tool's text trips a high or medium text check; and when a tool counted as able to change
 * things carries no risk annotation. A finding a person has approved for a tool's exact
 * definition, recorded in the lockfile, does not fail it again until the definition changes.
 *
 * The summary follows the plain-language report's rules: every sentence is the scanner's, a
 * tool name appears only as an identifier in a code span, and a server's descriptions are
 * never quoted. A reviewer reads the definitions themselves in the lockfile's diff.
 */
export interface Problem {
  /** The tool's name as the server gives it. Shown only through `shownName`. */
  tool: string;
  /** `rule@where`: what is recorded in the lockfile when a person accepts it. */
  key: string;
  severity: FindingSeverity;
  where: string;
  /** The scanner's own words. */
  reason: string;
}

export interface CheckResult {
  lockfileFound: boolean;
  diff: SnapshotDiff;
  /** High and medium problems nobody has accepted for this definition. Each one fails the check. */
  problems: Problem[];
  /** Problems still present that the lockfile records as accepted. */
  accepted: Problem[];
  /** Low findings. They never fail the check. */
  notes: Problem[];
  toolCount: number;
  /** Names the server listed more than once. Only the first definition is compared, so each one fails the check. */
  repeated: string[];
  passed: boolean;
}

const missingAnnotation = "missing-risk-annotation";

/** Everything about one tool that fails a check unless accepted, and the low notes that never do. */
export function problemsOf(tool: ToolDefinition): { problems: Problem[]; notes: Problem[] } {
  const problems: Problem[] = [], notes: Problem[] = [];
  const seen = new Set<string>();
  for (const finding of findInTool(tool)) {
    const problem: Problem = { tool: tool.name, key: `${finding.rule}@${finding.where}`, severity: finding.severity, where: finding.where, reason: finding.reason };
    if (seen.has(problem.key)) continue;
    seen.add(problem.key);
    (finding.severity === "low" ? notes : problems).push(problem);
  }
  // The protocol gives two risk annotations. Either one, given as true or false, is a statement a
  // reviewer can hold the server to. Without readOnlyHint: false and destructiveHint, the protocol
  // already says to assume a tool may destroy, so readOnlyHint alone is enough.
  const annotations = tool.annotations ?? {};
  const annotated = typeof annotations.readOnlyHint === "boolean" || typeof annotations.destructiveHint === "boolean";
  const kind = assessTool({ ...tool, hash: "" }).tool.kind;
  if (!annotated && kind !== "read") {
    problems.push({
      tool: tool.name, key: missingAnnotation, severity: "high", where: "annotations",
      reason: kind === "unclear"
        ? "Its name does not say what it does, and it carries no risk annotation (readOnlyHint or destructiveHint), so what it can do is not known."
        : `Counted as able to ${canDo[kind]}, but it carries no risk annotation (readOnlyHint or destructiveHint).`,
    });
  }
  return { problems, notes };
}

/** What a person approved for this exact definition: nothing, if the definition has changed since. */
function acceptedFor(tool: SnapshotTool, lock: Snapshot, lockfile: Lockfile | null): Set<string> {
  const locked = lock.tools.find((candidate) => candidate.name === tool.name);
  if (!locked || locked.hash !== tool.hash) return new Set();
  return new Set(lockfile?.tools.find((candidate) => candidate.name === tool.name)?.accepted ?? []);
}

/** Names listed more than once, from the list as the server sent it. */
export function repeatedNames(tools: ToolDefinition[]): string[] {
  const seen = new Set<string>(), repeated = new Set<string>();
  for (const { name } of tools) (seen.has(name) ? repeated : seen).add(name);
  return [...repeated].sort();
}

export function runCheck(live: Snapshot, lockfile: Lockfile | null, repeated: string[] = []): CheckResult {
  const lock = lockSnapshot(lockfile);
  const diff = diffSnapshots(lock, live);
  const problems: Problem[] = [], accepted: Problem[] = [], notes: Problem[] = [];
  for (const tool of live.tools) {
    const found = problemsOf(tool);
    const approved = acceptedFor(tool, lock, lockfile);
    for (const problem of found.problems) (approved.has(problem.key) ? accepted : problems).push(problem);
    notes.push(...found.notes);
  }
  const drift = diff.added.length + diff.removed.length + diff.changed.length;
  return { lockfileFound: lockfile !== null, diff, problems, accepted, notes, toolCount: live.tools.length, repeated, passed: lockfile !== null && drift === 0 && problems.length === 0 && repeated.length === 0 };
}

export type UpdateResult =
  | { written: true; text: string; tools: LockedTool[]; result: CheckResult }
  /** New findings that a person has not accepted, or a name listed twice. Nothing is written. */
  | { written: false; result: CheckResult };

/**
 * The lockfile after a person has approved the current tools. A finding nobody has accepted
 * stops it unless `acceptFindings` is set, so approving a tool change does not also approve, in
 * passing, text that tells the model to ignore its instructions.
 */
export function updateLockfile(live: Snapshot, lockfile: Lockfile | null, acceptFindings: boolean, repeated: string[] = []): UpdateResult {
  const result = runCheck(live, lockfile, repeated);
  // A repeated name cannot be accepted: the lockfile could only record one of its definitions.
  if (repeated.length || (result.problems.length && !acceptFindings)) return { written: false, result };
  const tools: LockedTool[] = live.tools.map(({ hash: _hash, variant: _variant, ...tool }) => {
    const keys = problemsOf(tool).problems.map((problem) => problem.key);
    return { ...tool, ...(keys.length ? { accepted: keys } : {}) };
  });
  return { written: true, text: writeLockfile(tools), tools, result };
}

// ---------------------------------------------------------------------------------------------
// The summary, in Markdown, for a pull-request comment, a job summary or a terminal.

/** How a summary starts. The lockfile's path is in it, so two checks in one pull request keep separate comments. */
export const commentMarker = "<!-- stackduke-mcp-check";
const lockfileShown = (lockfilePath: string) => confined(lockfilePath, /[^A-Za-z0-9_./ -]+/g, 120);
// No ">" or "!" can pass the filter, so the path cannot close the comment early.
const markerFor = (lockfilePath: string) => `${commentMarker} ${lockfileShown(lockfilePath) || "lockfile"} -->`;
// GitHub refuses a comment over 65,536 characters.
const longestSummary = 60_000;
const mostListed = 30;
const howWords: Record<FieldChange, string> = { added: "added", removed: "removed", altered: "rewritten" };
const fieldWords: Record<ChangedField, string> = { title: "title", description: "description", inputSchema: "input schema", outputSchema: "output schema", annotations: "annotations" };

/** A tool name as an identifier, in a code span. `shownName` keeps only characters a code span cannot escape. */
const code = (name: string) => `\`${shownName({ name })}\``;
/** Where in a tool something was found. It holds the server's property names, so it is cut to plain characters. */
const place = (where: string) => {
  const named = where.endsWith(" (name)");
  return `\`${confined(named ? where.slice(0, -7) : where, /[^A-Za-z0-9_.[\] -]+/g, 80) || "?"}${named ? " (name)" : ""}\``;
};

function counted(tool: SnapshotTool): string {
  const kind: AuthorityKind = assessTool(tool).tool.kind;
  return kind === "unclear" ? "what it does could not be labelled" : `counted as able to ${canDo[kind]}`;
}

/** Rows as a Markdown list, cut short with `more` said after the count of those left out. */
export function listOf(rows: string[], more = "The lockfile's diff has them all."): string[] {
  const shown = rows.slice(0, mostListed).map((row) => `- ${row}`);
  return rows.length > mostListed ? [...shown, `- … and ${rows.length - mostListed} more. ${more}`] : shown;
}

/** One row for each tool added, removed or changed, in the scanner's words. */
export function changeRows(diff: SnapshotDiff): string[] {
  return [
    ...diff.added.map((tool) => `${code(tool.name)}: added; ${counted(tool)}`),
    ...diff.removed.map((tool) => `${code(tool.name)}: removed`),
    ...diff.changed.map((change) => {
      const fields = change.fields.map((field) => `${fieldWords[field]} ${howWords[change.how[field] ?? "altered"]}`).join(", ");
      const before = assessTool(change.before).tool, after = assessTool(change.after).tool;
      const gained = after.does.filter((kind) => kind !== "read" && !before.does.includes(kind));
      const wider = gained.length || (after.kind === "unclear" && before.kind !== "unclear");
      return `${code(change.name)}: ${fields}${wider ? `; now ${counted(change.after)}, which it was not before` : ""}`;
    }),
  ];
}

/** One row for each name listed twice and each finding nobody has accepted. */
export function problemRows(result: CheckResult): string[] {
  return [
    ...result.repeated.map((name) => `${code(name)} is listed more than once. A client uses the first definition, and this check cannot compare the others, so the server has to list it once.`),
    ...result.problems.map((problem) => `${code(problem.tool)} · ${place(problem.where)}: ${problem.reason} (${problem.severity})`),
  ];
}

/** The low findings, folded away. */
export function noteLines(result: CheckResult, more?: string): string[] {
  return ["<details><summary>" + `${plural(result.notes.length, "lesser note")}, which do not fail the check` + "</summary>", "", ...listOf(result.notes.map((note) => `${code(note.tool)} · ${place(note.where)}: ${note.reason}`), more), "", "</details>", ""];
}

export interface SummaryOptions {
  /** What was checked, in the scanner's words, such as "the local program given" or a host. */
  target: string;
  lockfilePath: string;
  /** What `--update` did, when it was given. */
  update?: "written" | "unchanged" | "refused";
  /** How the server is named on the command line, in the approve example, such as "-- <the same command>". */
  serverArgs?: string;
}

export function describeCheck(result: CheckResult, { target, lockfilePath, update, serverArgs = "-- <the same command>" }: SummaryOptions): string {
  const { diff } = result;
  const lockfile = `\`${lockfileShown(lockfilePath) || "the lockfile"}\``;
  const drift = diff.added.length + diff.removed.length + diff.changed.length;
  const verdict = update === "written" ? "lockfile updated" : update === "refused" ? "lockfile not updated" : result.passed ? "passed" : "failed";
  const lines: string[] = [markerFor(lockfilePath), `## Stackduke MCP tool check: ${verdict}`, ""];

  lines.push(`Compared the ${plural(result.toolCount, "tool")} listed by ${target} with ${result.lockfileFound ? lockfile : `${lockfile}, which ${update === "written" ? "did not exist before" : "does not exist yet"}`}.`);
  if (result.lockfileFound && !drift) lines.push("Every tool matches the lockfile.");
  lines.push("");

  if (drift) {
    lines.push(result.lockfileFound ? "### What changed" : "### Tools found", "");
    const rows = changeRows(diff);
    lines.push(...(result.lockfileFound ? listOf(rows) : listOf(rows.map((row) => row.replace(": added; ", ": ")))), "");
  }

  if (result.problems.length || result.repeated.length || (!result.lockfileFound && update !== "written") || (drift && update !== "written")) {
    lines.push("### What failed", "");
    const rows: string[] = [];
    if (!result.lockfileFound && update !== "written") rows.push(`There is no lockfile at ${lockfile}, so nothing has been approved yet.`);
    else if (drift && update !== "written") rows.push(`${plural(drift, "tool")} differ${drift === 1 ? "s" : ""} from the lockfile, which has not been updated.`);
    rows.push(...problemRows(result));
    lines.push(...listOf(rows), "");
  }

  if (update === "written") {
    lines.push(`${lockfile} now holds the ${plural(result.toolCount, "tool")} listed${result.problems.length ? `, with ${plural(result.problems.length, "finding")} recorded as accepted` : ""}. Commit it with the change that caused it, so reviewers see the tools change in the pull request.`, "");
  } else if (update === "unchanged") {
    lines.push(`${lockfile} already matches. Nothing was written.`, "");
  } else if (!result.passed) {
    lines.push("### How to approve", "");
    if (update === "refused") lines.push(`Nothing was written, because of the ${result.repeated.length ? "problems" : "findings"} above.`, "");
    if (drift || !result.lockfileFound) lines.push(`If a person has reviewed ${result.lockfileFound ? "these changes" : "these tools"} and they are expected, run the same check with \`--update\` and commit ${lockfile}. Reviewers then see each definition, as the server gives it, in the lockfile's diff.`, "");
    if (result.problems.length) lines.push("A finding is fixed in the server. If a person has checked one and it is a false alarm, `--update --accept-findings` records it under that tool's `accepted` in the lockfile, where reviewers can see it. It stays accepted only while the tool's definition stays the same.", "");
    // The flags go before the server: for a program, everything after "--" is handed to it.
    lines.push("Give the flags before the server, as in:", "", "```sh");
    if (drift || !result.lockfileFound) lines.push(`stackduke-mcp-scanner check --update ${serverArgs}`);
    if (result.problems.length) lines.push(`stackduke-mcp-scanner check --update --accept-findings ${serverArgs}`);
    lines.push("```", "");
  }

  if (result.accepted.length) lines.push(`${plural(result.accepted.length, "finding")} recorded as accepted in the lockfile ${result.accepted.length === 1 ? "is" : "are"} still present.`, "");
  if (result.notes.length) {
    lines.push(...noteLines(result));
  }
  lines.push("The check reads the tool list the server gives and never calls a tool. Its text checks are pattern checks: a pass means nothing matched and nothing changed, not that the server is safe.");
  const text = `${lines.join("\n")}\n`;
  if (text.length <= longestSummary) return text;
  return `${text.slice(0, text.lastIndexOf("\n", longestSummary - 200))}\n\n… The summary was cut here to fit in a comment. The lockfile's diff shows every definition.\n`;
}

/** The summary when no tool list could be read. The program's own output is never put in it. */
export function describeUnreachable(target: string, why: string, lockfilePath: string): string {
  return [markerFor(lockfilePath), "## Stackduke MCP tool check: could not run", "", `The tools of ${target} could not be listed: ${confined(why, /[^A-Za-z0-9 ,.()_:-]+/g, 200) || "no reason was given"}.`, "", "The job log may say more. Nothing was compared with the lockfile."].join("\n") + "\n";
}
