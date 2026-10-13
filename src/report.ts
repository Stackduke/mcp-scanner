import type { ChangedField, FieldChange, SnapshotDiff } from "./diff.ts";
import { findInTool } from "./findings.ts";
import { labelTool } from "./risk.ts";
import { toolKey } from "./snapshot.ts";
import { printable } from "./text.ts";
import type { CapabilityClass, CapabilityLabel, Finding, Snapshot, SnapshotTool } from "./types.ts";

/**
 * Plain-text reports. Tool names, server names and descriptions come from the server and are
 * untrusted, so every one of them passes through `printable` before it is written out.
 */
const classNames: Record<CapabilityClass, string> = { read: "Read", write: "Write", send: "Send", money: "Money", destructive: "Destructive" };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const kinds = (label: CapabilityLabel) => (label.classes.length ? label.classes.map((kind) => classNames[kind]).join(" + ") : "Unlabelled") + (label.broad ? " (broad)" : "");
const keyOf = (tool: SnapshotTool) => printable(toolKey(tool), 90);
const mostListed = 40;

function describeFinding(toolName: string, finding: Finding): string[] {
  return [`  [${finding.severity}] ${printable(toolName, 90)} · ${printable(finding.where, 90)}`, `      ${finding.reason}`, `      "${printable(finding.excerpt, 220)}"`];
}

/** A plain-text summary of one snapshot: what the server offers, labelled, with anything worth a look. */
export function describeSnapshot(snapshot: Snapshot): string {
  const lines: string[] = [];
  const labelled = snapshot.tools.map((tool) => ({ tool, label: labelTool(tool), findings: findInTool(tool) }));
  const count = (kind: CapabilityClass) => labelled.filter(({ label }) => label.classes.includes(kind)).length;
  const source = printable(snapshot.source, 160);

  lines.push(`${printable(snapshot.server?.name ?? snapshot.source, 120)}${snapshot.server?.version ? ` ${printable(snapshot.server.version, 40)}` : ""}`);
  lines.push(`${plural(snapshot.tools.length, "tool")} listed from ${source} at ${printable(snapshot.takenAt, 40)}`);
  lines.push("");
  lines.push(`Can change things: ${labelled.filter(({ label }) => label.classes.some((kind) => kind !== "read")).length}   Destructive: ${count("destructive")}   Money: ${count("money")}   Send: ${count("send")}   Read only: ${labelled.filter(({ label }) => label.classes.length === 1 && label.classes[0] === "read").length}   Unlabelled: ${labelled.filter(({ label }) => !label.classes.length).length}`);
  lines.push(`Labels from the server's own annotations: ${labelled.filter(({ label }) => label.source === "mcp_annotation").length}   guessed from names or descriptions: ${labelled.filter(({ label }) => label.source === "aethis_heuristic").length}`);
  lines.push("");
  for (const { tool, label } of labelled) {
    const guessed = label.source === "aethis_heuristic";
    lines.push(`  ${keyOf(tool).padEnd(44)} ${kinds(label)}${guessed ? ` *  from ${printable(label.basis.join(", "), 80)}` : ""}`);
  }
  if (labelled.some(({ label }) => label.source === "aethis_heuristic")) lines.push("", "  * a guess from the words shown; the server gave no annotation.");

  const flagged = labelled.filter(({ findings }) => findings.length);
  lines.push("", flagged.length ? `Worth a look: ${plural(flagged.reduce((sum, { findings }) => sum + findings.length, 0), "finding")} in ${plural(flagged.length, "tool")}` : "Nothing matched the text checks. That means no pattern fired, not that the server is safe.");
  for (const { tool, findings } of flagged) for (const finding of findings) lines.push(...describeFinding(toolKey(tool), finding));
  return lines.join("\n");
}

const howWords: Record<FieldChange, string> = { added: "added", removed: "removed", altered: "rewritten" };

