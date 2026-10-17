import { createHash, randomBytes } from "node:crypto";
import { userAgent } from "./client.ts";

/**
 * Signing in to an MCP server the standard way (the MCP authorization spec, 2025-11-25), with no
 * code for any one vendor. The steps are the ones a Connect button takes:
 *
 *   discover   ask the server without a login; its 401 names where it describes itself, and that
 *              names the sign-in server; the sign-in server's own description says what it accepts
 *   register   use an app registered in advance, Stackduke's client metadata document, or the
 *              server's automatic registration, in that order
 *   authorize  send the person to the vendor's sign-in page with PKCE, and read where it sends them back
 *   tokens     swap the code for tokens, and renew them before they run out, keeping the new
 *              refresh token each time, since most servers give a new one and stop taking the old
 *
 * Every address it contacts must be https, no request follows a redirect, every reply is read
 * only up to a limit, and no token or secret ever appears in a result's text.
 */

export interface OAuthOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** What the sign-in server says about itself, reduced to what a client needs. */
export interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** It takes an https address of a client metadata document as a client ID. */
  metadataDocuments: boolean;
  /** How it lets a client prove itself at the token endpoint. */
  authMethods: string[];
  /** It adds `iss` to the address it sends the person back to, so a mix-up can be caught. */
  sendsIssuer: boolean;
}

export type Discovery =
  | {
    outcome: "oauth";
    /** The name the server gives itself, sent as `resource` so tokens are made for this server only. */
    resource: string;
    /** The scopes to ask for: what the 401 asked for, else what the server lists, else none named. */
    scopes: string[];
    authorizationServer: AuthorizationServer;
    /** The server does not describe itself, so its own address was taken as the sign-in server (the 2025-03-26 way). */
    olderDiscovery: boolean;
  }
  /** It answered without asking for a login. */
  | { outcome: "open" }
  /** It answered 401 but describes no OAuth sign-in: an API key, or something of its own. */
  | { outcome: "no-oauth"; detail: string }
  /** Its answer was not one a sign-in can start from: another status, too large a reply, or an address that is not https. */
  | { outcome: "not-usable"; detail: string }
  /** Its sign-in server does not offer PKCE with S256, so it is not safe to sign in to. */
  | { outcome: "no-pkce" }
  | { outcome: "unreachable"; detail: string };

const maxReplyBytes = 64_000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

class Refused extends Error {}

export function isHttps(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}

/** Node sends requests without checking certificates when this is set, so no credential may go out. */
const certificatesUnchecked = () => process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0";

/**
 * One request with a whole-request time limit. An ordinary timer is used because it keeps Node
 * running while the request waits, so a stalled request ends as a failure rather than the process
 * simply stopping.
 */
async function request(url: string, init: RequestInit, { fetchImpl = fetch, timeoutMs = 15_000 }: OAuthOptions): Promise<{ status: number; headers: Headers; text: string }> {
  if (!isHttps(url)) throw new Refused("only https addresses are contacted");
  if (certificatesUnchecked()) throw new Refused("certificate checking is switched off here");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, headers: { "User-Agent": userAgent, ...(init.headers as Record<string, string>) }, redirect: "error", signal: controller.signal });
    let text = "";
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { text += decoder.decode(); break; }
        received += value.byteLength;
        // Not waited for: a cancel can wait on the other end, and the reply is being dropped either way.
        if (received > maxReplyBytes) { reader.cancel().catch(() => undefined); throw new Refused("a reply was larger than expected"); }
        text += decoder.decode(value, { stream: true });
      }
    }
    return { status: response.status, headers: response.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, options: OAuthOptions): Promise<Record<string, unknown> | null> {
  try {
    const reply = await request(url, { method: "GET", headers: { Accept: "application/json" } }, options);
    if (reply.status !== 200) return null;
    const value: unknown = JSON.parse(reply.text);
    return isRecord(value) ? value : null;
  } catch {
    // A description that cannot be fetched or read is one that is not there; the next address is tried.
    return null;
  }
}

