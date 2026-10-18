import { listTools } from "./client.ts";
import type { ListToolsResult } from "./client.ts";
import { needsRefresh, refreshTokens } from "./oauth.ts";
import type { OAuthOptions, Tokens } from "./oauth.ts";
import { readStoredSignIn, secretsOf, storedSignInText, tokenServerOf } from "./sign-in-store.ts";
import { oauthServers, readToken } from "./signed-in.ts";
import type { OAuthServer } from "./signed-in.ts";

/**
 * The daily run's part in keeping browser sign-ins, in three steps that run apart, each with only
 * what it needs:
 *
 *   renew    reads each stored sign-in, renews it at the token address saved with it, and writes the
 *            renewed one straight back to its secret, before anything uses it. Most vendors give a
 *            new refresh token each time and stop taking the old one, so a renewal that is not saved
 *            is a sign-in lost. This step talks to sign-in servers and GitHub, never to an MCP server.
 *   check    lists each server's tools with the renewed access token, holding no GitHub key, and
 *            keeps only whether it answered. What a server not yet published lists is not kept.
 *   issues   opens an issue for each sign-in that needs a person, and closes it after a good read.
 *
 * A sign-in that cannot be renewed or is refused is never a silent gap: the tracker records a
 * missed check, which the page shows as not read, and an issue says what to run to sign in again.
 * Nothing here prints, keeps or passes on a token, except to the vendor and to `gh` on its input.
 */

export type RenewStatus = "renewed" | "kept" | "not-connected" | "lost" | "unreachable";
/** `set-up-app`: what is needed is the app that lets the run save renewed sign-ins, not another sign-in. */
export interface RenewReport { vendor: string; status: RenewStatus; detail?: string; fix?: "set-up-app" }

export interface RenewDeps extends OAuthOptions {
  environment: Record<string, string | undefined>;
  /**
   * Writes a renewed sign-in back to its secret, resolving true once it is saved. Without it nothing
   * is renewed: a renewal that cannot be saved may leave the stored sign-in no longer working.
   */
  save?: (secret: string, value: string) => Promise<boolean>;
  /** Hides a value from the run's log, which is public, before anything could print it. */
  mask: (value: string) => void;
  now?: () => Date;
  servers?: readonly OAuthServer[];
}

/** Run out, or about to: the check and scan steps use the token some minutes after this one hands it on. */
const ranOut = (tokens: Tokens, now: Date) => needsRefresh(tokens, now, 15 * 60);

