import { assessTool, authorityOf, canDo, day, opening, plural, sentenceList, shownSource } from "./authority.ts";
import type { AuthorityKind, ToolAssessment } from "./authority.ts";
import { canonical, toolKey } from "./snapshot.ts";
import type { Snapshot, SnapshotTool } from "./types.ts";

/**
 * The period on the servers being watched, for a reader who is not an engineer.
 *
 * The digest must never make a period look quieter than the saved scans show. So:
 * - every scan in the period is read, not only the first and last. What a tool could do at its
 *   most, and every reason to look at it, counts even if it is gone by the latest scan;
 * - "no difference" is said only of scans that were read, and names them;
 * - a period with too few scans, a long stretch without one, or a scan that could not be read is
 *   reported as not fully covered and never as quiet.
 *
 * It follows the authority report's rules. A tool is read the more serious way at every scan.
 * Nothing here says a server is safe. A server's words appear only as tool-name identifiers; its
 * descriptions are never quoted, so a rewritten description is reported as a fact about the tool.
 */
export interface Period { from: Date; until: Date }

export interface ToolNote { name: string; note: string; /** A person should read this one first. */ pressing: boolean; rank: number }

export interface ServerPeriod {
  source: string;
  /** Scans inside the period that could be read. */
  scans: number;
  /** Saved scans for this server that could not be read, and so are not in any statement here. */
  unreadable: number;
  /** The two scans the period runs between: the last one before it, or the first in it, and the latest. */
  from: string | null;
  to: string | null;
  /** Scans read between those two. */
  between: number;
  latest: string;
  /** The longest stretch of the period with no scan in it. */
  gap: { hours: number; from: string; to: string };
  /** Two scans or more to compare, no long stretch without one, and none unreadable. */
  covered: boolean;
  added: ToolNote[];
  removed: ToolNote[];
  /** Counted as doing more at some scan in the period than at its start. */
  widened: ToolNote[];
  /** Counted as doing less at the end than at the start, with nothing more in between. */
  narrowed: ToolNote[];
  /** Wording rewritten, with no change at any scan in what the tool is counted as doing. */
  reworded: string[];
  /** The server's labels changed, with no change in what the tool is counted as doing. */
  relabelled: string[];
  /** Inputs or outputs changed and nothing else. */
  otherChanged: string[];
  /** Listed at some scan in the period, and at neither end of it. */
  cameAndWent: ToolNote[];
  /** The same at both ends, and different or missing in between. */
  changedAndBack: ToolNote[];
  /** Reasons to look at a tool that were not there at the start, from any scan in the period. */
  newConcerns: Array<{ tool: string; lasting: string[]; passing: string[]; weight: number }>;
  /** Where the server stands at the latest scan, as the authority report puts it. */
  standing: string[];
  tools: number;
}

const acting = ["money", "destructive", "send", "write"] as const;
type Acting = (typeof acting)[number];
const seriousFirst: AuthorityKind[] = ["money", "destructive", "send", "write", "unclear", "read"];
/** Counted as doing this. A tool that can destroy has changed something, so it counts as writing too. */
const has = (assessed: ToolAssessment, kind: Acting) => assessed.tool.does.includes(kind) || (kind === "write" && assessed.tool.does.includes("destructive"));
const acts = (assessed: ToolAssessment) => acting.some((kind) => has(assessed, kind));
const placed: Record<AuthorityKind, string> = {
  money: "can move or spend money",
  destructive: "can make changes that cannot be undone",
  send: "can send messages or publish to other people",
  write: "can create or change things",
  unclear: "not clear what it does",
  read: "said to only read",
};
const freeForm = "take free-form input such as SQL or a shell command";
/** A tool's place, in a few words: the most serious thing first, then the rest. */
function standingOf(assessed: ToolAssessment): string {
  const also = acting.filter((kind) => kind !== assessed.tool.kind && kind !== "write" && assessed.tool.does.includes(kind)).map((kind) => canDo[kind]);
  return `${placed[assessed.tool.kind]}${also.length ? `, and can ${sentenceList(also)}` : ""}${assessed.tool.broad ? ", and takes free-form input" : ""}${assessed.tool.onTrust ? ", on the server's word alone" : ""}`;
}
const rankOf = (assessed: ToolAssessment) => seriousFirst.indexOf(assessed.tool.kind);
const wording = (tool: SnapshotTool) => canonical([tool.title ?? null, tool.description ?? null, tool.annotations?.title ?? null]);
const labels = (tool: SnapshotTool) => { const { title: _title, ...rest } = tool.annotations ?? {}; return canonical(rest); };

