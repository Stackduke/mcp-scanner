import { findInTool } from "./findings.ts";
import { actionKind, descriptionSuggests, labelTool, nameSuggests, words } from "./risk.ts";
import type { CapabilityClass, Snapshot, SnapshotTool } from "./types.ts";

/**
 * What a server lets an agent do, for a reader who is not an engineer.
 *
 * The report must never reassure wrongly. Two rules follow.
 *
 * It reads every tool the more serious way:
 * - where the server's label, the tool's name and its description disagree, it goes with whichever says most;
 * - a description, which the server writes, counts as evidence that a tool acts and never that it is harmless;
 * - a tool nobody can label, or whose name cannot be read as words, is unknown, never read-only;
 * - a change nobody has called reversible is not assumed to be.
 *
 * And it never says what a server cannot do. A missing label proves nothing, so the report lists
 * what it found and stops. "Only reads" is always given as somebody's claim, with the names shown.
 *
 * Every sentence is written here. The only words of the server's that appear are tool names, as
 * identifiers, and the name it gives itself, in quotes. Its descriptions are never quoted, and no
 * model is involved. A server can still choose misleading names; see the limits the report prints.
 *
 * It describes what a server offers. It says nothing about what a policy allows, what the
 * account behind the connection may touch, or what any tool does when called.
 */
export type AuthorityKind = "money" | "destructive" | "send" | "write" | "unclear" | "read";
/** What a tool's place in the report rests on. */
export type AuthorityBasis = "server" | "name" | "description" | "none";

export interface AuthorityTool {
  /** The name as the server gives it, cut down to the characters a tool name normally has. */
  name: string;
  /** The group it is listed under: the most serious thing it is counted as doing. */
  kind: AuthorityKind;
  /** Everything it is counted as doing. */
  does: CapabilityClass[];
  /** Takes free-form input such as SQL or a shell command. */
  broad: boolean;
  basis: AuthorityBasis;
  /** The report counted more than the server's label said, or would not take the label on trust. */
  disputed: boolean;
  /** It changes something, and nothing reliable says the change can be undone. */
  undoUnstated: boolean;
  /** Listed as only reading on the server's mark alone: its name has no word this report understands. */
  onTrust: boolean;
}

export interface AuthorityGroup {
  kind: AuthorityKind;
  tools: AuthorityTool[];
}

export interface AuthorityConcern { tool: string; urgent: boolean; reasons: string[] }

export interface AuthorityReport {
  /** Where the list came from: the address scanned, or a named source. */
  source: string;
  /** What the server calls itself. Its own claim, shown as such. Empty when it gives none or it cannot be shown. */
  declaredName: string;
  /** The server's name for itself was withheld because it carries a word of reassurance. */
  nameWithheld: boolean;
  takenAt: string;
  /** Definitions in the list. More than `toolNames` when a source publishes variants of one tool. */
  toolCount: number;
  toolNames: number;
  /** Most serious first. Empty groups are left out. */
  groups: AuthorityGroup[];
  basis: Record<AuthorityBasis, number>;
  /** Tools to look at. The urgent ones, where the report overruled or refused a label, come first. */
  concerns: AuthorityConcern[];
  minorNotes: number;
}