export async function renewSignIns(deps: RenewDeps): Promise<{ reports: RenewReport[]; access: Record<string, string> }> {
  const { environment, save, mask, servers = oauthServers } = deps;
  const clock = deps.now ?? (() => new Date());
  const options = { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}), now: clock };
  const reports: RenewReport[] = [];
  const access: Record<string, string> = {};
  // Once one renewed sign-in could not be saved, the cause is likely the key or GitHub, not that vendor,
  // and every further renewal would lose another sign-in. The rest are left as they are stored.
  let saving = Boolean(save);
  for (const server of servers) {
    const vendor = server.id;
    const read = readStoredSignIn(environment[server.signInSecret], server);
    if (!read.ok) {
      reports.push(read.reason === "missing" ? { vendor, status: "not-connected" } : { vendor, status: "lost", detail: read.reason === "another-server" ? "the stored sign-in is for another server" : "the stored sign-in cannot be read" });
      continue;
    }
    const stored = read.signIn;
    // GitHub hides the secret as a whole, not the tokens inside it, so each is hidden on its own.
    for (const secret of secretsOf(stored)) mask(secret);
    const now = clock();
    const { refreshToken } = stored.tokens;
    if (!refreshToken || !save || !saving) {
      const off = !save ? "renewing is off here: no key to save a renewed sign-in with" : "renewing stopped in this run, after a renewed sign-in could not be saved";
      if (ranOut(stored.tokens, now)) {
        reports.push(refreshToken ? { vendor, status: "lost", detail: `it has run out, and ${off}`, ...(!save ? { fix: "set-up-app" as const } : {}) } : { vendor, status: "lost", detail: "it has run out, and the vendor gave no way to renew it" });
        continue;
      }
      access[vendor] = stored.tokens.accessToken;
      reports.push({ vendor, status: "kept", ...(refreshToken ? { detail: off } : {}) });
      continue;
    }

    const renewed = await refreshTokens(tokenServerOf(stored), stored.client, { refreshToken, resource: stored.resource }, options);
    if (renewed.outcome === "tokens") {
      for (const secret of secretsOf({ client: stored.client, tokens: renewed.tokens })) mask(secret);
      const { tokens } = renewed;
      if (![tokens.accessToken, tokens.refreshToken].every((value) => value === undefined || readToken(value).ok)) {
        reports.push({ vendor, status: "lost", detail: "the vendor renewed it with a token that cannot be kept" });
        continue;
      }
      const saved = await save(server.signInSecret, storedSignInText({ ...stored, tokens, renewedAt: now.toISOString() }));
      if (!saved) saving = false;
      access[vendor] = tokens.accessToken;
      reports.push(saved ? { vendor, status: "renewed" } : { vendor, status: "lost", detail: "it was renewed, but the renewed sign-in could not be saved, so the stored one may no longer work" });
      continue;
    }
    // 400 and 401 are the sign-in server's no: the refresh token or the client is no longer taken. 429 is a busy server.
    if (renewed.outcome === "refused" && renewed.status >= 400 && renewed.status < 500 && renewed.status !== 429) {
      reports.push({ vendor, status: "lost", detail: `the vendor would not renew it (HTTP ${renewed.status}${renewed.error ? `, ${renewed.error}` : ""})` });
      continue;
    }
    // A sign-in server that is down for a day: the access token may still do, and tomorrow's run tries again.
    // When it has run out too, the server cannot be read at all, and a person is told.
    if (ranOut(stored.tokens, now)) { reports.push({ vendor, status: "lost", detail: "its sign-in server could not be reached, and the access token has run out" }); continue; }
    access[vendor] = stored.tokens.accessToken;
    reports.push({ vendor, status: "unreachable", detail: "its sign-in server could not be reached" });
  }
  return { reports, access };
}

export type CheckStatus = "answered" | "refused" | "unreachable" | "token-echoed" | "no-token";
export interface CheckReport { vendor: string; status: CheckStatus; detail?: string }

/** A look that has not finished in time counts as unreachable, as in the tracker. */
async function withinTime(look: Promise<ListToolsResult>, ms: number): Promise<ListToolsResult | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try { return await Promise.race([look.catch(() => null), late]); }
  finally { clearTimeout(timer); }
}

export async function checkSignIns(access: Record<string, string>, deps: OAuthOptions & { servers?: readonly OAuthServer[] } = {}): Promise<CheckReport[]> {
  const { servers = oauthServers } = deps;
  const reports: CheckReport[] = [];
  for (const server of servers) {
    const vendor = server.id;
    const token = Object.hasOwn(access, vendor) ? access[vendor] : undefined;
    const read = readToken(token);
    if (!read.ok) { reports.push({ vendor, status: "no-token" }); continue; }
    const listed = await withinTime(listTools(server.url, { bearerToken: read.token, timeoutMs: deps.timeoutMs ?? 15_000, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }), 60_000);
    // Only the outcome is kept; for a server not yet published, what it lists is never looked at.
    if (listed && JSON.stringify(listed).includes(JSON.stringify(read.token).slice(1, -1))) reports.push({ vendor, status: "token-echoed" });
    else if (listed?.outcome === "listed") reports.push({ vendor, status: "answered" });
    else if (listed?.outcome === "sign-in-required") reports.push({ vendor, status: "refused", detail: `HTTP ${listed.status}` });
    else reports.push({ vendor, status: "unreachable" });
  }
  return reports;
}

/** What a person needs to do about one sign-in: something, nothing, or not yet known. */
export type Verdict = { vendor: string; name: string; verdict: "needs-person" | "fine" | "unknown"; detail?: string; fix?: "set-up-app" };

