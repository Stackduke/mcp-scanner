import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ghSecretSet } from "./connect.ts";
import type { IssueDeps } from "./renew.ts";
import type { OAuthServer } from "./signed-in.ts";

/**
 * What the daily run's sign-in steps leave for the steps after them, in one folder outside the
 * checkout that the run deletes at the end:
 *
 *   access.json    the access token of each server, for the check and the scan steps. Readable by this user only.
 *   renewed.json   what the renew step did for each server. No token is in it.
 *   checked.json   whether each server answered. No token, and nothing a server listed.
 */
export const files = { access: "access.json", renewed: "renewed.json", checked: "checked.json" } as const;

/** Writes a file only this user can read, whole or not at all. */
export async function writePrivate(dir: string, name: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = path.join(dir, name), partial = `${file}.partial`;
  await writeFile(partial, text, { mode: 0o600 });
  await rename(partial, file);
}

/** A file one of the steps wrote, or null when it is not there or cannot be read: that step did not finish. */
export async function readStep<T>(dir: string, name: string, isShape: (value: unknown) => value is T): Promise<T | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    return isShape(value) ? value : null;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isAccess = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every((token) => typeof token === "string");
export const isReports = <T extends { vendor: string; status: string }>(value: unknown): value is T[] => Array.isArray(value) && value.every((report) => isRecord(report) && typeof report.vendor === "string" && typeof report.status === "string");

/**
 * The environment for the scan: each renewed access token under its server's token variable, for
 * servers the tracker scans, published or privately. A server kept signed in only is not scanned,
 * and the scan keeps what a privately tracked server lists out of the public data.
 */
export function handOver(access: Record<string, string>, servers: readonly OAuthServer[], environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const handed = { ...environment };
  for (const server of servers) if (server.tracked && Object.hasOwn(access, server.id)) handed[server.tokenVariable] = access[server.id];
  return handed;
}

/**
 * The workflow command that hides a value from the rest of the job's log. The runner reads `%25`,
 * `%0D` and `%0A` in it as characters, so those are escaped, or a value holding `%25` would be
 * hidden as another, shorter one.
 */
export const maskCommand = (value: string) => `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`;

/** A secret saved with `gh`, tried three times: a renewal that is not saved may be a sign-in lost. */
export async function saveSecret(name: string, value: string, repository: string, { set = ghSecretSet, wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }) } = {}): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await set(name, value, repository)) return true;
    if (attempt < 3) await wait(attempt * 5_000);
  }
  return false;
}

/** Runs `gh` with what it should read on its input, and resolves its output, or null when it failed. */
function gh(args: string[], input = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? output : null));
    child.stdin.end(input);
  });
}

/** The repository's issues, through `gh`, signed in with the run's own token. */
export function ghIssues(repository: string, print: (line: string) => void): IssueDeps {
  return {
    print,
    listOpen: async () => {
      const output = await gh(["issue", "list", "--repo", repository, "--state", "open", "--limit", "1000", "--json", "number,title"]);
      if (output === null) return null;
      try {
        const value: unknown = JSON.parse(output);
        return Array.isArray(value) ? value.filter((issue): issue is { number: number; title: string } => isRecord(issue) && typeof issue.number === "number" && typeof issue.title === "string") : null;
      } catch {
        return null;
      }
    },
    open: async (title, body) => (await gh(["issue", "create", "--repo", repository, "--title", title, "--body-file", "-"], body)) !== null,
    close: async (issue, comment) => (await gh(["issue", "close", String(issue), "--repo", repository, "--comment", comment])) !== null,
  };
}