const seriousFirst: AuthorityKind[] = ["money", "destructive", "send", "write", "unclear", "read"];
const acting = ["money", "destructive", "send", "write"] as const;
type Acting = (typeof acting)[number];
// Words a tool or server name has no reason to carry. A name that has one is not repeated as words.
const reassurance = new Set(["aethis", "safe", "safely", "verified", "approved", "trusted", "secure", "harmless", "reviewed", "audited", "certified", "checked", "risky", "risk"]);
// Actions serious enough to look for inside a longer run of letters, as in "deleteaccount".
const stems = ["delete", "remove", "destroy", "purge", "truncate", "refund", "transfer", "withdraw", "publish"];
/** Untrusted text cut down to a fixed set of characters. */
function confined(text: unknown, notAllowed: RegExp, longest: number): string {
  const flat = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  const kept = flat.replace(notAllowed, "?").replace(/\?{2,}/g, "?");
  return /[A-Za-z0-9]/.test(kept) ? (kept.length > longest ? `${kept.slice(0, longest)}…` : kept) : "";
}
// No colon or slash, and no "www." in front, so a name cannot be printed as something a terminal makes into a link.
const ordinaryName = /^(?!(?:www|ftp)\.)[A-Za-z0-9_.-]{1,60}$/i;
const unlinked = (text: string) => (/^(?:www|ftp)\./i.test(text) ? text.replace(/\./g, "?") : text);
const shownName = (tool: { name: unknown; variant?: unknown }) => {
  const name = unlinked(confined(tool.name, /[^A-Za-z0-9_.-]+/g, 60)) || "(no name)";
  const variant = confined(tool.variant, /[^A-Za-z0-9_.-]+/g, 30);
  return variant ? `${name}#${variant}` : name;
};
const reassures = (text: string) => words(text).some((word) => reassurance.has(word));
/** A server's name for itself is held to a stricter list: it has even less reason to say "official" or "read-only". */
const boasts = (text: string) => reassures(text) || /\b(official|read[\s_-]?only)\b/i.test(text);

const canWords: Record<Acting, string> = { money: "move money", destructive: "delete or destroy things", send: "send things to other people", write: "change things" };
const said = (kinds: Acting[]) => kinds.map((kind) => canWords[kind]).join(" and ");

interface Reach { does: CapabilityClass[]; basis: AuthorityBasis; undoUnstated: boolean; onTrust: boolean; broad: boolean; urgent: string[]; notes: string[] }

/** One tool, read the more serious way. */
function reachOf(tool: SnapshotTool): Reach {
  const label = labelTool(tool);
  const named = nameSuggests(tool);
  const annotations = tool.annotations ?? {};
  const does = new Set<CapabilityClass>(label.classes);
  let basis: AuthorityBasis = label.source === "mcp_annotation" ? "server" : label.source === "unclassified" ? "none" : named.length ? "name" : "description";
  const urgent: string[] = [], notes: string[] = [];
  const missing = (kinds: CapabilityClass[]) => kinds.filter((kind): kind is Acting => kind !== "read" && !does.has(kind) && !(kind === "write" && does.has("destructive")));
  const marked = annotations.readOnlyHint === true ? "marks this read-only" : "labels this";

  if (label.source === "mcp_annotation") {
    const more = missing(named);
    if (more.length) {
      for (const kind of more) does.add(kind);
      urgent.push(`The server ${marked}, but its name says it can ${said(more)}. This report counts it as able to.`);
    }
    if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
      does.add("destructive");
      urgent.push("The server marks this both read-only and destructive. This report counts it as destructive.");
    }
  }
  // The server writes its descriptions, so one is evidence that a tool acts and never that it is harmless.
  const described = missing(descriptionSuggests(tool));
  if (described.length && basis !== "description") {
    for (const kind of described) does.add(kind);
    urgent.push(`Its description says it can ${said(described)}, which its ${basis === "server" ? "label" : "name"} does not. This report counts it as able to.`);
  }
  if (basis === "description" && !acting.some((kind) => does.has(kind))) { does.clear(); basis = "none"; }

  // A name that cannot be read as words tells this report nothing, whatever the server says about the tool.
  const readable = ordinaryName.test(tool.name);
  const letters = tool.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const runTogether = stems.find((stem) => letters.includes(stem) && !words(tool.name).some((word) => actionKind(word) !== null && word.startsWith(stem)));
  if (!acting.some((kind) => does.has(kind)) && (!readable || runTogether)) {
    const wasRead = does.has("read");
    does.clear();
    if (basis !== "server") basis = "none";
    const why = readable ? `Its name has "${runTogether}" run together with other letters, so it was not read as a word.` : "Its name is not written the way tool names are (unusual characters, or very long), so it was not read as words.";
    urgent.push(`${why}${wasRead ? ` The ${annotations.readOnlyHint === true ? "server marks it" : "rest of the name reads as"} read-only; this report does not take that on trust and lists it as unknown.` : ""}`);
  } else if (!readable) {
    notes.push("Its name is not written the way tool names are (unusual characters, or very long).");
  }
  if (reassures(tool.name)) notes.push("Its name carries a word of reassurance, which a tool name has no reason to.");

  const acts = acting.some((kind) => does.has(kind));
  if (acts) does.delete("read");
  if (does.has("destructive")) does.delete("write");
  // "Not destructive" is taken as "can be undone" only from a server that plainly says the tool writes,
  // was not overruled above, and for a tool that neither sends nor moves money: neither can be taken back.
  const saysReversible = annotations.readOnlyHint === false && annotations.destructiveHint === false && !urgent.length && !does.has("send") && !does.has("money");
  return {
    does: (["read", "write", "send", "money", "destructive"] as const).filter((kind) => does.has(kind)),
    basis,
    undoUnstated: acts && !does.has("destructive") && !saysReversible,
    onTrust: !acts && does.has("read") && basis === "server" && named.length === 0,
    broad: label.broad === true,
    urgent,
    notes,
  };
}