const longGapHours = 36;

/** One server's period, from its saved scans in any order. Null when it has no scan up to the end of the period. */
export function periodOf(snapshots: Snapshot[], period: Period, unreadable = 0): ServerPeriod | null {
  const dated = snapshots
    .map((snapshot) => ({ snapshot, at: new Date(snapshot.takenAt).getTime() }))
    .filter(({ at }) => !Number.isNaN(at) && at <= period.until.getTime())
    .sort((a, b) => a.at - b.at);
  const latest = dated.at(-1);
  if (!latest) return null;
  const inside = dated.filter(({ at }) => at >= period.from.getTime());
  // The series starts from the last scan before the period when there is one, so a change made
  // between that scan and the period's first is not missed.
  const startAt = (dated.filter(({ at }) => at < period.from.getTime()).at(-1) ?? inside[0])?.at ?? latest.at;
  const series = dated.filter(({ at }) => at >= startAt);

  // The longest stretch of the period in which nothing was looked at.
  const marks = [period.from.getTime(), ...inside.map(({ at }) => at), period.until.getTime()];
  let gap = { hours: 0, from: period.from.toISOString(), to: period.until.toISOString() };
  for (let index = 1; index < marks.length; index += 1) {
    const hours = ((marks[index] as number) - (marks[index - 1] as number)) / 3_600_000;
    if (hours > gap.hours) gap = { hours, from: new Date(marks[index - 1] as number).toISOString(), to: new Date(marks[index] as number).toISOString() };
  }

  const result: ServerPeriod = {
    source: shownSource(latest.snapshot.source),
    scans: inside.length, unreadable,
    from: null, to: null, between: 0, latest: latest.snapshot.takenAt, gap,
    covered: false,
    added: [], removed: [], widened: [], narrowed: [], reworded: [], relabelled: [], otherChanged: [], cameAndWent: [], changedAndBack: [], newConcerns: [],
    standing: opening(authorityOf(latest.snapshot)),
    tools: latest.snapshot.tools.length,
  };
  if (series.length < 2) return result;
  result.from = (series[0] as (typeof series)[number]).snapshot.takenAt;
  result.to = latest.snapshot.takenAt;
  result.between = series.length - 2;
  result.covered = gap.hours <= longGapHours && unreadable === 0;

  const states = series.map(({ snapshot }) => new Map(snapshot.tools.map((tool) => [toolKey(tool), tool] as const)));
  const assessed = new Map<string, ToolAssessment>();
  const assess = (tool: SnapshotTool) => { const known = assessed.get(tool.hash) ?? assessTool(tool); assessed.set(tool.hash, known); return known; };

  for (const key of new Set(states.flatMap((state) => [...state.keys()]))) {
    const timeline = states.map((state) => state.get(key));
    const startTool = timeline[0], endTool = timeline.at(-1);
    if (startTool && timeline.every((tool) => tool?.hash === startTool.hash)) continue;
    const start = startTool ? assess(startTool) : null, end = endTool ? assess(endTool) : null;
    // Every state the tool was in after the start. What it could do at its most is what counts.
    const later = timeline.slice(1).flatMap((tool) => (tool ? [assess(tool)] : []));
    const name = (end ?? later.at(-1) ?? start)?.tool.name ?? "(no name)";
    const reached = acting.filter((kind) => later.some((state) => has(state, kind)) && !(start && has(start, kind)));
    const lasting = reached.filter((kind) => end && has(end, kind)), passing = reached.filter((kind) => !(end && has(end, kind)));
    const could = (kinds: readonly Acting[]) => sentenceList(kinds.filter((kind) => !(kind === "write" && kinds.includes("destructive"))).map((kind) => canDo[kind]));

    // New reasons to look, from any scan. One that has gone by the latest scan is still reported.
    const known = new Set(start?.reasons ?? []);
    const fresh = [...new Set(later.flatMap((state) => state.reasons))].filter((reason) => !known.has(reason));
    if (fresh.length) result.newConcerns.push({ tool: name, lasting: fresh.filter((reason) => end?.reasons.includes(reason)), passing: fresh.filter((reason) => !end?.reasons.includes(reason)), weight: Math.min(...later.filter((state) => state.reasons.some((reason) => !known.has(reason))).map((state) => state.weight)) });

    if (!start && end) {
      result.added.push({ name, note: `${standingOf(end)}${passing.length ? `. During the period it could also ${could(passing)}` : ""}`, pressing: end.tool.kind !== "read" || end.tool.broad || end.tool.onTrust || passing.length > 0, rank: rankOf(end) });
    } else if (!start && !end) {
      const most = [...later].sort((a, b) => rankOf(a) - rankOf(b))[0];
      if (most) result.cameAndWent.push({ name, note: standingOf(most), pressing: true, rank: rankOf(most) });
    } else if (start && !end) {
      result.removed.push({ name, note: reached.length ? `before it went, it could ${could(reached)}, which it could not at the start` : "", pressing: reached.length > 0, rank: rankOf(start) });
    } else if (start && end && startTool && endTool) {
      const more: string[] = [];
      if (lasting.length) more.push(`can now ${could(lasting)}`);
      if (passing.length) more.push(`could ${could(passing)} during the period, which the latest scan no longer shows`);
      if (!start.tool.broad && later.some((state) => state.tool.broad)) more.push(end.tool.broad ? `can now ${freeForm}` : `could ${freeForm} during the period`);
      if (start.tool.kind !== "unclear" && later.some((state) => state.tool.kind === "unclear")) more.push(end.tool.kind === "unclear" ? `was listed as "${placed[start.tool.kind]}", and it is now not clear what it does` : "was, for part of the period, a tool whose purpose was not clear");
      if (acts(start) && !start.tool.undoUnstated && end.tool.undoUnstated) more.push("is no longer said by its server to make changes that can be undone");
      const rewritten = wording(startTool) !== wording(endTool);
      const lost = acting.filter((kind) => has(start, kind) && !has(end, kind));
      const less = lost.length ? `is no longer counted as able to ${could(lost)}`
        : start.tool.kind !== end.tool.kind && end.tool.kind !== "unclear" && !lasting.length ? `was listed as "${placed[start.tool.kind]}" and is now "${placed[end.tool.kind]}"`
        : start.tool.broad && !end.tool.broad ? "no longer appears to take free-form input" : "";
      const also = rewritten ? " Its wording was rewritten too." : "";
      if (more.length) result.widened.push({ name, note: `${sentenceList(more)}.${less ? ` It ${less}.` : ""}${also}`, pressing: true, rank: Math.min(rankOf(end), ...later.map(rankOf)) });
      else if (endTool.hash === startTool.hash) {
        const away = timeline.filter((tool) => !tool).length, differing = timeline.filter((tool) => tool && tool.hash !== startTool.hash).length;
        result.changedAndBack.push({ name, note: [away ? `missing from ${plural(away, "scan")}` : "", differing ? `different in ${plural(differing, "scan")}` : ""].filter(Boolean).join(" and "), pressing: true, rank: rankOf(end) });
      } else if (less) result.narrowed.push({ name, note: `${less}, going by its label, name and description.${also}`, pressing: false, rank: rankOf(start) });
      else if (rewritten) result.reworded.push(name);
      else if (labels(startTool) !== labels(endTool)) result.relabelled.push(name);
      else result.otherChanged.push(name);
    }
  }
  // The tools a reader most needs to see come first in every list, so a long one cannot bury them.
  const order = (a: ToolNote, b: ToolNote) => Number(b.pressing) - Number(a.pressing) || a.rank - b.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const list of [result.added, result.removed, result.widened, result.narrowed, result.cameAndWent, result.changedAndBack]) list.sort(order);
  // Planted text and overruled labels before notes, whether or not they lasted to the latest scan.
  result.newConcerns.sort((a, b) => a.weight - b.weight || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
  for (const list of [result.reworded, result.relabelled, result.otherChanged]) list.sort();
  return result;
}