/** Puts the two steps' reports together. A step whose report is missing did not finish, so nothing is known from it. */
export function verdictsOf(renewed: RenewReport[], checked: CheckReport[], servers: readonly OAuthServer[] = oauthServers): Verdict[] {
  return servers.map((server) => {
    const renewal = renewed.find((report) => report.vendor === server.id);
    const look = checked.find((report) => report.vendor === server.id);
    const base = { vendor: server.id, name: server.name };
    if (renewal?.status === "lost") return { ...base, verdict: "needs-person", ...(renewal.detail ? { detail: renewal.detail } : {}), ...(renewal.fix ? { fix: renewal.fix } : {}) };
    if (look?.status === "refused") return { ...base, verdict: "needs-person", detail: `the server refused the sign-in (${look.detail ?? "refused"})` };
    if (look?.status === "token-echoed") return { ...base, verdict: "needs-person", detail: "the server sent the token back, so treat the sign-in as exposed: remove it in the vendor's settings first" };
    if (look?.status === "answered") return { ...base, verdict: "fine" };
    return { ...base, verdict: "unknown" };
  });
}

export const issueTitle = (name: string) => `Sign-in needs renewing: ${name}`;
export const unfinishedTitle = "Sign-in renewal did not finish";

export function issueBody(verdict: Verdict, server: OAuthServer): string {
  return [
    `The daily run could not keep the tracker's sign-in to ${server.name}: ${verdict.detail ?? "it no longer works"}.`,
    "",
    server.publish ? "Until it is renewed, the tracker shows this server as not read." : "This server is not published yet, so nothing on the tracker changes, but its sign-in has to be renewed before it can be.",
    "",
    ...(verdict.fix === "set-up-app" ? ["First set up the GitHub App that lets the run save renewed sign-ins (README, \"Browser sign-ins\"), or the new sign-in will run out in the same way.", ""] : []),
    `To sign in again, sign in to the vendor as the tracker's account and run this on a machine where gh is signed in:`,
    "",
    "```",
    `npm run scan -- connect-oauth ${server.id}`,
    "```",
    "",
    "This issue closes itself after the next run that reads the server with the new sign-in.",
  ].join("\n");
}

export interface IssueDeps {
  listOpen: () => Promise<Array<{ number: number; title: string }> | null>;
  open: (title: string, body: string) => Promise<boolean>;
  close: (issue: number, comment: string) => Promise<boolean>;
  print: (line: string) => void;
  servers?: readonly OAuthServer[];
}

/**
 * Opens one issue for each sign-in that needs a person, and closes it once the server is read
 * again. Resolves false when an issue could not be opened or closed: then nobody may have been
 * told, and the run must fail where people see it.
 */
export async function signInIssues(renewed: RenewReport[] | null, checked: CheckReport[] | null, today: string, deps: IssueDeps): Promise<boolean> {
  const { print, servers = oauthServers } = deps;
  const open = await deps.listOpen();
  if (!open) { print("Could not read the repository's open issues, so nobody could be told about a lost sign-in."); return false; }
  const openWith = (title: string) => open.find((issue) => issue.title === title);
  let delivered = true;
  const finished = renewed !== null && checked !== null;
  const unfinished = openWith(unfinishedTitle);
  if (!finished && !unfinished) delivered = (await deps.open(unfinishedTitle, "The daily run's sign-in steps did not finish, so no browser sign-in was renewed or checked. The run's log says which step stopped. This issue closes itself after a run in which they finish.")) && delivered;
  if (finished && unfinished) delivered = (await deps.close(unfinished.number, `The sign-in steps finished on ${today}.`)) && delivered;
  if (!finished) return delivered;

  for (const verdict of verdictsOf(renewed, checked, servers)) {
    const server = servers.find((candidate) => candidate.id === verdict.vendor) as OAuthServer;
    const existing = openWith(issueTitle(verdict.name));
    if (verdict.verdict === "needs-person" && !existing) {
      const ok = await deps.open(issueTitle(verdict.name), issueBody(verdict, server));
      print(ok ? `${verdict.vendor}: needs signing in again; an issue is open.` : `${verdict.vendor}: needs signing in again, and the issue could not be opened.`);
      delivered = ok && delivered;
    } else if (verdict.verdict === "fine" && existing) {
      const ok = await deps.close(existing.number, `Read again with the renewed sign-in on ${today}.`);
      print(ok ? `${verdict.vendor}: read again; its issue is closed.` : `${verdict.vendor}: read again, and its issue could not be closed.`);
      delivered = ok && delivered;
    }
  }
  return delivered;
}
