import { readFileSync } from "node:fs";
import type { Discovery } from "./oauth.ts";
import { printable } from "./text.ts";

/**
 * The servers Stackduke supports officially, in `catalog/servers.json`. The dashboard reads the
 * same file for its list of servers to connect, and the tracker reads it to know which servers it
 * watches with a login and which it may publish anything about.
 *
 * The file is checked when it is loaded: a mistake in it stops the scanner rather than sending a
 * token somewhere unexpected or publishing a server whose terms forbid it.
 */

/** How a customer's Connect button signs in to the server. */
export type SignIn =
  /** OAuth, with Stackduke's client metadata document as the client ID. The server needs no registration. */
  | "oauth-metadata-doc"
  /** OAuth, with the client registering itself automatically (dynamic client registration). */
  | "oauth-dcr"
  /** OAuth, with an app Stackduke must register with the vendor first. */
  | "oauth-app"
  /** A key the customer makes and pastes. */
  | "api-key";

/** The group a server is listed under when there are many to choose from. */
export const categories = ["Developer tools", "Payments", "Data and infrastructure", "Work apps"] as const;
export type Category = (typeof categories)[number];

/** How the tracker reaches the server with Stackduke's own account. */
export interface TrackerApiKey {
  kind: "api-key";
  /** The environment variable the token is read from. Tokens are never taken from an argument. */
  tokenVariable: string;
  /** A name the variable had before, still read when the current one is unset. */
  formerVariable?: string;
  /** Where the account owner makes the token, and what to make: the least the server needs to list its tools. */
  keyPage: string;
  keyAdvice: string;
}

/**
 * How the tracker reaches a server that takes only a browser sign-in. A person signs in once with
 * `connect-oauth`; the registered client and its tokens are kept as one repository secret, which
 * the daily run renews and writes back.
 */
export interface TrackerOAuth {
  kind: "oauth";
  /** The repository secret that holds the sign-in. Named after the server, like a token variable. */
  signInSecret: string;
  /**
   * The sign-in server the MCP server named when the tracker's account signed in. A sign-in to any
   * other is refused, and the daily run renews only at the token address saved with the sign-in.
   */
  issuer: string;
  /** The scopes to ask for: read-only ones where the server offers them. Empty: none named, the server decides. */
  scopes: string[];
  /** What the person signing in should know: which account to use, and what the scopes allow. */
  scopeAdvice: string;
}

export type TrackerAccess = TrackerApiKey | TrackerOAuth;

export type TrackerEntry =
  | { publish: true; access: TrackerAccess }
  /**
   * Not published. The reason says why. `forbidden` means the vendor's terms forbid publishing
   * about the service, so no address on its sites is checked or kept, wherever the registry lists
   * one. Without it, the registry's addresses are treated as any other.
   *
   * A browser sign-in may be kept for a server that is not published yet, so it is ready the day
   * its terms are read: the daily run renews it and checks it works, and keeps nothing it lists.
   */
  | { publish: false; reason: string; forbidden?: boolean; access?: TrackerOAuth }
  /**
   * Tracked privately: watched with the tracker's own account every day, like a published server,
   * but nothing it lists reaches the public data. Its files go to a private folder that the daily
   * run commits to a private repository, and the run skips it when that folder is not given.
   * Decided by Dom on 24 October 2026 for every server that needs a sign-in: publishing about them
   * carries terms risk, so the public tracker shows only servers that answer with no sign-in.
   */
  | { publish: false; private: true; reason: string; access: TrackerAccess };

/**
 * A server the public tracker shows that answers its tool list with no sign-in, from
 * `catalog/tracker-public.json`. It is read the way any MCP client reads it: no account, no token
 * and no sign-up. A vendor's general terms may still cover using its server.
 */
export interface PublicServer {
  id: string;
  name: string;
  url: string;
  site: string;
}

export interface PublicList { version: 1; about?: string; servers: PublicServer[] }

export interface CatalogServer {
  /** Short and stable: used in file names, addresses and the tracker's data. */
  id: string;
  name: string;
  url: string;
  site: string;
  category: Category;
  signIn: SignIn;
  /** When someone last confirmed how the server signs in, as YYYY-MM-DD. */
  signInCheckedOn: string;
  /** When someone last read the vendor's terms for what may be published, or null if nobody has. */
  termsCheckedOn: string | null;
  tracker: TrackerEntry;
}

export interface Catalog { version: 1; servers: CatalogServer[] }

const signIns: readonly string[] = ["oauth-metadata-doc", "oauth-dcr", "oauth-app", "api-key"];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A real day: 2026-02-30 does not survive the round trip. */
const isDay = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
/** Text the console and the tracker will show: no control or invisible characters. */
const isText = (value: unknown, longest: number) => typeof value === "string" && value.trim().length > 0 && value.length <= longest && printable(value, longest) === value;

