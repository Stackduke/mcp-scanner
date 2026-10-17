import { listTools } from "./client.ts";
import { authorizationUrl, chooseRegistration, discover, exchangeCode, readCallback, registerClient, startSignIn } from "./oauth.ts";
import type { Client, OAuthOptions, PreRegisteredClient } from "./oauth.ts";
import { printable } from "./text.ts";

/**
 * One sign-in to a server, from start to a listed set of tools, to prove the sign-in works before
 * anything is built to keep its tokens. A person does the browser part: they open the address
 * printed, approve, and paste back the address the browser lands on. That page fails to load,
 * which is expected: what matters is the code in its address. This works from any machine, since
 * nothing has to listen for the browser.
 *
 * The tokens live only in this process. They are never printed, written or passed on, and they
 * are gone when it ends; the vendor's own settings list the sign-in, where it can be removed.
 */
export const redirectUri = "http://localhost:8976/callback";

export interface TryDeps extends OAuthOptions {
  ask: (prompt: string) => Promise<string>;
  print: (...lines: string[]) => void;
  /** Scopes to ask for in place of the server's own suggestion, such as read-only ones. */
  scopes?: string[];
  preRegistered?: PreRegisteredClient;
}

export type TryResult =
  | { outcome: "listed"; tools: number; scope?: string }
  | { outcome: "stopped"; at: "discover" | "register" | "callback" | "tokens" | "tools"; detail: string };

export async function trySignIn(serverUrl: string, deps: TryDeps): Promise<TryResult> {
  const { ask, print, fetchImpl } = deps;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return { outcome: "stopped", at: "discover", detail: "certificate checking is switched off here, so nothing was sent" };
  const options: OAuthOptions = { ...(fetchImpl ? { fetchImpl } : {}), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) };
  const found = await discover(serverUrl, options);
  if (found.outcome !== "oauth") return { outcome: "stopped", at: "discover", detail: "detail" in found ? `${found.outcome}: ${found.detail}` : found.outcome };
  const server = found.authorizationServer;
  print(`${printable(serverUrl)} signs in at ${printable(server.issuer)}${found.olderDiscovery ? " (found the older way: the server does not describe itself)" : ""}.`);

  const choice = chooseRegistration(server, deps.preRegistered ? { preRegistered: deps.preRegistered } : {});
  let client: Client;
  if (choice.kind === "needs-app") return { outcome: "stopped", at: "register", detail: "this vendor needs an app registered with it first" };
  if (choice.kind === "automatic") {
    const registered = await registerClient(server, { clientName: "Stackduke tracker (test sign-in)", redirectUri }, options);
    if (registered.outcome !== "registered") return { outcome: "stopped", at: "register", detail: registered.outcome === "refused" ? `refused (HTTP ${registered.status}${registered.error ? `, ${registered.error}` : ""})` : `unreachable: ${registered.detail}` };
    client = registered.client;
    print("Registered a client automatically.");
  } else {
    client = choice.client;
  }

  const { verifier, challenge, state } = startSignIn();
  const scopes = deps.scopes ?? found.scopes;
  print(
    "",
    "Open this address in a browser, sign in with the tracker's account and approve:",
    "",
    printable(authorizationUrl(server, { client, redirectUri, challenge, state, scopes, resource: found.resource }), 8_000),
    "",
    `Scopes asked for: ${printable(scopes.join(" ")) || "none named; the server decides"}.`,
    "The browser then lands on a localhost page that fails to load. That is expected.",
  );
  const callback = readCallback(await ask("Paste the address that page shows: "), { redirectUri, state, server });
  if (callback.outcome !== "code") return { outcome: "stopped", at: "callback", detail: callback.outcome === "refused" ? `the sign-in was refused${callback.error ? ` (${callback.error})` : ""}` : callback.detail };

  const exchanged = await exchangeCode(server, client, { code: callback.code, verifier, redirectUri, resource: found.resource }, options);
  if (exchanged.outcome !== "tokens") return { outcome: "stopped", at: "tokens", detail: exchanged.outcome === "refused" ? `refused (HTTP ${exchanged.status}${exchanged.error ? `, ${exchanged.error}` : ""})` : `unreachable: ${exchanged.detail}` };
  const { tokens } = exchanged;
  print(`Signed in. ${tokens.refreshToken ? "A refresh token came with it" : "No refresh token came with it, so this sign-in cannot renew itself"}${tokens.expiresAt ? `; the access token runs out at ${tokens.expiresAt}` : ""}.`);

  const listed = await listTools(serverUrl, { bearerToken: tokens.accessToken, ...(fetchImpl ? { fetchImpl } : {}), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) });
  // Everything in the result is the server's text; if it carries a token back, none of it is used.
  const text = JSON.stringify(listed);
  if ([tokens.accessToken, tokens.refreshToken].some((token) => token && text.includes(JSON.stringify(token).slice(1, -1)))) return { outcome: "stopped", at: "tools", detail: "the server sent a token back" };
  if (listed.outcome !== "listed") return { outcome: "stopped", at: "tools", detail: listed.outcome === "sign-in-required" ? `the server refused the new token (HTTP ${listed.status})` : `${listed.outcome}: ${listed.detail}` };
  return { outcome: "listed", tools: listed.tools.length, ...(tokens.scope ? { scope: printable(tokens.scope) } : {}) };
}
