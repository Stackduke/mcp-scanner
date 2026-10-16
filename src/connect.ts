import { spawn } from "node:child_process";
import { plural } from "./authority.ts";
import { scanSignedIn, signedInServers } from "./signed-in.ts";
import type { SignedInScan } from "./signed-in.ts";

/**
 * Adds vendor tokens to the tracker in one sitting. For each vendor: where to make the token and
 * what to make, a hidden prompt to paste it, a test that the vendor's server lists its tools with
 * it, and then `gh secret set`, which stores it as a secret of the tracker's repository.
 *
 * The token is never printed, never written to a file and never passed as an argument: it goes
 * to the vendor's fixed address for the test, and to `gh` on its standard input.
 */
export interface ConnectDeps {
  /** Asks for a token without showing what is typed. An empty answer skips the vendor. */
  readSecret: (prompt: string) => Promise<string>;
  /** Stores a secret in the repository; resolves true when `gh` succeeded. */
  storeSecret: (name: string, value: string, repository: string) => Promise<boolean>;
  scan?: (vendor: string, environment: Record<string, string>) => Promise<SignedInScan>;
  print: (...lines: string[]) => void;
}

/** Why a token cannot be stored, or null when the server listed its tools with it. */
function refusal(result: SignedInScan): string | null {
  if (result.outcome === "no-token") return "That does not look like a token. Nothing was sent.";
  if (result.outcome === "token-echoed") return "The server sent the token back. Treat it as exposed and replace it.";
  if (result.outcome !== "answered") return "It was not sent: certificate checking is switched off here.";
  if (result.result.outcome === "sign-in-required") return `The server refused it (HTTP ${result.result.status}).`;
  if (result.result.outcome !== "listed") return `The server could not be read with it (${result.result.outcome}).`;
  return null;
}

export async function connect(vendors: string[], repository: string, deps: ConnectDeps): Promise<{ stored: string[]; skipped: string[] }> {
  // The check that certificate checking is on reads this process's setting too, since Node obeys it whatever is passed.
  const { readSecret, storeSecret, print, scan = (vendor, environment) => scanSignedIn(vendor, { NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED, ...environment }) } = deps;
  const stored: string[] = [], skipped: string[] = [];
  for (const vendor of vendors) {
    const server = Object.hasOwn(signedInServers, vendor) ? signedInServers[vendor] : undefined;
    if (!server) { print(`${vendor}: not a vendor this tracker knows. Known: ${Object.keys(signedInServers).join(", ")}.`); skipped.push(vendor); continue; }
    print("", `${vendor}`, `  Make it at ${server.keyPage}`, `  ${server.keyAdvice}`);
    const token = (await readSecret(`  Paste it here (hidden; press Enter alone to skip): `)).trim();
    if (!token) { print("  Skipped."); skipped.push(vendor); continue; }
    const result = await scan(vendor, { [server.tokenVariable]: token });
    const verdict = refusal(result);
    if (verdict) { print(`  ${verdict} Not stored.`); skipped.push(vendor); continue; }
    const count = result.outcome === "answered" && result.result.outcome === "listed" ? result.result.tools.length : 0;
    print(`  It works: the server listed ${plural(count, "tool")}.`);
    if (await storeSecret(server.tokenVariable, token, repository)) { print(`  Stored as ${server.tokenVariable} in ${repository}.`); stored.push(vendor); }
    else { print("  gh could not store it. Is gh signed in, with admin rights on that repository?"); skipped.push(vendor); }
  }
  return { stored, skipped };
}

/** Reads a line from the terminal without echoing it. */
export function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return Promise.reject(new Error("connect asks for tokens at a terminal, so they are not echoed. Run it in one."));
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (error?: Error) => { input.setRawMode(false); input.pause(); input.off("data", onData); process.stdout.write("\n"); if (error) reject(error); else resolve(value); };
    function onData(chunk: string) {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return done();
        if (character === "\u0003") return done(new Error("Stopped."));
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    }
    input.on("data", onData);
  });
}

/** `gh secret set`, with the value on standard input so it never appears in a process list. */
export function ghSecretSet(name: string, value: string, repository: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["secret", "set", name, "--repo", repository], { stdio: ["pipe", "ignore", "inherit"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(value);
  });
}