/** An https address with nothing in it that could carry a secret or point somewhere else. */
function isPlainHttps(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && (url.href === value || url.href === `${value}/`);
}

/** Every problem with a catalog, or none. Each problem names the server it is in. */
export function catalogProblems(value: unknown): string[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.servers)) return ["the catalog must be { version: 1, servers: [...] }"];
  const problems: string[] = [];
  const ids = new Set<string>(), urls = new Set<string>(), variables = new Set<string>();
  value.servers.forEach((server: unknown, index) => {
    const at = isRecord(server) && typeof server.id === "string" ? server.id : `server ${index + 1}`;
    const problem = (text: string) => problems.push(`${at}: ${text}`);
    if (!isRecord(server)) return problem("must be an object");
    if (typeof server.id !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(server.id)) problem("id must be lower-case letters, digits and hyphens");
    else if (ids.has(server.id)) problem("id is used twice"); else ids.add(server.id);
    if (!isText(server.name, 80)) problem("needs a name");
    if (!isPlainHttps(server.url)) problem("url must be a plain https address");
    else if (urls.has((server.url as string).replace(/\/$/, ""))) problem("url is used twice"); else urls.add((server.url as string).replace(/\/$/, ""));
    if (!isPlainHttps(server.site)) problem("site must be a plain https address");
    if (typeof server.category !== "string" || !(categories as readonly string[]).includes(server.category)) problem(`category must be one of ${categories.join(", ")}`);
    if (typeof server.signIn !== "string" || !signIns.includes(server.signIn)) problem(`signIn must be one of ${signIns.join(", ")}`);
    if (!isDay(server.signInCheckedOn)) problem("signInCheckedOn must be a date, YYYY-MM-DD");
    if (server.termsCheckedOn !== null && !isDay(server.termsCheckedOn)) problem("termsCheckedOn must be a date or null");
    const tracker = server.tracker;
    if (!isRecord(tracker) || typeof tracker.publish !== "boolean") return problem("tracker must say whether it is published");
    if (!tracker.publish) {
      if (!isText(tracker.reason, 300)) problem("a server the tracker does not publish needs a reason");
      if (tracker.forbidden !== undefined && typeof tracker.forbidden !== "boolean") problem("forbidden must be true or false");
      if (tracker.forbidden === true && server.termsCheckedOn === null) problem("is marked forbidden, but nobody has read its terms");
      if (tracker.private !== undefined && tracker.private !== true) problem("private can only be true");
      if (tracker.private === true) {
        // A vendor whose terms forbid publishing may still be tracked privately; one marked forbidden is not touched at all.
        if (tracker.forbidden === true) return problem("is marked forbidden, so it is not tracked, privately or not");
        return accessProblems(server, tracker.access, problem, variables);
      }
      if (tracker.access === undefined) return;
      // A vendor whose terms forbid publishing is not signed in to at all.
      if (tracker.forbidden === true) return problem("is marked forbidden, so it keeps no sign-in");
      if (!isRecord(tracker.access) || tracker.access.kind !== "oauth") return problem("a server that is not published can keep only a browser sign-in");
      return oauthProblems(server, tracker.access, problem, variables);
    }
    // Publishing is the one thing a vendor's terms can forbid, so nobody publishes before reading them.
    if (server.termsCheckedOn === null) problem("is published, but nobody has read its terms");
    return accessProblems(server, tracker.access, problem, variables);
  });
  return problems;
}

/** The tracker's access to a server it watches with its own account, published or tracked privately. */
function accessProblems(server: Record<string, unknown>, access: unknown, problem: (text: string) => void, variables: Set<string>): void {
  if (isRecord(access) && access.kind === "oauth") return oauthProblems(server, access, problem, variables);
  if (!isRecord(access) || access.kind !== "api-key") return problem("tracker access must be an api-key or oauth");
  // The variable is named after the server, so an edit cannot hand one vendor's token to another.
  const expected = tokenVariableOf(String(server.id));
  if (access.tokenVariable !== expected) problem(`its token variable must be ${expected}`);
  if (access.formerVariable !== undefined && access.formerVariable !== `AETHIS_SCAN_${String(server.id).toUpperCase().replaceAll("-", "_")}_TOKEN`) problem("a former token variable can only be the AETHIS_SCAN_ name for the same server");
  for (const name of [access.tokenVariable, access.formerVariable]) {
    if (typeof name !== "string") continue;
    if (variables.has(name)) problem(`${name} is used twice`); else variables.add(name);
  }
  if (!isPlainHttps(access.keyPage)) problem("keyPage must be a plain https address");
  if (!isText(access.keyAdvice, 300)) problem("needs keyAdvice");
}

