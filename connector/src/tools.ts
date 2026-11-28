import { CHANGES_KEPT, featuredPage, LABELS_NOTE, NAMES_PER_KIND, SCANNER_PACKAGE, STALE_AFTER_HOURS, TEXT_CHECKS_NOTE } from "./config.ts";
import type { AssetFetcher } from "./data.ts";
import { resolve } from "./lookup.ts";
import type { Resolution } from "./lookup.ts";
import { queueAddress } from "./queue.ts";
import type { QueueOutcome, QueueStore } from "./queue.ts";
import { kinds } from "./shared.ts";
import type { Meta, ServerRecord } from "./shared.ts";

/**
 * The two tools. Rules every answer follows:
 * - it comes only from the tracker data deployed with the Worker; nothing connects to the server asked about;
 * - every sentence is written here, from counts and dates. Names written by a server's publisher
 *   (tool and registry names) appear only as values in their own fields, never inside a sentence;
 * - it says the kind labels are machine guesses, with their accuracy (config.ts);
 * - it never says a server is safe, and never promotes anything.
 */

const urlOrName = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  description: "The server's https address, such as https://example.com/mcp, or its name in the official MCP registry, such as io.github.owner/server.",
};

const annotations = (title: string) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

const outputSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["found", "several_matches", "not_tracked", "no_data"] },
    summary: { type: "string" },
    labels_note: { type: "string" },
    data_as_of: { type: "string" },
  },
  required: ["status", "summary", "labels_note", "data_as_of"],
};

export const TOOLS = [
  {
    name: "check_mcp_server",
    title: "Check an MCP server",
    description:
      "Looks up a remote MCP server in a tracker that lists the tools of the servers in the official MCP registry, without calling any of their tools. Give the server's https address or its registry name. Returns the server's tool names grouped by a machine-guessed kind (read, write, send, destructive, money, unclear), how many tools have each kind, what the server's own annotations claim, when it was last checked, and whether it is a featured server (an official server the tracker follows by name) or a community one (found through the registry). It never connects to the server you name. If the server is not tracked yet, the answer says so and gives a command to scan it on your own machine, and a public https address is recorded as a request for the tracker to look at.",
    inputSchema: { type: "object", properties: { url_or_name: urlOrName }, required: ["url_or_name"], additionalProperties: false },
    outputSchema,
    annotations: annotations("Check an MCP server"),
  },
  {
    name: "mcp_server_changes",
    title: "See an MCP server's tool changes",
    description:
      "Lists the changes the tracker has seen in a remote MCP server's tools, newest first: tools added or removed, which parts of a tool changed (title, description, inputSchema, outputSchema, annotations), and tools now guessed to do something more serious. Each change comes with the two checks it happened between. Use it to see whether a server changed after you approved it. Give the server's https address or registry name, and optionally a date to see only changes seen after it. It never connects to the server you name.",
    inputSchema: {
      type: "object",
      properties: {
        url_or_name: urlOrName,
        since: { type: "string", maxLength: 30, description: "Optional. Only changes seen after this date or time, as YYYY-MM-DD or a UTC time such as 2026-10-01T00:00:00Z." },
      },
      required: ["url_or_name"],
      additionalProperties: false,
    },
    outputSchema,
    annotations: annotations("See an MCP server's tool changes"),
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];
export const isToolName = (name: string): name is ToolName => TOOLS.some((tool) => tool.name === name);

export type Parsed = { tool: "check_mcp_server"; query: string } | { tool: "mcp_server_changes"; query: string; since?: string };

/** Checks a call's arguments. Returns what is wrong as a sentence, or the parsed call. */
export function parseArguments(tool: ToolName, args: unknown, now: Date): Parsed | string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be an object.";
  const allowed = tool === "check_mcp_server" ? ["url_or_name"] : ["url_or_name", "since"];
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length) return `unexpected argument ${/^[A-Za-z0-9_]{1,40}$/.test(extra[0] as string) ? `"${extra[0]}"` : "(name not shown)"}. Allowed: ${allowed.join(", ")}.`;
  const { url_or_name: query, since } = args as Record<string, unknown>;
  if (typeof query !== "string") return "url_or_name is required, as a string: the server's https address or its registry name.";
  if (tool === "check_mcp_server") return { tool, query };
  if (since === undefined) return { tool, query };
  const parsed = parseSince(since, now);
  return parsed ? { tool, query, since: parsed } : "since must be a date as YYYY-MM-DD or a UTC time such as 2026-10-01T00:00:00Z, not in the future.";
}

