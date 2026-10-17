import assert from "node:assert/strict";
import { test } from "node:test";
import { signInFrom } from "../src/catalog.ts";
import type { Discovery } from "../src/oauth.ts";
import { redirectUri, trySignIn } from "../src/try-sign-in.ts";

const server = "https://mcp.demo.example/mcp";
const describedAt = "https://mcp.demo.example/.well-known/oauth-protected-resource/mcp";
const issuer = "https://auth.demo.example";
const access = "made-up-access-token";
const refresh = "made-up-refresh-token";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** A whole vendor: an MCP server that wants a login, its description, and a sign-in server with automatic registration. */
function vendor({ registration = true, echo = false } = {}) {
  const seen: Array<{ url: string; authorization?: string; body: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = String(init?.body ?? "");
    seen.push({ url, ...(headers.Authorization ? { authorization: headers.Authorization } : {}), body });
    if (url === server) {
      if (headers.Authorization !== `Bearer ${access}`) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${describedAt}", scope="read"` } });
      const message = JSON.parse(body) as { method: string; id?: number };
      if (message.method === "initialize") return json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "Demo" } } });
      if (message.method === "tools/list") return json({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "list_things", description: echo ? `token ${access}` : "Lists things." }, { name: "delete_thing" }] } });
      return new Response(null, { status: 202 });
    }
    if (url === describedAt) return json({ resource: server, authorization_servers: [issuer] });
    if (url === `${issuer}/.well-known/oauth-authorization-server`) return json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], ...(registration ? { registration_endpoint: `${issuer}/register` } : {}),
    });
    if (url === `${issuer}/register`) return json({ client_id: "registered-client" }, 201);
    if (url === `${issuer}/token`) return json({ access_token: access, token_type: "Bearer", refresh_token: refresh, expires_in: 3600, scope: "read" });
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  return { fetchImpl, seen };
}

/** Plays the person: opens the printed address, and pastes back where the vendor sends the browser. */
function person() {
  const printed: string[] = [];
  return {
    printed,
    print: (...lines: string[]) => { printed.push(...lines); },
    ask: async () => {
      const address = printed.find((line) => line.startsWith(`${issuer}/authorize?`));
      const state = address ? new URL(address).searchParams.get("state") : null;
      return `${redirectUri}?code=made-up-code&state=${state}`;
    },
  };
}

test("a whole test sign-in ends with the server's tools listed, and no token is ever printed", async () => {
  const { fetchImpl, seen } = vendor();
  const someone = person();
  const result = await trySignIn(server, { fetchImpl, ...someone });
  assert.deepEqual(result, { outcome: "listed", tools: 2, scope: "read" });
  const printed = someone.printed.join("\n");
  for (const secret of [access, refresh]) assert.ok(!printed.includes(secret) && !JSON.stringify(result).includes(secret));
  const authorize = new URL(someone.printed.find((line) => line.startsWith(`${issuer}/authorize?`)) as string);
  assert.equal(authorize.searchParams.get("client_id"), "registered-client");
  assert.equal(authorize.searchParams.get("scope"), "read");
  assert.equal(authorize.searchParams.get("resource"), server);
  // The access token goes to the MCP server and nowhere else.
  assert.ok(seen.filter((request) => request.authorization).every((request) => request.url === server));
});

test("scopes given by the person replace the server's suggestion", async () => {
  const someone = person();
  await trySignIn(server, { ...vendor(), ...someone, scopes: ["read:only"] });
  assert.equal(new URL(someone.printed.find((line) => line.startsWith(`${issuer}/authorize?`)) as string).searchParams.get("scope"), "read:only");
});

test("a vendor that needs an app registered first stops before the browser", async () => {
  const someone = person();
  assert.deepEqual(await trySignIn(server, { ...vendor({ registration: false }), ...someone }), { outcome: "stopped", at: "register", detail: "this vendor needs an app registered with it first" });
  assert.ok(!someone.printed.some((line) => line.includes("/authorize?")));
});

test("a pasted address from another sign-in is refused", async () => {
  const result = await trySignIn(server, { ...vendor(), print: () => undefined, ask: async () => `${redirectUri}?code=x&state=someone-else` });
  assert.deepEqual(result, { outcome: "stopped", at: "callback", detail: "it belongs to another sign-in" });
});

test("a server that sends the token back has nothing it returned used", async () => {
  assert.deepEqual(await trySignIn(server, { ...vendor({ echo: true }), ...person() }), { outcome: "stopped", at: "tools", detail: "the server sent a token back" });
});

test("a test sign-in sends nothing when certificate checking is switched off", async () => {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const { fetchImpl, seen } = vendor();
    const result = await trySignIn(server, { fetchImpl, ...person() });
    assert.deepEqual(result, { outcome: "stopped", at: "discover", detail: "certificate checking is switched off here, so nothing was sent" });
    assert.equal(seen.length, 0);
  } finally {
    if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
  }
});

test("what a server says about itself becomes a catalog sign-in method", () => {
  const signInServer = { issuer, authorizationEndpoint: `${issuer}/a`, tokenEndpoint: `${issuer}/t`, metadataDocuments: false, authMethods: ["none"], sendsIssuer: false };
  const oauth = (changes: object): Discovery => ({ outcome: "oauth", resource: server, scopes: [], olderDiscovery: false, authorizationServer: { ...signInServer, ...changes } });
  assert.equal(signInFrom(oauth({ metadataDocuments: true, registrationEndpoint: `${issuer}/r` })), "oauth-metadata-doc");
  assert.equal(signInFrom(oauth({ registrationEndpoint: `${issuer}/r` })), "oauth-dcr");
  assert.equal(signInFrom(oauth({})), "oauth-app");
  assert.equal(signInFrom({ outcome: "no-oauth", detail: "x" }), "api-key");
  assert.equal(signInFrom({ outcome: "not-usable", detail: "the server answered 503" }), "not-usable", "an outage is not a key");
  assert.equal(signInFrom({ outcome: "open" }), "open");
  assert.equal(signInFrom({ outcome: "no-pkce" }), "unsafe");
});