const quiet = (server: ServerPeriod) => !server.added.length && !server.removed.length && !server.widened.length && !server.narrowed.length && !server.reworded.length && !server.relabelled.length && !server.otherChanged.length && !server.cameAndWent.length && !server.changedAndBack.length;
/** Something a person should read before the rest. */
const pressing = (server: ServerPeriod) => server.newConcerns.length > 0 || [server.added, server.removed, server.widened, server.cameAndWent, server.changedAndBack].some((list) => list.some((tool) => tool.pressing));
const compared = (server: ServerPeriod) => server.from !== null && server.to !== null;

const mostShown = 500;
const leastImportantShown = 12;
const cut = (items: string[], most: number) => (items.length > most ? `${items.slice(0, most).join(", ")} and ${items.length - most} more` : items.join(", "));
const stretch = (hours: number) => (hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`);
const clock = (moment: string) => `${day(moment)} at ${new Date(moment).toISOString().slice(11, 16)}`;
/** Two moments as a reader would say them: the days, with the time of day only when both fall on one day. */
const pair = (from: string, to: string): [string, string] => (day(from) !== day(to) ? [day(from), day(to)] : [clock(from), clock(to)]);
/** "7 to 13 October 2026" when the month is shared, and both dates in full otherwise. */
function span(period: Period): string {
  const from = day(period.from.toISOString()), until = day(period.until.toISOString());
  const [fromDay, fromMonth, fromYear] = from.split(" "), [, untilMonth, untilYear] = until.split(" ");
  return fromMonth === untilMonth && fromYear === untilYear ? (from === until ? until : `${fromDay} to ${until}`) : `${from} to ${until}`;
}

function describeServer(server: ServerPeriod): string[] {
  const lines: string[] = [server.source];
  const scans = server.scans ? `${plural(server.scans, "scan")} in this period` : "No scan in this period";
  if (!server.from || !server.to) {
    lines.push(`  ${scans}${server.scans ? ", and no earlier one to compare with" : ""}, so nothing can be said about what changed.`);
  } else {
    const [from, to] = pair(server.from, server.to);
    lines.push(`  ${scans}. Compared: the scan on ${from} with the scan on ${to}${server.between ? `, and the ${plural(server.between, "scan")} between them` : ""}.`);
    if (quiet(server)) lines.push(`  No difference between ${server.between ? "any of those scans" : "those two scans"}.`);
    else {
      const group = (title: string, tools: ToolNote[]) => {
        if (!tools.length) return;
        lines.push(`  ${title}`);
        for (const tool of tools.slice(0, mostShown)) lines.push(`    - ${tool.name}${tool.note ? `: ${tool.note}` : ""}`);
        if (tools.length > mostShown) lines.push(`    … and ${tools.length - mostShown} more`);
      };
      const one = (count: number, single: string, several: string) => (count === 1 ? single : several);
      group(`${plural(server.widened.length, "tool")} could do more than at the start:`, server.widened);
      group(`${plural(server.cameAndWent.length, "tool")} ${one(server.cameAndWent.length, "was", "were")} listed during the period and gone again by the end:`, server.cameAndWent);
      group(`${plural(server.changedAndBack.length, "tool")} ${one(server.changedAndBack.length, "was", "were")} changed or removed during the period and put back by the end:`, server.changedAndBack);
      group(`${plural(server.added.length, "tool")} added:`, server.added);
      group(`${plural(server.removed.length, "tool")} removed:`, server.removed);
      if (server.reworded.length) lines.push(`  The words an AI model reads were rewritten in ${plural(server.reworded.length, "tool")}: ${cut(server.reworded, mostShown)}`, `    What ${one(server.reworded.length, "it is", "each is")} counted as doing did not change at any scan. The new wording is not shown here; compare it in the technical report.`);
      if (server.relabelled.length) lines.push(`  The server's own labels changed on ${plural(server.relabelled.length, "tool")}, without changing what ${one(server.relabelled.length, "it is", "each is")} counted as doing: ${cut(server.relabelled, mostShown)}`);
      group(`${plural(server.narrowed.length, "tool")} ${one(server.narrowed.length, "is", "are")} counted as doing less than at the start:`, server.narrowed);
      if (server.otherChanged.length) lines.push(`  ${plural(server.otherChanged.length, "tool")} changed in inputs or outputs only, which includes the notes on them that a model reads: ${cut(server.otherChanged, leastImportantShown)}`);
    }
    if (server.newConcerns.length) {
      lines.push("  New in this period, worth a person's look:");
      for (const concern of server.newConcerns.slice(0, mostShown)) {
        lines.push(`    - ${concern.tool}: ${[concern.lasting.join(" "), concern.passing.length ? `Seen during the period and gone by the latest scan: ${concern.passing.join(" ")}` : ""].filter(Boolean).join(" ")}`);
      }
      if (server.newConcerns.length > mostShown) lines.push(`    … and ${plural(server.newConcerns.length - mostShown, "more tool")}`);
    }
  }
  // What the statements above do not cover.
  if (server.unreadable) lines.push(`  ${plural(server.unreadable, "saved scan")} for this server could not be read. Nothing above covers ${server.unreadable === 1 ? "it" : "them"}.`);
  if (server.gap.hours > longGapHours) lines.push(`  No scan for ${stretch(server.gap.hours)}, from ${clock(server.gap.from)} to ${clock(server.gap.to)}. A change made and undone in that time would not be seen.`);
  lines.push(`  Where it stands at the latest scan, with ${plural(server.tools, "tool")} listed: ${server.standing.join(" ") || "no tools were listed, so nothing can be said."}`);
  return lines;
}