/** A valid `since` as an ISO time, or null. */
function parseSince(value: unknown, now: Date): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/.test(value)) return null;
  const time = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(time.getTime()) || time.getTime() > now.getTime() + 24 * 3600_000) return null;
  // Date accepts 2026-02-31 by rolling over; refuse a date that does not read back the same.
  if (time.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return time.toISOString();
}

export type Outcome = { ok: true; answer: Record<string, unknown> } | { ok: false; message: string };

export interface ToolContext {
  assets: AssetFetcher;
  queue?: QueueStore;
  /** True while this caller may still add to the queue (its own rate limit). */
  queueAllowed?: () => Promise<boolean>;
  now: Date;
}

export async function runTool(call: Parsed, context: ToolContext): Promise<Outcome> {
  const resolution = await resolve(context.assets, call.query);
  if (resolution.kind === "bad_input") return { ok: false, message: resolution.message };
  const queued = resolution.kind === "unknown_address" ? await queueAddress(resolution.url, { store: context.queue, allowed: context.queueAllowed, now: context.now }) : undefined;
  const common = { labels_note: LABELS_NOTE, data_as_of: resolution.meta.generated_at };
  const stale = staleNote(resolution.meta, context.now);

  switch (resolution.kind) {
    case "found":
      return { ok: true, answer: call.tool === "check_mcp_server" ? checkAnswer(resolution.server, stale, common) : changesAnswer(resolution.server, call.since, stale, common) };
    case "several":
      return { ok: true, answer: severalAnswer(resolution, stale, common) };
    case "no_data":
      return {
        ok: true,
        answer: { status: "no_data", summary: "There is no published information about this server here.", scan_on_your_machine: scannerCommand(), ...common },
      };
    case "unknown_address":
      return { ok: true, answer: unknownAddressAnswer(resolution.url, queued as QueueOutcome, common) };
    case "unknown_name":
      return {
        ok: true,
        answer: {
          status: "not_tracked",
          query_kind: "name",
          queued: "not_queued",
          summary: "No tracked server has that name. If you have the server's https address, ask again with it: an address the tracker has not seen yet is recorded as a request for it to look at. To see its tools now, run the scanner on your own machine.",
          scan_on_your_machine: scannerCommand(),
          ...common,
        },
      };
  }
}

function serverFacts(server: ServerRecord): Record<string, unknown> {
  const facts: Record<string, unknown> = { url: server.url, registry_names: server.registry_names, listed_as: server.featured ? "featured" : "community" };
  if (server.featured) {
    facts.featured_name = server.featured.name;
    facts.website = server.featured.site;
    if (/^[a-z0-9-]{1,40}$/.test(server.featured.id)) facts.page = featuredPage(server.featured.id);
  }
  return facts;
}

function checkAnswer(server: ServerRecord, stale: string, common: Record<string, unknown>): Record<string, unknown> {
  const namesByKind: Record<string, string[]> = {};
  let shown = 0;
  for (const kind of kinds) {
    const names = server.tools_by_kind[kind];
    if (!names?.length) continue;
    namesByKind[kind] = names.slice(0, NAMES_PER_KIND);
    shown += namesByKind[kind].length;
  }
  const answer: Record<string, unknown> = {
    status: "found",
    server: serverFacts(server),
    checks: {
      first_seen: server.first_seen ?? null,
      last_checked: server.last_checked ?? null,
      last_listed: server.last_listed ?? null,
      latest_outcome: server.latest_outcome ?? null,
      checks_last_30_days: server.checks_last_30_days ?? null,
      listed_last_30_days: server.listed_last_30_days ?? null,
    },
    tools: {
      count: server.tool_count ?? null,
      kind_counts: server.kind_counts,
      names_by_kind: namesByKind,
      // Names cut for length, or withheld because they did not look like identifiers.
      names_not_shown: Math.max(0, (server.tool_count ?? shown) - shown),
    },
    server_annotations: server.server_annotations ?? null,
    changes_last_30_days: server.changes_last_30_days ?? null,
    last_change: server.last_change ?? null,
    text_checks: TEXT_CHECKS_NOTE,
    summary: checkSummary(server) + stale,
    ...common,
  };
  return answer;
}