/** The parameters of a `WWW-Authenticate: Bearer ...` header. Unknown or malformed parts are ignored. */
export function readChallenge(header: string | null): Record<string, string> {
  const found: Record<string, string> = {};
  if (!header) return found;
  // A header may hold several challenges; only the Bearer one's parameters are read, up to the next scheme.
  const start = /(?:^|,)\s*bearer(?=\s|$|,)/i.exec(header);
  if (!start) return found;
  const pattern = /\s*,?\s*([a-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/giy;
  pattern.lastIndex = start.index + start[0].length;
  for (let match = pattern.exec(header); match; match = pattern.exec(header)) {
    const name = (match[1] as string).toLowerCase();
    if (!Object.hasOwn(found, name)) found[name] = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return found;
}

/** Where a server's own description may be, in the order the spec says to try. */
export function resourceMetadataAddresses(serverUrl: string, fromHeader?: string): string[] {
  const { origin, pathname } = new URL(serverUrl);
  const addresses = fromHeader && isHttps(fromHeader) ? [fromHeader] : [];
  if (pathname !== "/") addresses.push(`${origin}/.well-known/oauth-protected-resource${pathname}`);
  addresses.push(`${origin}/.well-known/oauth-protected-resource`);
  return [...new Set(addresses)];
}

/** Where a sign-in server's description may be, in the order the spec says to try. */
export function authorizationMetadataAddresses(issuer: string): string[] {
  const { origin, pathname } = new URL(issuer);
  const path = pathname === "/" ? "" : pathname.replace(/\/$/, "");
  if (!path) return [`${origin}/.well-known/oauth-authorization-server`, `${origin}/.well-known/openid-configuration`];
  return [`${origin}/.well-known/oauth-authorization-server${path}`, `${origin}/.well-known/openid-configuration${path}`, `${origin}${path}/.well-known/openid-configuration`];
}

/** A sign-in server's description, if it is one, for this issuer, with https endpoints. */
export function readAuthorizationServer(value: Record<string, unknown>, issuer: string): AuthorizationServer | null {
  // A description that names another issuer may have been planted, so it is not used (RFC 8414, 3.3).
  if (value.issuer !== issuer) return null;
  const { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint, registration_endpoint: registrationEndpoint } = value;
  if (!isHttps(authorizationEndpoint) || !isHttps(tokenEndpoint)) return null;
  return {
    issuer: value.issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(isHttps(registrationEndpoint) ? { registrationEndpoint } : {}),
    metadataDocuments: value.client_id_metadata_document_supported === true,
    // When the list is absent, RFC 8414 says the default is client_secret_basic.
    authMethods: Array.isArray(value.token_endpoint_auth_methods_supported) ? strings(value.token_endpoint_auth_methods_supported) : ["client_secret_basic"],
    sendsIssuer: value.authorization_response_iss_parameter_supported === true,
  };
}

/** Whether a name a server gives itself covers this address: the same origin, and the same path or a parent of it. */
export function namesThisServer(name: string, serverUrl: string): boolean {
  let named: URL;
  try { named = new URL(name); } catch { return false; }
  const asked = new URL(serverUrl);
  if (named.origin !== asked.origin || named.search || named.hash || named.username || named.password) return false;
  const parent = named.pathname.replace(/\/$/, "");
  return asked.pathname.replace(/\/$/, "") === parent || asked.pathname.startsWith(`${parent}/`);
}

/** Asks a server how to sign in to it. Sends no credential. */
export async function discover(serverUrl: string, options: OAuthOptions = {}): Promise<Discovery> {
  if (!isHttps(serverUrl)) return { outcome: "not-usable", detail: "only https servers are signed in to" };
  try {
    const hello = await request(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stackduke-mcp-scanner", version: "0.2" } } }),
    }, options);
    if (hello.status >= 200 && hello.status < 300) return { outcome: "open" };
    if (hello.status !== 401) return { outcome: "not-usable", detail: `the server answered ${hello.status}` };
    const challenge = readChallenge(hello.headers.get("WWW-Authenticate"));

    let resource = serverUrl, listedScopes: string[] = [], issuer: string | undefined, olderDiscovery = false;
    for (const address of resourceMetadataAddresses(serverUrl, challenge.resource_metadata)) {
      const described = await getJson(address, options);
      if (!described || typeof described.resource !== "string") continue;
      // The server names itself; the name must be this server, so tokens made for it cannot be used elsewhere.
      if (!namesThisServer(described.resource, serverUrl)) continue;
      const first = strings(described.authorization_servers).find(isHttps);
      if (!first) continue;
      resource = described.resource; listedScopes = strings(described.scopes_supported); issuer = first;
      break;
    }
    if (!issuer) { issuer = new URL(serverUrl).origin; olderDiscovery = true; }

    let authorizationServer: AuthorizationServer | null = null;
    let offersPkce = false;
    for (const address of authorizationMetadataAddresses(issuer)) {
      const described = await getJson(address, options);
      if (!described) continue;
      authorizationServer = readAuthorizationServer(described, issuer);
      offersPkce = strings(described.code_challenge_methods_supported).includes("S256");
      if (authorizationServer) break;
    }
    if (!authorizationServer) return olderDiscovery ? { outcome: "no-oauth", detail: "the server does not describe how to sign in" } : { outcome: "not-usable", detail: "its sign-in server does not describe itself" };
    if (!offersPkce) return { outcome: "no-pkce" };
    const asked = challenge.scope?.split(/\s+/).filter(Boolean) ?? [];
    return { outcome: "oauth", resource, scopes: asked.length ? asked : listedScopes, authorizationServer, olderDiscovery };
  } catch (error) {
    if (error instanceof Refused) return { outcome: "not-usable", detail: error.message };
    return { outcome: "unreachable", detail: error instanceof Error ? error.name : "unknown" };
  }
}

export interface Client {
  clientId: string;
  clientSecret?: string;
  /** How this client proves itself at the token endpoint, when registration said so. */
  authMethod?: string;
}

/** An app registered in advance belongs to one sign-in server; its secret is never sent to another. */
export interface PreRegisteredClient extends Client { issuer: string }

export type Registration =
  | { kind: "pre-registered"; client: Client }
  | { kind: "metadata-document"; client: Client }
  | { kind: "automatic" }
  /** None of the three is possible: the vendor needs an app registered with it first. */
  | { kind: "needs-app" };

/** The spec's order: an app registered in advance, then a client metadata document, then automatic registration. */
export function chooseRegistration(server: AuthorizationServer, { preRegistered, metadataDocumentUrl }: { preRegistered?: PreRegisteredClient; metadataDocumentUrl?: string } = {}): Registration {
  // An MCP server chooses which sign-in server it names, so a hostile one could name its own: an
  // app is used only with the exact sign-in server it was registered with.
  if (preRegistered && preRegistered.issuer === server.issuer) {
    const { issuer: _, ...client } = preRegistered;
    return { kind: "pre-registered", client };
  }
  if (server.metadataDocuments && metadataDocumentUrl && isHttps(metadataDocumentUrl)) return { kind: "metadata-document", client: { clientId: metadataDocumentUrl } };
  if (server.registrationEndpoint) return { kind: "automatic" };
  return { kind: "needs-app" };
}

export type Registered = { outcome: "registered"; client: Client } | { outcome: "refused"; status: number; error?: string } | { outcome: "unreachable"; detail: string };

/** An OAuth error code is a short fixed word; anything else in a reply is the server's text, and is not passed on. */
const errorCode = (value: unknown) => (typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : undefined);

/** Automatic registration (RFC 7591): asks for a client without a secret where the server allows it. */
export async function registerClient(server: AuthorizationServer, { clientName, redirectUri }: { clientName: string; redirectUri: string }, options: OAuthOptions = {}): Promise<Registered> {
  if (!server.registrationEndpoint) return { outcome: "refused", status: 0 };
  const method = server.authMethods.includes("none") ? "none" : server.authMethods.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
  try {
    const reply = await request(server.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: method }),
    }, options);
    let value: unknown = null;
    try { value = JSON.parse(reply.text); } catch { /* not JSON */ }
    if (reply.status !== 201 && reply.status !== 200) return { outcome: "refused", status: reply.status, ...(isRecord(value) && errorCode(value.error) ? { error: errorCode(value.error) as string } : {}) };
    if (!isRecord(value) || typeof value.client_id !== "string" || !value.client_id) return { outcome: "refused", status: reply.status };
    // The server may grant another method than the one asked for (RFC 7591, 3.2.1); its answer is the one used.
    const granted = typeof value.token_endpoint_auth_method === "string" && /^[a-z_]{1,40}$/.test(value.token_endpoint_auth_method) ? value.token_endpoint_auth_method : method;
    return { outcome: "registered", client: { clientId: value.client_id, authMethod: granted, ...(typeof value.client_secret === "string" && value.client_secret ? { clientSecret: value.client_secret } : {}) } };
  } catch (error) {
    if (error instanceof Refused) return { outcome: "refused", status: 0 };
    return { outcome: "unreachable", detail: error instanceof Error ? error.name : "unknown" };
  }
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** A fresh PKCE pair and state for one sign-in. The verifier and state stay with the client. */
export function startSignIn(): { verifier: string; challenge: string; state: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()), state: base64url(randomBytes(16)) };
}

