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
  /** A name the variable had before, still read when the current one is unset. */
  formerVariable?: string;
  /** Where the account owner makes the token, and what to make: the least the server needs to list its tools. */
  keyPage: string;
  keyAdvice: string;
}

/**
 * Each token should belong to an account made for the tracker that holds nothing of value: the
 * server shows the tools that token may see, and the token sits in the tracker's secrets.
 * Checked against each vendor's documentation on 2026-10-16. Vendors whose servers take only a
 * browser sign-in, or whose terms need reading first, are not here yet.
 */
export const signedInServers: Readonly<Record<string, SignedInServer>> = {
  github: {
    url: "https://api.githubcopilot.com/mcp/", tokenVariable: "STACKDUKE_SCAN_GITHUB_TOKEN", formerVariable: "AETHIS_SCAN_GITHUB_TOKEN",
    keyPage: "https://github.com/settings/personal-access-tokens/new",
    keyAdvice: "A fine-grained token with read-only access to public repositories and no other permissions.",
  },
  linear: {
    url: "https://mcp.linear.app/mcp", tokenVariable: "STACKDUKE_SCAN_LINEAR_TOKEN",
    keyPage: "https://linear.app/settings/account/security",
    keyAdvice: "A personal API key with Read only, in a workspace that holds nothing.",
  },
  stripe: {
    url: "https://mcp.stripe.com/", tokenVariable: "STACKDUKE_SCAN_STRIPE_TOKEN",
    keyPage: "https://dashboard.stripe.com/test/apikeys",
    keyAdvice: "A restricted key in a sandbox (test mode), made for agent access, with every resource on Read or None. It starts rk_test_.",
  },
  supabase: {
    url: "https://mcp.supabase.com/mcp", tokenVariable: "STACKDUKE_SCAN_SUPABASE_TOKEN",
    keyPage: "https://supabase.com/dashboard/account/tokens",
    keyAdvice: "A personal access token. It reaches the whole account, so use an account with one empty project.",
  },
};

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
  const { url, tokenVariable } = server;
  const read = readToken(tokenFor(server, environment));
  if (!read.ok) return { outcome: "no-token", tokenVariable, reason: read.reason };
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") return { outcome: "unsafe-connection", tokenVariable };
  const result = await listTools(url, { bearerToken: read.token, ...(fetchImpl ? { fetchImpl } : {}) });
  // Everything in the result is the server's text and is about to be printed and perhaps saved.
  if (JSON.stringify(result).includes(JSON.stringify(read.token).slice(1, -1))) return { outcome: "token-echoed", url };
  return { outcome: "answered", url, tokenVariable, result };
}
