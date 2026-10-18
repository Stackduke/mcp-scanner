import { plural } from "./authority.ts";
import type { OAuthOptions } from "./oauth.ts";
import type { StoredSignIn } from "./sign-in-store.ts";
import { storedSignInText } from "./sign-in-store.ts";
import { oauthServers } from "./signed-in.ts";
import type { OAuthServer } from "./signed-in.ts";
import { readToken } from "./signed-in.ts";
import { signIn } from "./try-sign-in.ts";
import type { SignInResult } from "./try-sign-in.ts";

/**
 * Adds a vendor's browser sign-in to the tracker, once per vendor. A person signs in with the
 * tracker's account for that vendor, the tokens are tested by listing the server's tools, and the
 * client and tokens are stored as one secret of the tracker's repository with `gh secret set`.
 * From then on the daily run renews it.
 *
 * As with `connect`, no token or client secret is printed, written to a file or passed as an
 * argument: they reach `gh` on its standard input and are gone when this process ends.
 */
export interface ConnectOAuthDeps extends OAuthOptions {
  ask: (prompt: string) => Promise<string>;
  print: (...lines: string[]) => void;
  /** Stores a secret in the repository; resolves true when `gh` succeeded. */
  storeSecret: (name: string, value: string, repository: string) => Promise<boolean>;
  now?: () => Date;
  servers?: readonly OAuthServer[];
  /** The sign-in itself, replaceable in tests. */
  signIn?: typeof signIn;
}

export async function connectOAuth(vendors: string[], repository: string, deps: ConnectOAuthDeps): Promise<{ stored: string[]; skipped: string[] }> {
  const { print, storeSecret, servers = oauthServers, now = () => new Date() } = deps;
  const stored: string[] = [], skipped: string[] = [];
  for (const vendor of vendors) {
    const server = servers.find((candidate) => candidate.id === vendor);
    if (!server) { print(`${vendor}: not a vendor this tracker signs in to in a browser. Known: ${servers.map((known) => known.id).join(", ") || "none"}.`); skipped.push(vendor); continue; }
    print("", `${server.name}${server.publish ? "" : " (signed in and renewed, not published until its terms are read)"}`, `  ${server.scopeAdvice}`);
    const result: SignInResult = await (deps.signIn ?? signIn)(server.url, {
      ask: deps.ask, print: (...lines) => print(...lines.map((line) => (line ? `  ${line}` : line))),
      scopes: [...server.scopes], clientName: "Stackduke tracker", expectedIssuer: server.issuer,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    });
    if (result.outcome !== "signed-in") { print(`  Stopped at ${result.at}: ${result.detail}. Not stored.`); skipped.push(vendor); continue; }
    const { tokens, client, authorizationServer, resource } = result;
    // The daily run reads only what can go in a header or a form as it is; anything else would fail there, so it fails here.
    if (![tokens.accessToken, tokens.refreshToken, client.clientId, client.clientSecret].every((value) => value === undefined || readToken(value).ok)) { print("  The vendor gave a token or client that cannot be kept as it is. Not stored."); skipped.push(vendor); continue; }
    const kept: StoredSignIn = {
      version: 1, vendor: server.id, server: server.url, resource, issuer: authorizationServer.issuer, tokenEndpoint: authorizationServer.tokenEndpoint,
      authMethods: [...authorizationServer.authMethods], client, tokens, signedInAt: now().toISOString(),
    };
    print(`  It works: the server listed ${plural(result.tools, "tool")}.`);
    if (!tokens.refreshToken) print(`  No refresh token came with it, so the daily run cannot renew it${tokens.expiresAt ? `: it stops working at ${tokens.expiresAt}, and the run will then open an issue` : ""}.`);
    if (await storeSecret(server.signInSecret, storedSignInText(kept), repository)) { print(`  Stored as ${server.signInSecret} in ${repository}.`); stored.push(vendor); }
    else { print("  gh could not store it. Is gh signed in, with admin rights on that repository? Remove the sign-in in the vendor's settings and try again."); skipped.push(vendor); }
  }
  return { stored, skipped };
}
