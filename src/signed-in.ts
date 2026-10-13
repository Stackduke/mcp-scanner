import { listTools } from "./client.ts";
import type { ListToolsResult } from "./client.ts";

/**
 * The servers this scanner may send a credential to.
 *
 * A token is only ever paired with the address written here. No command-line argument can point
 * a token at another host, and the client refuses redirects, so a server cannot pass it on either.
 */
export interface SignedInServer {
  url: string;
  /** The environment variable the token is read from. Tokens are never taken from an argument. */
  tokenVariable: string;
}

export const signedInServers: Readonly<Record<string, SignedInServer>> = {
  github: { url: "https://api.githubcopilot.com/mcp/", tokenVariable: "AETHIS_SCAN_GITHUB_TOKEN" },
};

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
  const { url, tokenVariable } = server;
  const read = readToken(environment[tokenVariable]);
  if (!read.ok) return { outcome: "no-token", tokenVariable, reason: read.reason };
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") return { outcome: "unsafe-connection", tokenVariable };
  const result = await listTools(url, { bearerToken: read.token, ...(fetchImpl ? { fetchImpl } : {}) });
  // Everything in the result is the server's text and is about to be printed and perhaps saved.
  if (JSON.stringify(result).includes(JSON.stringify(read.token).slice(1, -1))) return { outcome: "token-echoed", url };
  return { outcome: "answered", url, tokenVariable, result };
}
