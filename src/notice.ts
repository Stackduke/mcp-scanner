import { readdir } from "node:fs/promises";
import path from "node:path";
import { confined } from "./authority.ts";
import { readSnapshot } from "./files.ts";
import { findInTool } from "./findings.ts";
import type { Snapshot } from "./types.ts";

/**
 * The private notice. The text checks are not published: a finding goes to a person first, so a
 * vendor can be told before anything is said in public. When a server watched with a token lists
 * tools whose text the checks flag, and the flag was not there before this run, the notice tells
 * Stackduke's maintainer alone, through Stackduke's own endpoint.
 *
 * The run's log is public, so nothing here may tell a reader of the log whether there was anything
 * to say. The notice is sent on every run, empty or not, and the only lines printed are fixed ones.
 * What is sent is the scanner's own words (rule, severity, reason) and where they apply, never the
 * server's text: no excerpt, no description.
 */
export interface NoticeFinding { tool: string; rule: string; severity: string; where: string; reason: string }
export interface VendorNotice { vendor: string; at: string; findings: NoticeFinding[]; more: number }
export interface NoticePayload { version: 1; notices: VendorNotice[] }

const vendorId = /^[a-z0-9-]{1,40}$/;
export const findingsPerVendor = 50;
const severityOrder: Record<string, number> = { high: 0, medium: 1 };

interface Flagged { key: string; finding: NoticeFinding }

// Low findings are left out, as in `review`: they are often honest and not worth a message.
function flagged(snapshot: Snapshot): Flagged[] {
  return snapshot.tools.flatMap((tool) => {
    const variant = (tool as { variant?: unknown }).variant;
    const name = typeof variant === "string" && variant ? `${tool.name}#${variant}` : tool.name;
    // Names and places are the server's text, so they are cut to identifier characters before they are sent.
    const shown = confined(tool.name, /[^A-Za-z0-9_.-]+/g, 60) || "(no name)";
    const shownVariant = typeof variant === "string" ? confined(variant, /[^A-Za-z0-9_.-]+/g, 30) : "";
    return findInTool(tool).filter((finding) => finding.severity !== "low").map((finding) => ({
      // The key uses the text as the server sent it, so two tools that read alike once cut are still told apart.
      key: JSON.stringify([name, finding.rule, finding.where]),
      finding: {
        tool: shownVariant ? `${shown}#${shownVariant}` : shown,
        rule: finding.rule,
        severity: finding.severity,
        where: confined(finding.where, /[^A-Za-z0-9_.()[\] -]+/g, 120) || "?",
        reason: finding.reason,
      },
    }));
  });
}

/** Each `<vendor>.json` in a folder, by vendor. A folder that is missing, or a file that is not a snapshot, gives nothing. */
async function snapshotsIn(folder: string): Promise<Map<string, Snapshot>> {
  let files: string[];
  try { files = await readdir(folder); } catch { return new Map(); }
  const found = new Map<string, Snapshot>();
  for (const file of files.sort()) {
    const vendor = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
    if (!vendorId.test(vendor)) continue;
    const snapshot = await readSnapshot(path.join(folder, file));
    if (snapshot) found.set(vendor, snapshot);
  }
  return found;
}

/**
 * What is new since the copy of `watched/` taken before the scan. A vendor with no copy from before
 * counts everything as new. A finding is known by its tool, rule and place, so a tool that keeps the
 * same flagged text is not sent again each day.
 */
export async function buildNotices(beforeDir: string, dataDir: string): Promise<NoticePayload> {
  const before = await snapshotsIn(beforeDir);
  const after = await snapshotsIn(path.join(dataDir, "watched"));
  const notices: VendorNotice[] = [];
  for (const [vendor, snapshot] of after) {
    const previous = before.get(vendor);
    const known = new Set(previous ? flagged(previous).map(({ key }) => key) : []);
    const fresh = [...new Map(flagged(snapshot).filter(({ key }) => !known.has(key)).map((item) => [item.key, item.finding])).values()]
      .sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));
    if (!fresh.length) continue;
    notices.push({ vendor, at: confined(snapshot.takenAt, /[^0-9A-Za-z:.+-]+/g, 40), findings: fresh.slice(0, findingsPerVendor), more: Math.max(0, fresh.length - findingsPerVendor) });
  }
  return { version: 1, notices };
}

export const notConfiguredLine = "Private notices are not configured here, so none was sent.";
export const failedLine = "The private notice could not be delivered.";

export interface SendOptions { environment: Record<string, string | undefined>; print: (line: string) => void; fetchImpl?: typeof fetch; timeoutMs?: number }

/** Where a notice may go: https, or plain http to this machine only, for tests. */
function noticeAddress(text: string): URL | null {
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") ? url : null;
}

/**
 * Sends the payload, whatever is in it, and says only whether it arrived. The address and token
 * come from the environment and are never printed. A failure prints one fixed line and is not an
 * error: the run's other work goes on, and a missing notice shows on the receiving side.
 */
export async function sendNotice(payload: NoticePayload | null, options: SendOptions): Promise<boolean> {
  const { environment, print } = options;
  const address = environment.STACKDUKE_NOTICE_URL?.trim(), token = environment.STACKDUKE_NOTICE_TOKEN?.trim();
  if (!address || !token) { print(notConfiguredLine); return false; }
  const url = noticeAddress(address);
  // A token with spaces or control characters would be refused by fetch with an error naming the header; it is refused here instead.
  const sendable = url !== null && /^[\x21-\x7E]{1,4096}$/.test(token) && !(url.protocol === "https:" && environment.NODE_TLS_REJECT_UNAUTHORIZED === "0");
  // A payload that could not be built is sent empty, so the request is made all the same.
  if (!sendable || payload === null) {
    if (sendable) await post(url, token, { version: 1, notices: [] }, options);
    print(failedLine);
    return false;
  }
  const delivered = await post(url, token, payload, options);
  if (!delivered) print(failedLine);
  return delivered;
}

async function post(url: URL, token: string, payload: NoticePayload, { fetchImpl = fetch, timeoutMs = 15_000 }: SendOptions): Promise<boolean> {
  try {
    // A redirect is not followed: the token goes to the one address given, or nowhere.
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

/** The `notice` command: build, send, and print nothing that depends on what was found. */
export async function notice(beforeDir: string, dataDir: string, options: SendOptions): Promise<void> {
  let payload: NoticePayload | null;
  try { payload = await buildNotices(beforeDir, dataDir); } catch { payload = null; }
  await sendNotice(payload, options);
}
