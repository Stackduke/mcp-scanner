/**
 * How often the scanner's labels agree with a person's, over a hand-labelled set of tools.
 *
 *   node eval/score.ts [eval/labels-2026-11.jsonl]
 *
 * Reads no network. Each line of the set holds a tool's definition as its server listed it, the
 * label a person gave it from its name, description and arguments, and why. The script labels each
 * tool with the current rules, as the tracker shows them (`assessTool`), and prints precision and
 * recall for each label, with destructive, money and send on their own.
 *
 * Both sides are compared on what the tracker would lead with: the risky labels a tool has
 * (destructive, money, send) if any; otherwise "write" if it changes something; otherwise "read";
 * otherwise "unclear". So "write" here means "changes something, and nothing riskier".
 *
 * The set is drawn evenly across labels and sources, so rare labels get enough tools to measure.
 * That makes the plain share of agreements a share of this set, not of the tracker. The weighted
 * figure counts each tool by how common its cell is among the tracker's tools, as an estimate for
 * the tracker as a whole.
 */
import { readFileSync } from "node:fs";
import { assessTool, type AuthorityBasis, type AuthorityKind } from "../src/authority.ts";
import { fingerprint } from "../src/snapshot.ts";
import type { CapabilityClass, ToolDefinition } from "../src/types.ts";

export type Label = CapabilityClass | "unclear";
export const labels: Label[] = ["read", "write", "destructive", "money", "send", "unclear"];
const risky: Label[] = ["destructive", "money", "send"];

export const cells = ["read/server", "read/words", "write/server", "write/words", "destructive/server", "destructive/words", "money/server", "money/words", "send/server", "send/words", "unclear"] as const;
export type Cell = (typeof cells)[number];

/** The cell a tool was drawn from: the kind the tracker leads with, and what decided it. */
export function cellOf(assessed: { kind: AuthorityKind; basis: AuthorityBasis }): Cell {
  if (assessed.kind === "unclear") return "unclear";
  return `${assessed.kind}/${assessed.basis === "server" ? "server" : "words"}` as Cell;
}

export interface SetEntry {
  id: string;
  /** The endpoint the tool was listed from. */
  server: string;
  takenOn: string;
  tool: ToolDefinition;
  /** The cell it was drawn from, under the rules on the day it was drawn. */
  sampledAs: Cell;
  /** What a person says the tool does. Empty until labelled. */
  expected: Label[];
  /** Why, in one line. */
  reason: string;
  /** Set when the person was unsure: what makes it arguable. */
  doubt?: string;
}

/** The labels a tool is compared on: its risky ones, or else write, or else read, or else unclear. */
export function leading(classes: readonly Label[]): Label[] {
  const found = risky.filter((label) => classes.includes(label));
  if (found.length) return found;
  for (const label of ["write", "read"] as Label[]) if (classes.includes(label)) return [label];
  return ["unclear"];
}

const same = (a: Label[], b: Label[]) => a.length === b.length && a.every((label) => b.includes(label));

export interface Row { entry: SetEntry; predicted: Label[]; expected: Label[]; basis: AuthorityBasis; right: boolean; weight: number }

/** A share with its 95% interval, and how many tools it rests on. */
export interface Share { value: number | null; low: number; high: number; tools: number }
export interface LabelScore { label: Label; truePositives: number; falsePositives: number; falseNegatives: number; precision: Share; recall: Share }
export interface Score {
  size: number;
  right: number;
  /** True when each tool is counted by how common its cell is in the tracker. */
  weighted: boolean;
  /** Agreement over every tool, weighted when weights are given. */
  agreement: Share;
  /** Agreement over this set, every tool counted once. */
  inThisSet: Share;
  /** Share of tools the scanner gives a label at all, rather than "unclear". */
  labelled: Share;
  /** Agreement over the tools the scanner gives a label. */
  agreementWhenLabelled: Share;
  byLabel: LabelScore[];
  bySource: Array<{ source: string; size: number; right: number }>;
  /** Tools that change something, labelled as reading only: the miss that hides what a review is for. */
  actingShownAsRead: Row[];
  /** Tools a person said were risky, missing that risky label. */
  riskyMissed: Row[];
  wrong: Row[];
}