function checkSummary(server: ServerRecord): string {
  const sentences: string[] = [];
  const listed = server.last_listed ? server.last_listed.slice(0, 10) : undefined;
  if (server.tool_count !== undefined && listed) sentences.push(`The server listed ${plural(server.tool_count, "tool")} when its tools were last listed, on ${listed}.`);
  if (server.latest_outcome && server.latest_outcome !== "listed") {
    sentences.push(`The latest check${server.last_checked ? `, on ${server.last_checked.slice(0, 10)},` : ""} did not list tools (${server.latest_outcome.replace(/-/g, " ")}), so the counts are from the last list.`);
  }
  const counted = kinds.filter((kind) => server.kind_counts[kind]).map((kind) => `${server.kind_counts[kind]} ${kind}`);
  if (counted.length) sentences.push(`Guessed kinds: ${counted.join(", ")}.`);
  if (server.changes_last_30_days !== undefined) sentences.push(`${plural(server.changes_last_30_days, "change")} seen in the last 30 days.`);
  sentences.push(server.featured ? "It is a featured server: an official server the tracker follows by name." : "It is a community server, found through the official MCP registry.");
  sentences.push("This is not a safety rating.");
  return sentences.join(" ");
}

function changesAnswer(server: ServerRecord, since: string | undefined, stale: string, common: Record<string, unknown>): Record<string, unknown> {
  const changes = server.changes.filter((change) => !since || change.at > since);
  const sentences: string[] = [];
  const from = since ? `since ${since.slice(0, 10)}` : "in the kept history";
  sentences.push(changes.length ? `${plural(changes.length, "change")} seen ${from}.` : `No change was seen ${from}.`);
  if (server.checks_last_30_days !== undefined) {
    sentences.push(`The tracker checked this server ${plural(server.checks_last_30_days, "time")} in the last 30 days, and ${server.listed_last_30_days ?? 0} of those checks listed its tools.`);
  }
  if (since && server.first_seen && since < server.first_seen) sentences.push(`Tracking began on ${server.first_seen.slice(0, 10)}; nothing before that was watched.`);
  if (server.changes.length >= CHANGES_KEPT) sentences.push(`Only the last ${CHANGES_KEPT} changes are kept, so older ones are not shown.`);
  sentences.push("Each change happened at some point between the two checks given with it.");
  return {
    status: "found",
    server: serverFacts(server),
    since: since ?? null,
    tracked_since: server.first_seen ?? null,
    changes: changes.map((change) => ({
      seen_between: { after: change.since, before: change.at },
      added: change.added,
      removed: change.removed,
      changed: change.changed,
      more_serious: change.more_serious,
      counts: change.counts,
    })),
    changes_kept: CHANGES_KEPT,
    checks_last_30_days: server.checks_last_30_days ?? null,
    listed_last_30_days: server.listed_last_30_days ?? null,
    summary: sentences.join(" ") + stale,
    ...common,
  };
}

function severalAnswer(resolution: Extract<Resolution, { kind: "several" }>, stale: string, common: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "several_matches",
    total: resolution.total,
    matches: resolution.servers.map(serverFacts),
    summary: `${plural(resolution.total, "tracked server")} match that name${resolution.total > resolution.servers.length ? `; the first ${resolution.servers.length} are listed` : ""}. Ask again with the address of the one you mean.${stale}`,
    ...common,
  };
}

function unknownAddressAnswer(url: string, queued: QueueOutcome, common: Record<string, unknown>): Record<string, unknown> {
  const queueSentence = {
    queued: "It was recorded as a request for the tracker to look at; this lookup cannot say whether or when it will be checked.",
    withheld: "It was not recorded for the tracker, because addresses with a query string or what looks like a key in them are never stored.",
    not_queued: "It could not be recorded for the tracker right now.",
  }[queued];
  return {
    status: "not_tracked",
    query_kind: "address",
    queued: queued === "queued" ? "queued" : "not_queued",
    summary: `This address is not tracked yet. ${queueSentence} To see its tools now, run the scanner on your own machine.`,
    scan_on_your_machine: scannerCommand(url),
    ...common,
  };
}

/**
 * The command to scan a server locally. The address is put in only when it is made of characters
 * no shell treats specially (no query string, no quotes, no &, $ or %), so a copied command can
 * only run the scanner, in any shell. Otherwise a placeholder stands in for it.
 */
export function scannerCommand(url?: string): string {
  const plain = url !== undefined && /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\/-]*)?$/.test(url);
  return `npx ${SCANNER_PACKAGE} check ${plain ? url : "<server address>"}`;
}

function staleNote(meta: Meta, now: Date): string {
  const age = now.getTime() - new Date(meta.generated_at).getTime();
  return age > STALE_AFTER_HOURS * 3600_000 ? ` The tracker data is from ${meta.generated_at.slice(0, 10)}, more than ${STALE_AFTER_HOURS} hours old.` : "";
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