/** A plain-text summary of what changed between two snapshots. */
export function describeDiff(diff: SnapshotDiff): string {
  const lines: string[] = [];
  lines.push(`${printable(diff.from.source, 120)} (${plural(diff.from.tools, "definition")})  →  ${printable(diff.to.source, 120)} (${plural(diff.to.tools, "definition")})`);
  lines.push(`Added ${diff.added.length}   Removed ${diff.removed.length}   Changed ${diff.changed.length}   Unchanged ${diff.unchanged}`);
  if (diff.addedToExistingTools.length) lines.push(`${diff.addedToExistingTools.length} of the added definitions are new variants of tools that already existed.`);

  // "Changed" covers very different things: a field that appeared is not a description that was rewritten.
  const tally = new Map<string, number>();
  for (const change of diff.changed) for (const field of change.fields) { const key = `${field} ${howWords[change.how[field] ?? "altered"]}`; tally.set(key, (tally.get(key) ?? 0) + 1); }
  if (tally.size) lines.push(`What changed: ${[...tally].sort((a, b) => b[1] - a[1]).map(([what, count]) => `${what} in ${count}`).join(", ")}`);
  const onlyGained = diff.changed.filter((change) => change.fields.every((field) => change.how[field] === "added"));
  if (onlyGained.length) lines.push(`${onlyGained.length} of the ${diff.changed.length} changed definitions only gained a field they did not have before; nothing in them was rewritten.`);

  const section = (title: string, rows: string[]) => {
    if (!rows.length) return;
    lines.push("", `${title}:`, ...rows.slice(0, mostListed).map((row) => `  ${row}`));
    if (rows.length > mostListed) lines.push(`  … and ${rows.length - mostListed} more`);
  };
  section("Added", diff.added.map((tool) => `${keyOf(tool)}  (${kinds(labelTool(tool))})`));
  section("Removed", diff.removed.map((tool) => `${keyOf(tool)}  (${kinds(labelTool(tool))})`));

  // A capability that grew is the change a reviewer most needs to see.
  const grew = diff.changed.flatMap((change) => {
    const before = labelTool(change.before), after = labelTool(change.after);
    const gained = after.classes.filter((kind) => kind !== "read" && !before.classes.includes(kind));
    return gained.length || (after.broad && !before.broad) ? [`${printable(change.name, 90)}: was ${kinds(before)}, now ${kinds(after)}`] : [];
  });
  section("Changed in a way that widens what the tool can do", grew);

  const rewritten = diff.changed.filter((change) => change.fields.some((field) => change.how[field] !== "added"));
  section("Changed, with something rewritten or removed", rewritten.map((change) => `${printable(change.name, 90)}: ${change.fields.map((field: ChangedField) => `${field} ${howWords[change.how[field] ?? "altered"]}`).join(", ")}`));

  // The words a model reads are the part a person can and should check by eye.
  const reworded = diff.changed.filter((change) => change.how.description === "altered");
  if (reworded.length) {
    lines.push("", "Descriptions that were rewritten:");
    for (const change of reworded.slice(0, mostListed)) {
      lines.push(`  ${printable(change.name, 90)}`, `      before: "${printable(change.before.description ?? "", 240)}"`, `      after:  "${printable(change.after.description ?? "", 240)}"`);
    }
    if (reworded.length > mostListed) lines.push(`  … and ${reworded.length - mostListed} more`);
  }

  const newFindings = diff.changed.flatMap((change) => {
    const before = new Set(findInTool(change.before).map((finding) => `${finding.rule}@${finding.where}`));
    return findInTool(change.after).filter((finding) => !before.has(`${finding.rule}@${finding.where}`)).flatMap((finding) => describeFinding(change.name, finding));
  });
  if (newFindings.length) lines.push("", "New text findings in changed tools:", ...newFindings);
  const addedFindings = diff.added.flatMap((tool) => findInTool(tool).flatMap((finding) => describeFinding(toolKey(tool), finding)));
  if (addedFindings.length) lines.push("", "Text findings in added tools:", ...addedFindings);
  return lines.join("\n");
}
