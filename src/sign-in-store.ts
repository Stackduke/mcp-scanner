import type { AuthorizationServer, Client, Tokens } from "./oauth.ts";
import { isHttps } from "./oauth.ts";
import type { OAuthServer } from "./signed-in.ts";
import { readToken } from "./signed-in.ts";

/**
 * A browser sign-in as the tracker keeps it: one repository secret per server, holding the client
 * that registered itself and the tokens it was given. It is written by `connect-oauth` and, after
 * each renewal, by the daily run, and read only by the daily run.
 *
 * The address tokens are renewed at is the one saved here at sign-in, not one asked of the server
 * each day, so a server that later names another sign-in server cannot have the tokens sent there.
 */
export interface StoredSignIn {
  version: 1;
  vendor: string;
  /** The MCP server's address, as the catalog has it. */
  server: string;
  /** The name the server gives itself, sent as `resource` so renewed tokens are made for it alone. */
  resource: string;
  issuer: string;
  tokenEndpoint: string;
  /** How the sign-in server lets a client prove itself, as it said at sign-in. */
  authMethods: string[];
  client: Client;
  tokens: Tokens;
  signedInAt: string;
  renewedAt?: string;
}

/** The largest stored sign-in kept. A repository secret holds at most 48 KB. */
const largest = 40_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown) => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
/** A credential: what can sit in a header or a form as it is. */
const isCredential = (value: unknown) => typeof value === "string" && value === value.trim() && readToken(value).ok;
const isWord = (value: unknown) => typeof value === "string" && /^[a-z_]{1,40}$/.test(value);

export type StoredRead = { ok: true; signIn: StoredSignIn } | { ok: false; reason: "missing" | "unreadable" | "another-server" };

/**
 * Reads a stored sign-in, and accepts it only for the server it is read for: the same vendor,
 * address and sign-in server as the catalog. Nothing in a refusal repeats what was stored.
 */
export function readStoredSignIn(text: string | undefined, server: Pick<OAuthServer, "id" | "url" | "issuer">): StoredRead {
  const raw = text?.trim() ?? "";
  if (!raw) return { ok: false, reason: "missing" };
  if (raw.length > largest) return { ok: false, reason: "unreadable" };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, reason: "unreadable" }; }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.client) || !isRecord(value.tokens)) return { ok: false, reason: "unreadable" };
  const { client, tokens } = value;
  const wellFormed = typeof value.vendor === "string" && typeof value.server === "string" && typeof value.issuer === "string"
    && typeof value.resource === "string" && isHttps(value.resource) && isHttps(value.tokenEndpoint)
    && Array.isArray(value.authMethods) && value.authMethods.length <= 10 && value.authMethods.every(isWord)
    && isCredential(client.clientId) && (client.clientSecret === undefined || isCredential(client.clientSecret)) && (client.authMethod === undefined || isWord(client.authMethod))
    && isCredential(tokens.accessToken) && (tokens.refreshToken === undefined || isCredential(tokens.refreshToken))
    && (tokens.expiresAt === undefined || isTime(tokens.expiresAt)) && (tokens.scope === undefined || (typeof tokens.scope === "string" && tokens.scope.length <= 2_000))
    && isTime(value.signedInAt) && (value.renewedAt === undefined || isTime(value.renewedAt));
  if (!wellFormed) return { ok: false, reason: "unreadable" };
  if (value.vendor !== server.id || value.server !== server.url || value.issuer !== server.issuer) return { ok: false, reason: "another-server" };
  return { ok: true, signIn: value as unknown as StoredSignIn };
}

/** What renewing needs to know about the sign-in server: only where tokens are made, and how a client proves itself there. */
export function tokenServerOf(signIn: StoredSignIn): AuthorizationServer {
  return { issuer: signIn.issuer, authorizationEndpoint: signIn.tokenEndpoint, tokenEndpoint: signIn.tokenEndpoint, metadataDocuments: false, authMethods: [...signIn.authMethods], sendsIssuer: false };
}

/** Every secret a stored sign-in holds, so each can be hidden from logs on its own. */
export function secretsOf(signIn: Pick<StoredSignIn, "client" | "tokens">): string[] {
  return [signIn.tokens.accessToken, signIn.tokens.refreshToken, signIn.client.clientSecret].filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** One line, so the whole value is a single secret to GitHub. */
export const storedSignInText = (signIn: StoredSignIn) => JSON.stringify(signIn);