/** Every problem with the public list, or none. It must not name a server the catalog tracks with a sign-in. */
export function publicListProblems(value: unknown, servers: readonly CatalogServer[]): string[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.servers)) return ["the public list must be { version: 1, servers: [...] }"];
  if (value.about !== undefined && !isText(value.about, 600)) return ["about must be plain text"];
  const problems: string[] = [];
  const catalogIds = new Set(servers.map((server) => server.id));
  const catalogUrls = new Set(servers.map((server) => server.url.replace(/\/$/, "")));
  const ids = new Set<string>(), urls = new Set<string>();
  value.servers.forEach((server: unknown, index) => {
    const at = isRecord(server) && typeof server.id === "string" ? server.id : `server ${index + 1}`;
    const problem = (text: string) => problems.push(`${at}: ${text}`);
    if (!isRecord(server)) return problem("must be an object");
    const known = new Set(["id", "name", "url", "site"]);
    for (const key of Object.keys(server)) if (!known.has(key)) problem(`has a field this version does not know: ${key}`);
    if (typeof server.id !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(server.id)) problem("id must be lower-case letters, digits and hyphens");
    else if (ids.has(server.id)) problem("id is used twice");
    else if (catalogIds.has(server.id)) problem("id is already a server in the catalog");
    else ids.add(server.id);
    // Radar refuses the whole list if one name breaks this rule (SERVER_NAME_PATTERN in its types.ts).
    if (typeof server.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(server.name)) problem("name must be letters, digits, spaces, dots, underscores or hyphens, up to 60 characters");
    if (!isPlainHttps(server.url)) problem("url must be a plain https address");
    else {
      const url = (server.url as string).replace(/\/$/, "");
      if (urls.has(url)) problem("url is used twice");
      else if (catalogUrls.has(url)) problem("url is a server the catalog tracks with a sign-in, which is never published");
      else urls.add(url);
    }
    if (!isPlainHttps(server.site)) problem("site must be a plain https address");
  });
  return problems;
}

export function readPublicList(text: string, servers: readonly CatalogServer[]): PublicList {
  const value: unknown = JSON.parse(text);
  const problems = publicListProblems(value, servers);
  if (problems.length) throw new Error(`catalog/tracker-public.json is not usable:\n  ${problems.join("\n  ")}`);
  return value as PublicList;
}

/** The variable a server's token is read from. For a browser sign-in, the run's renewed access token is handed over under it. */
export const tokenVariableOf = (id: string) => `STACKDUKE_SCAN_${id.toUpperCase().replaceAll("-", "_")}_TOKEN`;
/** The repository secret that holds a server's browser sign-in. */
export const signInSecretOf = (id: string) => `STACKDUKE_OAUTH_${id.toUpperCase().replaceAll("-", "_")}`;

/** An OAuth scope: no spaces, quotes or anything else that could change what is asked for. */
const isScope = (value: unknown) => typeof value === "string" && /^[\w:.\-/]{1,100}$/.test(value);

function oauthProblems(server: Record<string, unknown>, access: Record<string, unknown>, problem: (text: string) => void, variables: Set<string>): void {
  if (server.signIn !== "oauth-dcr") problem("a browser sign-in for the tracker needs signIn oauth-dcr: the client registers itself");
  const expected = signInSecretOf(String(server.id));
  if (access.signInSecret !== expected) problem(`its sign-in secret must be ${expected}`);
  else if (variables.has(expected)) problem(`${expected} is used twice`); else variables.add(expected);
  if (!isPlainHttps(access.issuer)) problem("issuer must be a plain https address");
  if (!Array.isArray(access.scopes) || access.scopes.length > 30 || !access.scopes.every(isScope)) problem("scopes must be a list of plain scope names");
  if (!isText(access.scopeAdvice, 300)) problem("needs scopeAdvice");
}

export function readCatalog(text: string): Catalog {
  const value: unknown = JSON.parse(text);
  const problems = catalogProblems(value);
  if (problems.length) throw new Error(`catalog/servers.json is not usable:\n  ${problems.join("\n  ")}`);
  return value as Catalog;
}

export const catalog: Readonly<Catalog> = readCatalog(readFileSync(new URL("../catalog/servers.json", import.meta.url), "utf8"));

/** The servers the public tracker shows, all answering with no sign-in. */
export const publicList: Readonly<PublicList> = readPublicList(readFileSync(new URL("../catalog/tracker-public.json", import.meta.url), "utf8"), catalog.servers);

/**
 * How a server signs in, from what it says about itself: what a new catalog entry's `signIn`
 * should be. A server that wants a login but says nothing about OAuth most likely takes a key.
 */
export function signInFrom(found: Discovery): SignIn | "open" | "unsafe" | "unreachable" | "not-usable" {
  if (found.outcome === "open") return "open";
  if (found.outcome === "no-pkce") return "unsafe";
  if (found.outcome === "unreachable" || found.outcome === "not-usable") return found.outcome;
  if (found.outcome === "no-oauth") return "api-key";
  if (found.authorizationServer.metadataDocuments) return "oauth-metadata-doc";
  return found.authorizationServer.registrationEndpoint ? "oauth-dcr" : "oauth-app";
}