/** The digest as an email's subject and plain-text body. `stray` counts unreadable scans that belong to no known server. */
export function describeDigest(servers: ServerPeriod[], period: Period, stray = 0): { subject: string; text: string } {
  const when = span(period);
  const changed = servers.filter((server) => compared(server) && !quiet(server));
  const look = servers.filter(pressing), uncovered = servers.filter((server) => !server.covered);
  const all = plural(servers.length, "server");
  const verb = (count: number, single: string, several: string) => (count === 1 ? single : several);
  const main = !servers.length ? "no scans to report"
    : look.length ? `${look.length} of ${all} ${verb(look.length, "needs", "need")} a look`
    : changed.length ? `${changed.length} of ${all} changed`
    : uncovered.length ? "" : `no change seen on ${all}`;
  const gaps = !uncovered.length ? "" : main ? `${uncovered.length} not fully covered` : `${uncovered.length} of ${all} not fully covered`;
  const subject = `Aethis weekly digest: ${[main, gaps].filter(Boolean).join(", ")} (${when})`;

  const lines: string[] = [`Aethis weekly digest, ${when}`, ""];
  if (!servers.length) lines.push("There were no scans to report on.");
  else {
    const anyCompared = servers.some(compared);
    lines.push([
      `${all} watched.`,
      !anyCompared ? "Nothing could be compared." : changed.length ? `${changed.length} changed${look.length ? `, and ${look.length} ${verb(look.length, "needs", "need")} a look` : ""}.` : look.length ? `${look.length} ${verb(look.length, "needs", "need")} a look.` : "No change seen in the scans that were compared.",
      uncovered.length ? `${uncovered.length} ${verb(uncovered.length, "was", "were")} not fully covered, so a quiet result there means less.` : "",
    ].filter(Boolean).join(" "));
    // The servers a reader most needs to see come first.
    const order = (server: ServerPeriod) => (pressing(server) ? 0 : compared(server) && !quiet(server) ? 1 : !server.covered ? 2 : 3);
    for (const server of [...servers].sort((a, b) => order(a) - order(b))) lines.push("", ...describeServer(server));
  }
  if (stray) lines.push("", `${plural(stray, "saved scan")} could not be read or matched to a server, and ${stray === 1 ? "was" : "were"} left out.`);
  lines.push(
    "",
    "About this digest:",
    "  - A scan sees a server's list of tools at one moment. A change made and undone between two scans is not seen.",
    "  - It compares what servers offer. It does not say a server is safe, and it is not what your policy allows.",
    "  - Each tool is read the more serious way across its label, its name and its description, at every scan. Labels are the server's own and have not been tested.",
    "  - Only the first sentence of a description is read for what a tool does. The rest, and the notes on a tool's inputs, are checked for planted instructions and not for actions.",
    "  - A different login can be shown different tools, so scans made with different logins will look like changes.",
    "  - No tool was called. Every sentence is written by Aethis; only tool names are the server's, and its descriptions are not quoted.",
    "  - Dates and times are in UTC.",
  );
  return { subject, text: lines.join("\n") };
}