/** The vendor's sign-in page, with everything the spec requires on it. */
export function authorizationUrl(server: AuthorizationServer, { client, redirectUri, challenge, state, scopes, resource }: { client: Client; redirectUri: string; challenge: string; state: string; scopes: string[]; resource: string }): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", resource);
  if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
  return url.href;
}

export type Callback = { outcome: "code"; code: string } | { outcome: "refused"; error?: string } | { outcome: "not-ours"; detail: string };

/**
 * Reads the address the vendor sent the person back to. Anything that is not the answer to this
 * sign-in is refused: another address, another state, or another issuer.
 */
export function readCallback(returned: string, { redirectUri, state, server }: { redirectUri: string; state: string; server: AuthorizationServer }): Callback {
  let url: URL;
  try { url = new URL(returned.trim()); } catch { return { outcome: "not-ours", detail: "that is not an address" }; }
  const expected = new URL(redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) return { outcome: "not-ours", detail: "it is not the address this sign-in sends people back to" };
  if (url.searchParams.get("state") !== state) return { outcome: "not-ours", detail: "it belongs to another sign-in" };
  const issuer = url.searchParams.get("iss");
  if ((issuer !== null || server.sendsIssuer) && issuer !== server.issuer) return { outcome: "not-ours", detail: "it came from another sign-in server" };
  const error = url.searchParams.get("error");
  if (error !== null) return { outcome: "refused", ...(errorCode(error) ? { error: errorCode(error) as string } : {}) };
  const code = url.searchParams.get("code");
  return code ? { outcome: "code", code } : { outcome: "not-ours", detail: "it has no code in it" };
}

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** When the access token runs out, if the server said. */
  expiresAt?: string;
  scope?: string;
}

