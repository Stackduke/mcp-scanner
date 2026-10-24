import assert from "node:assert/strict";
import { test } from "node:test";
import { connectOAuth } from "../src/connect-oauth.ts";
import { readStoredSignIn } from "../src/sign-in-store.ts";
import type { OAuthServer } from "../src/signed-in.ts";
import { redirectUri } from "../src/try-sign-in.ts";

const url = "https://mcp.demo.example/mcp";
const describedAt = "https://mcp.demo.example/.well-known/oauth-protected-resource/mcp";
const issuer = "https://auth.demo.example";
const access = "made-up-access-token";
const refresh = "made-up-refresh-token";
const clientSecret = "made-up-client-secret";

const demo: OAuthServer = Object.freeze({ id: "demo", name: "Demo", url, publish: false, tracked: false, tokenVariable: "STACKDUKE_SCAN_DEMO_TOKEN", signInSecret: "STACKDUKE_OAUTH_DEMO", issuer, scopes: ["things:read"], scopeAdvice: "Use the tracker's own account." });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function vendor({ namesIssuer = issuer, refreshToken = true } = {}) {
  const seen: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = String(init?.body ?? "");
    seen.push({ url: address, body });
    if (address === url) {
      if (headers.Authorization !== `Bearer ${access}`) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${describedAt}"` } });
      const message = JSON.parse(body) as { method: string; id?: number };
      if (message.method === "initialize") return json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "Demo" } } });
      if (message.method === "tools/list") return json({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "list_things" }, { name: "read_thing" }, { name: "delete_thing" }] } });
      return new Response(null, { status: 202 });
    }
    if (address === describedAt) return json({ resource: url, authorization_servers: [namesIssuer] });
    if (address === `${namesIssuer}/.well-known/oauth-authorization-server`) return json({
      issuer: namesIssuer, authorization_endpoint: `${namesIssuer}/authorize`, token_endpoint: `${namesIssuer}/token`, registration_endpoint: `${namesIssuer}/register`,
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
    if (address === `${namesIssuer}/register`) return json({ client_id: "registered-client", client_secret: clientSecret, token_endpoint_auth_method: "client_secret_post" }, 201);
    if (address === `${namesIssuer}/token`) return json({ access_token: access, token_type: "Bearer", ...(refreshToken ? { refresh_token: refresh } : {}), expires_in: 3600, scope: "things:read" });
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function person() {
  const printed: string[] = [];
  return {
    printed,
    print: (...lines: string[]) => { printed.push(...lines); },
    ask: async () => {
      const address = printed.map((line) => line.trim()).find((line) => line.includes("/authorize?"));
      const state = address ? new URL(address).searchParams.get("state") : null;
      return `${redirectUri}?code=made-up-code&state=${state}`;
    },
  };
}

function store() {
  const secrets = new Map<string, string>();
  return { secrets, storeSecret: async (name: string, value: string) => { secrets.set(name, value); return true; } };
}

test("a browser sign-in is tested, then stored whole as the server's own secret, and no token is ever printed", async () => {
  const { fetchImpl, seen } = vendor();
  const someone = person(), kept = store();
  const result = await connectOAuth(["demo"], "Stackduke/mcp-scanner", { ...someone, ...kept, fetchImpl, servers: [demo], now: () => new Date("2026-10-18T10:00:00Z") });
  assert.deepEqual(result, { stored: ["demo"], skipped: [] });
  assert.deepEqual([...kept.secrets.keys()], ["STACKDUKE_OAUTH_DEMO"]);
  const read = readStoredSignIn(kept.secrets.get("STACKDUKE_OAUTH_DEMO"), demo);
  assert.ok(read.ok);
  assert.equal(read.signIn.tokenEndpoint, `${issuer}/token`);
  assert.deepEqual(read.signIn.client, { clientId: "registered-client", clientSecret, authMethod: "client_secret_post" });
  assert.equal(read.signIn.tokens.refreshToken, refresh);
  const printed = someone.printed.join("\n");
  for (const secret of [access, refresh, clientSecret]) assert.ok(!printed.includes(secret), secret);
  assert.match(printed, /It works: the server listed 3 tools\./);
  // The catalog's read-only scopes are what is asked for, and the client is the tracker's own.
  const authorize = new URL(someone.printed.map((line) => line.trim()).find((line) => line.includes("/authorize?")) as string);
  assert.equal(authorize.searchParams.get("scope"), "things:read");
  assert.ok(seen.some((request) => request.url === `${issuer}/register` && JSON.parse(request.body).client_name === "Stackduke tracker"));
});

test("a server that now names another sign-in server is refused before anything is sent to that server", async () => {
  const { fetchImpl, seen } = vendor({ namesIssuer: "https://auth.elsewhere.example" });
  const someone = person(), kept = store();
  assert.deepEqual(await connectOAuth(["demo"], "Stackduke/mcp-scanner", { ...someone, ...kept, fetchImpl, servers: [demo] }), { stored: [], skipped: ["demo"] });
  assert.equal(kept.secrets.size, 0);
  assert.ok(!seen.some((request) => request.url.startsWith("https://auth.elsewhere.example/register")));
  assert.match(someone.printed.join("\n"), /names another sign-in server/);
});

test("a sign-in without a refresh token is stored, with a warning that the run cannot renew it", async () => {
  const someone = person(), kept = store();
  await connectOAuth(["demo"], "Stackduke/mcp-scanner", { ...someone, ...kept, ...vendor({ refreshToken: false }), servers: [demo] });
  assert.equal(kept.secrets.size, 1);
  assert.match(someone.printed.join("\n"), /No refresh token came with it, so the daily run cannot renew it/);
});

test("a vendor the catalog does not keep a browser sign-in for is not signed in to", async () => {
  const someone = person(), kept = store();
  assert.deepEqual(await connectOAuth(["github"], "Stackduke/mcp-scanner", { ...someone, ...kept, ...vendor(), servers: [demo] }), { stored: [], skipped: ["github"] });
  assert.match(someone.printed.join("\n"), /not a vendor this tracker signs in to in a browser/);
});

test("a stored sign-in is read only for the server it was made for", () => {
  const stored = JSON.stringify({ version: 1, vendor: "demo", server: url, resource: url, issuer, tokenEndpoint: `${issuer}/token`, authMethods: ["none"], client: { clientId: "c" }, tokens: { accessToken: access }, signedInAt: "2026-10-18T10:00:00.000Z" });
  assert.ok(readStoredSignIn(stored, demo).ok);
  assert.deepEqual(readStoredSignIn(stored, { ...demo, issuer: "https://auth.elsewhere.example" }), { ok: false, reason: "another-server" });
  assert.deepEqual(readStoredSignIn(stored, { ...demo, id: "other" }), { ok: false, reason: "another-server" });
  assert.deepEqual(readStoredSignIn("", demo), { ok: false, reason: "missing" });
  assert.deepEqual(readStoredSignIn("{not json", demo), { ok: false, reason: "unreadable" });
  assert.deepEqual(readStoredSignIn(stored.replace(`${issuer}/token`, "http://auth.demo.example/token"), demo), { ok: false, reason: "unreadable" });
  assert.deepEqual(readStoredSignIn(stored.replace(access, "with a space"), demo), { ok: false, reason: "unreadable" });
  // A refusal never carries what was stored.
  assert.ok(!JSON.stringify(readStoredSignIn(stored, { ...demo, id: "other" })).includes(access));
});
