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

export type TrackerEntry =
  | { publish: true; access: TrackerApiKey }
  /** Not watched, and nothing about it is published. The reason says why. */
  | { publish: false; reason: string };

export interface CatalogServer {
  /** Short and stable: used in file names, addresses and the tracker's data. */
  id: string;
  name: string;
  url: string;
  site: string;
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
    if (typeof server.signIn !== "string" || !signIns.includes(server.signIn)) problem(`signIn must be one of ${signIns.join(", ")}`);
    if (!isDay(server.signInCheckedOn)) problem("signInCheckedOn must be a date, YYYY-MM-DD");
    if (server.termsCheckedOn !== null && !isDay(server.termsCheckedOn)) problem("termsCheckedOn must be a date or null");
    const tracker = server.tracker;
    if (!isRecord(tracker) || typeof tracker.publish !== "boolean") return problem("tracker must say whether it is published");
    if (!tracker.publish) {
      if (!isText(tracker.reason, 300)) problem("a server the tracker does not publish needs a reason");
      return;
    }
    // Publishing is the one thing a vendor's terms can forbid, so nobody publishes before reading them.
    if (server.termsCheckedOn === null) problem("is published, but nobody has read its terms");
    const access = tracker.access;
    if (!isRecord(access) || access.kind !== "api-key") return problem("tracker access must be an api-key");
    // The variable is named after the server, so an edit cannot hand one vendor's token to another.
    const expected = `STACKDUKE_SCAN_${String(server.id).toUpperCase().replaceAll("-", "_")}_TOKEN`;
    if (access.tokenVariable !== expected) problem(`its token variable must be ${expected}`);
    if (access.formerVariable !== undefined && access.formerVariable !== `AETHIS_SCAN_${String(server.id).toUpperCase().replaceAll("-", "_")}_TOKEN`) problem("a former token variable can only be the AETHIS_SCAN_ name for the same server");
    for (const name of [access.tokenVariable, access.formerVariable]) {
      if (typeof name !== "string") continue;
      if (variables.has(name)) problem(`${name} is used twice`); else variables.add(name);
    }
    if (!isPlainHttps(access.keyPage)) problem("keyPage must be a plain https address");
    if (!isText(access.keyAdvice, 300)) problem("needs keyAdvice");
  });
  return problems;
}

export function readCatalog(text: string): Catalog {
  const value: unknown = JSON.parse(text);
  const problems = catalogProblems(value);
  if (problems.length) throw new Error(`catalog/servers.json is not usable:\n  ${problems.join("\n  ")}`);
  return value as Catalog;
}

export const catalog: Readonly<Catalog> = readCatalog(readFileSync(new URL("../catalog/servers.json", import.meta.url), "utf8"));

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