/** A 95% Wilson interval for a share, which stays sensible near 0 and 1 and for small sets. */
export function wilson(right: number, size: number): [number, number] {
  if (size <= 0) return [0, 1];
  const z = 1.96, p = right / size, z2 = z * z;
  const centre = (p + z2 / (2 * size)) / (1 + z2 / size);
  const half = (z * Math.sqrt((p * (1 - p)) / size + z2 / (4 * size * size))) / (1 + z2 / size);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * The weighted share of `among` that is also `counted`. Uneven weights carry less information than as
 * many even ones, so the interval uses Kish's effective size: (sum of weights)^2 / sum of squares.
 */
function shareOf(rows: Row[], among: (row: Row) => boolean, counted: (row: Row) => boolean): Share {
  const base = rows.filter(among);
  const sum = base.reduce((total, row) => total + row.weight, 0);
  if (!base.length || sum <= 0) return { value: null, low: 0, high: 1, tools: base.length };
  const value = base.filter(counted).reduce((total, row) => total + row.weight, 0) / sum;
  const effective = (sum * sum) / base.reduce((total, row) => total + row.weight ** 2, 0);
  const [low, high] = wilson(value * effective, effective);
  return { value, low, high, tools: base.length };
}

export interface Weights {
  /** How many tools the tracker counts under each kind. */
  kindCountsInTracker: Partial<Record<AuthorityKind, number>>;
  /** Among all tools listed while drawing the set, how many fell in each cell: used to split each kind by source. */
  toolsSeenByCell: Partial<Record<Cell, number>>;
}

/** Each cell's share of the tracker's tools: the kind's share, split by source as seen while drawing. */
function cellShares(weights: Weights): Map<Cell, number> {
  const total = Object.values(weights.kindCountsInTracker).reduce((sum, count) => sum + (count ?? 0), 0);
  const shares = new Map<Cell, number>();
  for (const cell of cells) {
    const kind = cell.split("/")[0] as AuthorityKind;
    const kindShare = (weights.kindCountsInTracker[kind] ?? 0) / total;
    if (cell === "unclear") { shares.set(cell, kindShare); continue; }
    const server = weights.toolsSeenByCell[`${kind}/server` as Cell] ?? 0, byWords = weights.toolsSeenByCell[`${kind}/words` as Cell] ?? 0;
    const seen = server + byWords;
    shares.set(cell, seen ? kindShare * ((cell.endsWith("/server") ? server : byWords) / seen) : kindShare / 2);
  }
  return shares;
}

export function score(entries: SetEntry[], weights?: Weights): Score {
  const shares = weights ? cellShares(weights) : null;
  const inCell = new Map<Cell, number>();
  for (const entry of entries) inCell.set(entry.sampledAs, (inCell.get(entry.sampledAs) ?? 0) + 1);
  const rows: Row[] = entries.map((entry) => {
    const assessed = assessTool({ ...entry.tool, hash: fingerprint(entry.tool) }).tool;
    const predicted = leading(assessed.does);
    const expected = leading(entry.expected);
    const weight = shares ? (shares.get(entry.sampledAs) ?? 0) / (inCell.get(entry.sampledAs) ?? 1) : 1;
    return { entry, predicted, expected, basis: assessed.basis, right: same(predicted, expected), weight };
  });
  const byLabel = labels.filter((label) => label !== "unclear").map((label): LabelScore => {
    const predicts = (row: Row) => row.predicted.includes(label), expects = (row: Row) => row.expected.includes(label);
    return {
      label,
      truePositives: rows.filter((row) => predicts(row) && expects(row)).length,
      falsePositives: rows.filter((row) => predicts(row) && !expects(row)).length,
      falseNegatives: rows.filter((row) => !predicts(row) && expects(row)).length,
      precision: shareOf(rows, predicts, expects),
      recall: shareOf(rows, expects, predicts),
    };
  });
  const sourceName: Record<AuthorityBasis, string> = { server: "server's annotations", name: "words in the name", description: "words in the description", none: "nothing to go on" };
  const bySource = (Object.keys(sourceName) as AuthorityBasis[]).map((basis) => {
    const of = rows.filter((row) => row.basis === basis);
    return { source: sourceName[basis], size: of.length, right: of.filter((row) => row.right).length };
  }).filter((group) => group.size);
  const all = () => true, right = (row: Row) => row.right, gaveLabel = (row: Row) => !row.predicted.includes("unclear");
  const acts = (set: Label[]) => !set.includes("read") && !set.includes("unclear");
  const [low, high] = wilson(rows.filter(right).length, rows.length);
  return {
    size: rows.length,
    right: rows.filter(right).length,
    weighted: shares !== null,
    agreement: shareOf(rows, all, right),
    inThisSet: { value: rows.length ? rows.filter(right).length / rows.length : null, low, high, tools: rows.length },
    labelled: shareOf(rows, all, gaveLabel),
    agreementWhenLabelled: shareOf(rows, gaveLabel, right),
    byLabel,
    bySource,
    actingShownAsRead: rows.filter((row) => acts(row.expected) && row.predicted.includes("read")),
    riskyMissed: rows.filter((row) => row.expected.some((label) => risky.includes(label) && !row.predicted.includes(label))),
    wrong: rows.filter((row) => !row.right),
  };
}

export function readSet(text: string): SetEntry[] {
  return text.split("\n").filter((line) => line.trim()).map((line, index) => {
    const entry = JSON.parse(line) as SetEntry;
    if (typeof entry.tool?.name !== "string") throw new Error(`line ${index + 1}: no tool name`);
    if (!Array.isArray(entry.expected) || !entry.expected.length || !entry.expected.every((label) => labels.includes(label))) throw new Error(`line ${index + 1} (${entry.id}): expected must be a list of ${labels.join(", ")}`);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error(`line ${index + 1} (${entry.id}): no reason given`);
    return entry;
  });
}

const percent = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);
const withRange = (share: Share) => (share.value === null ? "-" : `${percent(share.value)} (${percent(share.low)} to ${percent(share.high)})`);

