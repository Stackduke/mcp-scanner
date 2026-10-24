import { listTools } from "./client.ts";
import type { ListToolsResult } from "./client.ts";
import { catalog, tokenVariableOf } from "./catalog.ts";
import type { CatalogServer } from "./catalog.ts";

/**
 * The servers this scanner may send a credential to, from `catalog/servers.json`.
 *
 * A token is only ever paired with the address written here. No command-line argument can point
 * a token at another host, and the client refuses redirects, so a server cannot pass it on either.
 */
export type SignedInServer = {
  url: string;
  /**
   * The environment variable the token is read from. Tokens are never taken from an argument.
   * For a browser sign-in it holds the access token the run has just renewed, handed over in a file.
   */
  tokenVariable: string;
  /** A name the variable had before, still read when the current one is unset. */
  formerVariable?: string;
  /** False for a server tracked privately: what it lists never reaches the public data. */
  publish: boolean;
} & (
  /** Where the account owner makes the token, and what to make: the least the server needs to list its tools. */
  | { kind: "api-key"; keyPage: string; keyAdvice: string }
  | { kind: "oauth" }
);

/** A server the tracker keeps a browser sign-in for, published or not. */
export interface OAuthServer {
  id: string;
  name: string;
  url: string;
  publish: boolean;
  /** Scanned each day, published or privately. A server kept signed in only, ready for later, is not. */
  tracked: boolean;
  tokenVariable: string;
  signInSecret: string;
  issuer: string;
  scopes: readonly string[];
  scopeAdvice: string;
}

export function oauthServersOf(servers: readonly CatalogServer[]): readonly OAuthServer[] {
  return Object.freeze(servers.flatMap((server) => {
    const access = server.tracker.access;
    if (access?.kind !== "oauth") return [];
    const { signInSecret, issuer, scopes, scopeAdvice } = access;
    const tracked = server.tracker.publish || ("private" in server.tracker && server.tracker.private === true);
    return [Object.freeze({ id: server.id, name: server.name, url: server.url, publish: server.tracker.publish, tracked, tokenVariable: tokenVariableOf(server.id), signInSecret, issuer, scopes: Object.freeze([...scopes]), scopeAdvice })];
  }));
}

export const oauthServers: readonly OAuthServer[] = oauthServersOf(catalog.servers);

/**
 * The servers in the catalog that the tracker watches with its own account: those it publishes, and
 * those it tracks privately (`publish` false), whose files never reach the public data. Each token
 * should belong to an account made for the tracker that holds nothing of value: the server shows
 * the tools that token may see, and the token sits in the tracker's secrets. A server whose terms
 * forbid it, or that is kept signed in only, is in the catalog but not here.
 */
export function signedInServersOf(servers: readonly CatalogServer[]): Readonly<Record<string, SignedInServer>> {
  const entries = servers.flatMap((server): Array<readonly [string, SignedInServer]> => {
    const tracker = server.tracker;
    const access = tracker.publish ? tracker.access : "private" in tracker && tracker.private === true ? tracker.access : undefined;
    if (!access) return [];
    const publish = tracker.publish;
    if (access.kind === "oauth") return [[server.id, Object.freeze({ url: server.url, tokenVariable: tokenVariableOf(server.id), publish, kind: "oauth" as const })]];
    const { tokenVariable, formerVariable, keyPage, keyAdvice } = access;
    return [[server.id, Object.freeze({ url: server.url, tokenVariable, ...(formerVariable ? { formerVariable } : {}), publish, kind: "api-key" as const, keyPage, keyAdvice })]];
  });
  return Object.freeze(Object.fromEntries(entries));
}

export const signedInServers: Readonly<Record<string, SignedInServer>> = signedInServersOf(catalog.servers);

/** The token for a server, from its variable or, when that is unset or empty, the variable's former name. */
export function tokenFor(server: SignedInServer, environment: Record<string, string | undefined>): string | undefined {
  const current = environment[server.tokenVariable];
  return current?.trim() || !server.formerVariable ? current : environment[server.formerVariable];
}

export type TokenRead = { ok: true; token: string } | { ok: false; reason: "missing" | "malformed" };

const longestToken = 4_096;

/** Accepts only what can sit in a header as it is. The value is never echoed back, whatever is wrong with it. */
export function readToken(value: string | undefined): TokenRead {
  const token = value?.trim() ?? "";
  if (!token) return { ok: false, reason: "missing" };
  if (token.length > longestToken || !/^[\x21-\x7e]+$/.test(token)) return { ok: false, reason: "malformed" };
  return { ok: true, token };
}

export type SignedInScan =
  | { outcome: "unknown-server" }
  | { outcome: "no-token"; tokenVariable: string; reason: "missing" | "malformed" }
  /** Certificate checking is switched off in this environment, so the server cannot be told from an impostor. */
  | { outcome: "unsafe-connection"; tokenVariable: string }
  /** The server sent the token back in what it returned. Nothing it returned is passed on. */
  | { outcome: "token-echoed"; url: string }
  | { outcome: "answered"; url: string; tokenVariable: string; result: ListToolsResult };

/**
 * The only place a token meets an address. The name picks both the address and the variable the
 * token is read from; nothing else the caller passes can change where the token goes.
 */
export async function scanSignedIn(name: string, environment: Record<string, string | undefined>, fetchImpl?: typeof fetch): Promise<SignedInScan> {
  const server = Object.hasOwn(signedInServers, name) ? signedInServers[name] : undefined;
  if (!server) return { outcome: "unknown-server" };
  return listWithToken(server.url, server.tokenVariable, tokenFor(server, environment), environment, fetchImpl ? { fetchImpl } : {});
}

export interface TokenListOptions { fetchImpl?: typeof fetch; timeoutMs?: number }

/**
 * Lists one server's tools with a token, under the rules every token here follows: https only,
 * nothing sent when certificate checking is switched off, no redirect, and nothing kept from a
 * reply that sends the token back. The caller decides which address goes with which variable.
 */
export async function listWithToken(url: string, tokenVariable: string, value: string | undefined, environment: Record<string, string | undefined>, { fetchImpl, timeoutMs }: TokenListOptions = {}): Promise<SignedInScan> {
  const read = readToken(value);
  if (!read.ok) return { outcome: "no-token", tokenVariable, reason: read.reason };
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") return { outcome: "unsafe-connection", tokenVariable };
  const result = await listTools(url, { bearerToken: read.token, ...(fetchImpl ? { fetchImpl } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  // Everything in the result is the server's text and is about to be printed and perhaps saved.
  if (JSON.stringify(result).includes(JSON.stringify(read.token).slice(1, -1))) return { outcome: "token-echoed", url };
  return { outcome: "answered", url, tokenVariable, result };
}