export function authorityOf(snapshot: Snapshot): AuthorityReport {
  const grouped = new Map<AuthorityKind, AuthorityTool[]>();
  const basis: Record<AuthorityBasis, number> = { server: 0, name: 0, description: 0, none: 0 };
  const concerns: AuthorityConcern[] = [];
  let minorNotes = 0;

  for (const tool of snapshot.tools) {
    const reach = reachOf(tool);
    basis[reach.basis] += 1;
    const name = shownName(tool);
    const kind = seriousFirst.find((candidate) => candidate !== "unclear" && reach.does.includes(candidate)) ?? "unclear";
    grouped.set(kind, [...(grouped.get(kind) ?? []), { name, kind, does: reach.does, broad: reach.broad, basis: reach.basis, disputed: reach.urgent.length > 0, undoUnstated: reach.undoUnstated, onTrust: reach.onTrust }]);

    const reasons = new Set<string>([...reach.urgent, ...reach.notes]);
    for (const finding of findInTool(tool)) {
      // The disagreement between label and name is already stated, in this report's own terms.
      if (finding.rule === "annotation-mismatch") continue;
      if (finding.severity === "low") minorNotes += 1;
      else reasons.add(finding.reason);
    }
    // One entry per tool in the list, so two tools whose shown names collide cannot hide one another.
    if (reasons.size) concerns.push({ tool: name, urgent: reach.urgent.length > 0, reasons: [...reasons] });
  }

  // The tools a reader most needs to see come first, so a long list cannot bury them.
  const rank = (tool: AuthorityTool) => (tool.disputed ? 0 : tool.broad ? 1 : tool.onTrust ? 2 : 3);
  const declared = typeof snapshot.server?.name === "string" ? snapshot.server.name : "";
  return {
    source: unlinked(confined(String(snapshot.source ?? "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, ""), /[^A-Za-z0-9._/@-]+/g, 80)) || "an unnamed source",
    declaredName: boasts(declared) ? "" : confined(declared, /[^A-Za-z0-9 _-]+/g, 40),
    nameWithheld: boasts(declared),
    takenAt: typeof snapshot.takenAt === "string" ? snapshot.takenAt : "",
    toolCount: snapshot.tools.length,
    toolNames: new Set(snapshot.tools.map((tool) => tool.name)).size,
    groups: seriousFirst.flatMap((kind) => {
      const tools = grouped.get(kind);
      return tools ? [{ kind, tools: [...tools].sort((a, b) => rank(a) - rank(b)) }] : [];
    }),
    basis,
    concerns: [...concerns].sort((a, b) => Number(b.urgent) - Number(a.urgent)),
    minorNotes,
  };
}

/** Far more than any real server lists. Past it the report says how many it left out. */
const mostListed = 500;
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function day(takenAt: string): string {
  const date = new Date(takenAt);
  return Number.isNaN(date.getTime()) ? "an unknown date" : `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
function listed(items: string[], most: number): string {
  const shown = items.slice(0, most);
  return items.length > most ? `${shown.join(", ")} and ${items.length - most} more` : shown.join(", ");
}
function sentenceList(items: string[]): string {
  const unique = [...new Set(items)];
  if (unique.length < 3) return unique.join(" and ");
  return `${unique.slice(0, -1).join(", ")}, and ${unique.at(-1)}`;
}

const canDo: Record<Exclude<AuthorityKind, "unclear">, string> = {
  money: "move or spend money",
  destructive: "make changes that cannot be undone",
  send: "send messages or publish to other people",
  write: "create or change things",
  read: "read data",
};
const heading: Record<Exclude<AuthorityKind, "unclear" | "read">, string> = {
  money: "Move or spend money",
  destructive: "Make changes that cannot be undone, such as deleting",
  send: "Send messages or publish",
  write: "Create or change things",
};
const alsoWords: Partial<Record<CapabilityClass, string>> = { send: "also sends", money: "also moves money", destructive: "cannot be undone" };

const all = (report: AuthorityReport) => report.groups.flatMap((group) => group.tools);
/** Every tool counted as doing this, whichever group it is listed under. */
const doingIt = (report: AuthorityReport, kind: CapabilityClass) => all(report).filter((tool) => tool.does.includes(kind));
const unclearIn = (report: AuthorityReport) => all(report).filter((tool) => tool.kind === "unclear");
const broadIn = (report: AuthorityReport) => all(report).filter((tool) => tool.broad);
/** A way out for what was read: something that writes, sends or pays. Deleting carries nothing out. */
const carriesOut = (report: AuthorityReport) => (["write", "send", "money"] as const).some((kind) => doingIt(report, kind).length > 0);
const mayCarryOut = (report: AuthorityReport) => unclearIn(report).length > 0 || broadIn(report).length > 0;

function opening(report: AuthorityReport): string[] {
  const can = (["read", "write", "destructive", "send", "money"] as const).filter((kind) => doingIt(report, kind).length);
  const unclear = unclearIn(report).length, broad = broadIn(report).length, undoUnstated = all(report).filter((tool) => tool.undoUnstated).length;
  const sentences: string[] = [];
  if (can.length) sentences.push(`An agent connected to this server can ${sentenceList(can.map((kind) => canDo[kind]))}.`);
  if (unclear) sentences.push(can.length
    ? `${unclear === 1 ? "One tool" : `${unclear} tools`} could not be labelled, so an agent may be able to do more than that.`
    : `${unclear === 1 ? "Its one tool" : `None of its ${unclear} tools`} could ${unclear === 1 ? "not " : ""}be labelled, so what an agent can do through this server is not known.`);
  if (broad) sentences.push(`${broad === 1 ? "One tool takes" : `${broad} tools take`} free-form input such as SQL or a shell command, so ${broad === 1 ? "it may do more than its label says" : "they may do more than their labels say"}.`);
  if (undoUnstated) sentences.push(`${undoUnstated === 1 ? "One tool that changes things does" : `${undoUnstated} tools that change things do`} not say whether the change can be undone. Assume it might not be.`);
  return sentences;
}

function describeOne(report: AuthorityReport): string[] {
  const lines: string[] = [`What an agent can do through ${report.source}`];
  const count = report.toolCount === report.toolNames ? plural(report.toolCount, "tool") : `${plural(report.toolCount, "definition")} of ${plural(report.toolNames, "tool")}`;
  const listedOn = `${count} listed on ${day(report.takenAt)}.`;
  lines.push(report.declaredName ? `The server calls itself "${report.declaredName}". ${listedOn}` : report.nameWithheld ? `The server's name for itself is not shown, because it carries a word of reassurance. ${listedOn}` : listedOn, "");
  if (!report.toolCount) {
    return [...lines, "No tools were listed, so this report cannot say what an agent could do through it. A different login may be shown tools, and only tools are looked at."];
  }
  lines.push(...opening(report));

  for (const group of report.groups) {
    const one = group.tools.length === 1, size = `(${plural(group.tools.length, "tool")})`;
    if (group.kind === "read") {
      lines.push("", `Said to only read ${size}`, `  The server's label or the tool's name says ${one ? "this only reads" : "these only read"}. Nobody has tested that.`);
      lines.push(`  ${listed(group.tools.map((tool) => `${tool.name}${tool.onTrust ? "*" : ""}`), mostListed)}`);
      if (group.tools.some((tool) => tool.onTrust)) lines.push("  * The name has no word this report understands. It is listed here on the server's word alone.");
      continue;
    }
    if (group.kind === "unclear") lines.push("", `Not clear what ${one ? "this does" : "these do"} ${size}`, `  Nothing reliable says what ${one ? "this does" : "these do"}. Treat ${one ? "it" : "them"} as able to change things until someone has looked.`);
    else lines.push("", `${heading[group.kind]} ${size}`);
    // The protocol gives a server no way to say a tool moves money, so this is never the server's own statement.
    if (group.kind === "money") lines.push("  Going by words in tool names and descriptions. A server has no standard way to state this, so check by eye.");
    for (const tool of group.tools.slice(0, mostListed)) {
      const notes = [
        ...tool.does.flatMap((kind) => { const also = kind === group.kind ? undefined : alsoWords[kind]; return also ? [also] : []; }),
        ...(tool.broad ? ["takes free-form input"] : []),
        ...(tool.disputed ? ["see below"] : tool.basis === "name" ? ["a guess from the name"] : tool.basis === "description" ? ["a guess from its description"] : []),
      ];
      lines.push(`  - ${tool.name}${notes.length ? ` (${notes.join("; ")})` : ""}`);
    }
    if (group.tools.length > mostListed) lines.push(`  … and ${group.tools.length - mostListed} more`);
  }

  const broad = broadIn(report), unclear = unclearIn(report).length;
  const money = doingIt(report, "money"), destructive = doingIt(report, "destructive"), send = doingIt(report, "send"), write = doingIt(report, "write");
  lines.push("", "If an agent using this server were misled or taken over, through this server it could:");
  if (money.length) lines.push(`  - move or spend money (${plural(money.length, "tool")})`);
  if (destructive.length) lines.push(`  - make changes that cannot be undone, such as deleting (${listed(destructive.map((tool) => tool.name), 12)})`);
  if (send.length) lines.push(`  - send messages or publish in your name (${plural(send.length, "tool")})`);
  if (write.length) lines.push(`  - create or change things (${plural(write.length, "tool")})`);
  if (broad.length) lines.push(`  - go further than the names suggest, through free-form input such as SQL or a shell command (${listed(broad.map((tool) => tool.name), 12)})`);
  if (doingIt(report, "read").length) {
    lines.push(`  - read what the account behind this connection can see${carriesOut(report) ? ", and copy it out through a tool that changes or sends things" : mayCarryOut(report) ? ", and perhaps copy it out through a tool whose reach is not known" : ""}`);
  }
  if (unclear) lines.push(`  - do whatever the ${unclear === 1 ? "one unlabelled tool does" : `${unclear} unlabelled tools do`}`);
  // What an agent puts into any tool goes to whoever runs the server. That is true of a tool that only reads.
  lines.push("  - hand whoever runs this server anything the agent knows, by putting it into a tool, even one that only reads");
  lines.push("  How far that goes depends on the account the server is signed in with and on your policy. This report sees neither.");

  if (report.concerns.length) {
    // Every tool whose label was overruled or refused is shown. Only the lesser notes are cut short.
    const urgent = report.concerns.filter((concern) => concern.urgent).slice(0, mostListed);
    const shown = [...urgent, ...report.concerns.filter((concern) => !concern.urgent).slice(0, Math.max(0, 20 - urgent.length))];
    lines.push("", "Worth a person's look:");
    for (const concern of shown) lines.push(`  - ${concern.tool}: ${concern.reasons.slice(0, 4).join(" ")}${concern.reasons.length > 4 ? ` And ${concern.reasons.length - 4} more.` : ""}`);
    if (report.concerns.length > shown.length) lines.push(`  … and ${plural(report.concerns.length - shown.length, "more tool")} with notes`);
  }

  const { server, name, description, none } = report.basis;
  const total = report.toolCount;
  const of = (count: number) => (count === total ? (total === 1 ? "the one tool" : `all ${total} tools`) : `${count} of the ${total} tools`);
  const disputed = all(report).filter((tool) => tool.disputed).length;
  lines.push("", "How far to trust this:");
  if (server) lines.push(`  - For ${of(server)}, the server itself says whether the tool only reads. Aethis has not tested what it says.`);
  if (name) lines.push(`  - For ${of(name)}, the label is a guess from the tool's name.`);
  if (description) lines.push(`  - For ${of(description)}, it is a guess from the tool's description, which the server writes. A description counts only as evidence that a tool changes something.`);
  if (none) lines.push(`  - Nothing reliable was found for ${of(none)}.`);
  const reversible = all(report).filter((tool) => tool.does.some((kind) => kind !== "read") && !tool.does.includes("destructive") && !tool.undoUnstated).length;
  if (reversible) lines.push(`  - For ${of(reversible)}, the server says the change is not destructive, and this report has not warned about undoing it. That too is the server's word.`);
  if (disputed) lines.push(`  - For ${of(disputed)}, this report counted more than the label said, or would not take the label on trust. Each is listed above.`);
  if (report.minorNotes) lines.push(`  - ${plural(report.minorNotes, "minor note")} on the tools' wording ${report.minorNotes === 1 ? "is" : "are"} in the technical report.`);
  lines.push(
    "  - Names are read as English words split at underscores, hyphens and capitals. A name written another way, or in another language, is not understood, and such a tool is placed by the server's label alone. A word that is usually a thing, such as \"commit\", \"refund\" or \"release\", counts as an action only at the start of a name.",
    "  - \"Sends\" and \"moves money\" are never the server's own statement. They are read off names and descriptions. So is free-form input, which is spotted by a short list of words such as \"sql\" and \"command\".",
    "  - This report does not say a server is safe, and does not list what a server cannot do. A missing label proves nothing.",
    "  - This is what the server offers, not what your policy allows.",
    "  - It comes from a list of tool definitions. No tool was called.",
    "  - Every sentence is written by Aethis. The server's descriptions are not quoted; only its tool names and the name it gives itself appear, and a server chooses those.",
  );
  return lines;
}

/** The report as text. With several servers, it opens with what an agent connected to all of them can do. */
export function describeAuthority(reports: AuthorityReport[]): string {
  const lines: string[] = [];
  const servers = new Set(reports.map((report) => report.source)).size;
  if (servers > 1) {
    const through = (matching: AuthorityReport[]) => sentenceList(matching.map((report) => report.source));
    const having = (test: (report: AuthorityReport) => boolean) => reports.filter(test);
    const rows: string[] = [];
    const row = (matching: AuthorityReport[], text: string) => { if (matching.length) rows.push(`  - ${text} ${through(matching)}`); };
    row(having((report) => doingIt(report, "money").length > 0), `can ${canDo.money} through`);
    row(having((report) => doingIt(report, "destructive").length > 0), `can ${canDo.destructive} through`);
    row(having((report) => doingIt(report, "send").length > 0), `can ${canDo.send} through`);
    row(having((report) => doingIt(report, "write").length > 0), `can ${canDo.write} through`);
    row(having((report) => broadIn(report).length > 0), "can use free-form input such as SQL or a shell command on");
    const reading = having((report) => doingIt(report, "read").length > 0);
    row(reading, `can ${canDo.read} through`);
    row(having((report) => unclearIn(report).length > 0), "has tools nobody could label on");
    if (rows.length) {
      lines.push(`An agent connected to ${servers === 2 ? "both" : `all ${servers}`} of these servers:`, ...rows);
      // True only when the reading and the way out are on different servers.
      const elsewhere = (test: (report: AuthorityReport) => boolean) => reading.some((reader) => reports.some((other) => other.source !== reader.source && test(other)));
      if (elsewhere(carriesOut)) lines.push("", "What it reads on one server it can write or send through another.");
      else if (elsewhere(mayCarryOut)) lines.push("", "What it reads on one server it may be able to pass on through another, whose tools are not fully known.");
      lines.push("", "Each server is set out below.", "");
    }
  }
  reports.forEach((report, index) => { if (index) lines.push("", "-".repeat(60), ""); lines.push(...describeOne(report)); });
  return lines.join("\n");
}