export function describe(result: Score): string {
  const lines: string[] = [];
  const how = result.weighted ? "weighted to how common each label and source is in the tracker" : "every tool counted once";
  lines.push(`Tools: ${result.size}. Shares are ${how}; 95% intervals in brackets.`);
  lines.push("");
  lines.push(`Scanner agrees with the hand label:        ${withRange(result.agreement)}`);
  lines.push(`Scanner gives a label (not "unclear"):     ${withRange(result.labelled)}`);
  lines.push(`Agrees, where it gives a label:            ${withRange(result.agreementWhenLabelled)}`);
  if (result.weighted) lines.push(`In this set, every tool counted once:      ${result.right} of ${result.size} agree, ${withRange(result.inThisSet)}`);
  const header = "Label         Precision          Recall             Counts in this set: right / scanner says / hand says";
  const row = (score: LabelScore) => `${score.label.padEnd(13)} ${withRange(score.precision).padEnd(18)} ${withRange(score.recall).padEnd(18)} ${score.truePositives} / ${score.truePositives + score.falsePositives} / ${score.truePositives + score.falseNegatives}`;
  lines.push("", header);
  for (const score of result.byLabel.filter((item) => !risky.includes(item.label))) lines.push(row(score));
  lines.push("", "Risky labels");
  for (const score of result.byLabel.filter((item) => risky.includes(item.label))) lines.push(row(score));
  if (result.weighted) lines.push("", "Recall for a rare label rests on the few tools of that kind found among the common ones, so its interval is wide.");
  lines.push("", "By what the label rests on (this set, every tool counted once)");
  for (const group of result.bySource) lines.push(`  ${group.source.padEnd(26)} ${String(group.right).padStart(3)} of ${String(group.size).padStart(3)} agree (${percent(group.right / group.size)})`);
  const list = (rows: Row[], why = false) => rows.map((item) => `  ${item.entry.id} ${item.entry.tool.name}: scanner ${item.predicted.join("+")}, hand ${item.expected.join("+")}${why ? ` (${item.entry.reason})` : ""}`);
  lines.push("", `Tools that change something, labelled read: ${result.actingShownAsRead.length}`, ...list(result.actingShownAsRead));
  lines.push("", `Risky labels missed: ${result.riskyMissed.length}`, ...list(result.riskyMissed));
  lines.push("", `All disagreements: ${result.wrong.length}`, ...list(result.wrong, true));
  return lines.join("\n");
}

if (import.meta.main) {
  const path = process.argv[2] ?? new URL("labels-2026-11.jsonl", import.meta.url).pathname;
  const entries = readSet(readFileSync(path, "utf8"));
  let weights: Weights | undefined;
  try { weights = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8")) as Weights; } catch { weights = undefined; }
  console.log(describe(score(entries, weights)));
}