export type TokenResult = { outcome: "tokens"; tokens: Tokens } | { outcome: "refused"; status: number; error?: string } | { outcome: "unreachable"; detail: string };

async function tokenRequest(server: AuthorizationServer, client: Client, fields: Record<string, string>, options: OAuthOptions & { now?: () => Date }): Promise<TokenResult> {
  const form = new URLSearchParams(fields);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const method = client.clientSecret ? client.authMethod ?? (server.authMethods.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic") : "none";
  if (method === "client_secret_basic" && client.clientSecret) {
    // RFC 6749, 2.3.1: each part form-encoded, then joined with a colon.
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    headers.Authorization = `Basic ${Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret)}`).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    if (client.clientSecret) form.set("client_secret", client.clientSecret);
  }
  try {
    const reply = await request(server.tokenEndpoint, { method: "POST", headers, body: form.toString() }, options);
    let value: unknown = null;
    try { value = JSON.parse(reply.text); } catch { /* not JSON */ }
    // Some servers (GitHub) answer a refusal with 200 and an error field.
    if (reply.status !== 200 || (isRecord(value) && value.error !== undefined)) return { outcome: "refused", status: reply.status, ...(isRecord(value) && errorCode(value.error) ? { error: errorCode(value.error) as string } : {}) };
    if (!isRecord(value) || typeof value.access_token !== "string" || !value.access_token || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") return { outcome: "refused", status: reply.status };
    const now = (options.now ?? (() => new Date()))();
    // Capped at a year: a larger number would not make a date, and the tokens would be lost with it.
    const lifetime = typeof value.expires_in === "number" && Number.isFinite(value.expires_in) && value.expires_in > 0 ? Math.min(value.expires_in, 31_536_000) : undefined;
    return {
      outcome: "tokens",
      tokens: {
        accessToken: value.access_token,
        ...(typeof value.refresh_token === "string" && value.refresh_token ? { refreshToken: value.refresh_token } : {}),
        ...(lifetime ? { expiresAt: new Date(now.getTime() + lifetime * 1000).toISOString() } : {}),
        ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
      },
    };
  } catch (error) {
    if (error instanceof Refused) return { outcome: "refused", status: 0 };
    return { outcome: "unreachable", detail: error instanceof Error ? error.name : "unknown" };
  }
}

/** Swaps the code from the sign-in page for tokens, proving with the verifier that this client started it. */
export function exchangeCode(server: AuthorizationServer, client: Client, { code, verifier, redirectUri, resource }: { code: string; verifier: string; redirectUri: string; resource: string }, options: OAuthOptions & { now?: () => Date } = {}): Promise<TokenResult> {
  return tokenRequest(server, client, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, resource }, options);
}

/**
 * Renews the tokens. Most servers send a new refresh token and stop taking the old one, so the
 * result must be saved before anything else uses the connection; when a server sends none, the old
 * one is still the one to keep.
 */
export async function refreshTokens(server: AuthorizationServer, client: Client, { refreshToken, resource }: { refreshToken: string; resource: string }, options: OAuthOptions & { now?: () => Date } = {}): Promise<TokenResult> {
  const result = await tokenRequest(server, client, { grant_type: "refresh_token", refresh_token: refreshToken, resource }, options);
  if (result.outcome !== "tokens" || result.tokens.refreshToken) return result;
  return { outcome: "tokens", tokens: { ...result.tokens, refreshToken } };
}

/** Whether to renew before use: within `marginSeconds` of running out. Without an expiry, only a refusal says so. */
export function needsRefresh(tokens: Tokens, now: Date, marginSeconds = 120): boolean {
  return tokens.expiresAt !== undefined && Date.parse(tokens.expiresAt) - now.getTime() <= marginSeconds * 1000;
}
