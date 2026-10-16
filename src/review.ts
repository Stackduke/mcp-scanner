import { readFile } from "node:fs/promises";
import path from "node:path";
import { listTools } from "./client.ts";
import { crawl } from "./crawl.ts";
import { findInTool } from "./findings.ts";
import { printable } from "./text.ts";
import type { Endpoint } from "./tracker.ts";
import type { Finding } from "./types.ts";

/**
 * The private side of the tracker. The text checks are not published: a finding goes to a person
 * first, so a vendor can be told before anything is said in public. This looks again, live, at the
 * endpoints the tracker found new or changed in the last few days, runs the text checks on what
 * they list now, and prints what deserves a look. It writes nothing.
 */
export interface ReviewOptions { dataDir: string; days: number; concurrency: number; hostGapMs: number; budgetMinutes: number; fetchImpl?: typeof fetch; now?: () => number }

export interface ReviewedServer { url: string; names: string[]; findings: Array<Finding & { tool: string }> }

export async function review(options: ReviewOptions): Promise<{ looked: number; failed: number; servers: ReviewedServer[] }> {
  const now = options.now ?? Date.now;
  const since = now() - options.days * 86_400_000;
  const recent = (time: string | undefined) => time !== undefined && Date.parse(time) >= since;
  const text = await readFile(path.join(options.dataDir, "endpoints.jsonl"), "utf8");
  const due = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Endpoint)
    // Servers watched with a token are left out: their full definitions are in watched/, for `scan` and `authority`.
    .filter((endpoint) => !endpoint.signedIn && endpoint.outcome === "listed" && (recent(endpoint.changes[0]?.at) || (recent(endpoint.lastListed) && endpoint.checks.filter((check) => check.endsWith(" L")).length === 1)));

  const { done } = await crawl(due, async (endpoint) => {
    try { return await listTools(endpoint.url, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), timeoutMs: 15_000 }); }
    catch { return { outcome: "unreachable", detail: "error" } as const; }
  }, { concurrency: options.concurrency, hostGapMs: options.hostGapMs, deadline: now() + options.budgetMinutes * 60_000, now });

  const servers: ReviewedServer[] = [];
  let failed = 0;
  for (const { item, result } of done) {
    if (result.outcome !== "listed") { failed += 1; continue; }
    const findings = result.tools.flatMap((tool) => findInTool(tool).filter((finding) => finding.severity !== "low").map((finding) => ({ ...finding, tool: printable(tool.name, 80) })));
    if (findings.length) servers.push({ url: item.url, names: item.names, findings });
  }
  const weight = (server: ReviewedServer) => server.findings.filter((finding) => finding.severity === "high").length;
  return { looked: done.length, failed, servers: servers.sort((a, b) => weight(b) - weight(a)) };
}

export function describeReview({ looked, failed, servers }: Awaited<ReturnType<typeof review>>): string {
  const lines = [`Looked again at ${looked} new or changed servers; ${failed} did not list tools this time. ${servers.length} have something worth a look.`];
  for (const server of servers) {
    lines.push("", `${printable(server.url, 120)}  (${server.names.map((name) => printable(name, 80)).join(", ")})`);
    for (const finding of server.findings) lines.push(`  [${finding.severity}] ${finding.tool} - ${finding.rule} in ${finding.where}: ${finding.reason}`, `      ${finding.excerpt}`);
  }
  lines.push("", "This is for a person, not for publishing. Tell the vendor privately first. Pattern checks flag some honest text; read before judging.");
  return lines.join("\n");
}
