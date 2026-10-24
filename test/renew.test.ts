import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkSignIns, issueTitle, renewalOffTitle, renewSignIns, signInIssues, unfinishedTitle, verdictsOf } from "../src/renew.ts";
import type { CheckReport, IssueDeps, RenewReport } from "../src/renew.ts";
import { handOver, isAccess, maskCommand, readStep, saveSecret, writePrivate } from "../src/sign-in-io.ts";
import type { StoredSignIn } from "../src/sign-in-store.ts";
import { oauthServers, signedInServers } from "../src/signed-in.ts";
import type { OAuthServer } from "../src/signed-in.ts";

const url = "https://mcp.demo.example/mcp";
const issuer = "https://auth.demo.example";
const tokenEndpoint = `${issuer}/token`;
const clientSecret = "made-up-client-secret";
const now = new Date("2026-10-18T04:20:00Z");

const demo: OAuthServer = Object.freeze({ id: "demo", name: "Demo", url, publish: true, tracked: true, tokenVariable: "STACKDUKE_SCAN_DEMO_TOKEN", signInSecret: "STACKDUKE_OAUTH_DEMO", issuer, scopes: [], scopeAdvice: "The tracker's own account." });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** A vendor that hands out a new refresh token with each renewal and stops taking the old one, as most do. */
function vendor({ tokenStatus = 200, echo = false }: { tokenStatus?: number | "down"; echo?: boolean } = {}) {
  let generation = 1;
  const seen: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = String(init?.body ?? "");
    seen.push({ url: address, body });
    if (address === tokenEndpoint) {
      if (tokenStatus === "down") throw new TypeError("fetch failed");
      if (tokenStatus !== 200) return json({ error: "invalid_grant" }, tokenStatus);
      const form = new URLSearchParams(body);
      if (form.get("client_secret") !== clientSecret || form.get("refresh_token") !== `refresh-${generation}` || form.get("resource") !== url) return json({ error: "invalid_grant" }, 400);
      generation += 1;
      return json({ access_token: `access-${generation}`, refresh_token: `refresh-${generation}`, token_type: "Bearer", expires_in: 3600 });
    }
    if (address === url) {
      if (headers.Authorization !== `Bearer access-${generation}`) return new Response(null, { status: 401 });
      const message = JSON.parse(body) as { method: string; id?: number };
      if (message.method === "initialize") return json({ jsonrpc: "2.0", id: 1, result: {} });
      if (message.method === "tools/list") return json({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "list_things", description: echo ? `token access-${generation}` : "Lists things." }] } });
      return new Response(null, { status: 202 });
    }
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const stored = (changes: Partial<StoredSignIn["tokens"]> = {}): StoredSignIn => ({
  version: 1, vendor: "demo", server: url, resource: url, issuer, tokenEndpoint, authMethods: ["client_secret_post"],
  client: { clientId: "registered-client", clientSecret, authMethod: "client_secret_post" },
  tokens: { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: "2026-10-17T05:00:00.000Z", ...changes },
  signedInAt: "2026-10-17T04:00:00.000Z",
});
const environmentWith = (value: StoredSignIn | string) => ({ STACKDUKE_OAUTH_DEMO: typeof value === "string" ? value : JSON.stringify(value) });

function saver(works = true) {
  const saved: Array<{ name: string; value: string }> = [];
  return { saved, save: async (name: string, value: string) => { saved.push({ name, value }); return works; } };
}

test("a sign-in is renewed and saved back before anything uses it, and every token is hidden from the log", async () => {
  const { fetchImpl, seen } = vendor();
  const masked = new Set<string>(), kept = saver();
  const { reports, access } = await renewSignIns({ environment: environmentWith(stored()), save: kept.save, mask: (value) => masked.add(value), fetchImpl, now: () => now, servers: [demo] });
  assert.deepEqual(reports, [{ vendor: "demo", status: "renewed" }]);
  assert.deepEqual(access, { demo: "access-2" });
  assert.equal(kept.saved.length, 1);
  assert.equal(kept.saved[0]?.name, "STACKDUKE_OAUTH_DEMO");
  const renewed = JSON.parse(kept.saved[0]?.value as string) as StoredSignIn;
  assert.deepEqual(renewed.tokens, { accessToken: "access-2", refreshToken: "refresh-2", expiresAt: "2026-10-18T05:20:00.000Z" });
  assert.equal(renewed.renewedAt, now.toISOString());
  for (const secret of ["access-1", "refresh-1", clientSecret, "access-2", "refresh-2"]) assert.ok(masked.has(secret), secret);
  assert.ok(!JSON.stringify(reports).includes("refresh-"));
  // Renewing goes to the token address saved at sign-in, and asks nothing of the MCP server.
  assert.deepEqual(seen.map((request) => request.url), [tokenEndpoint]);

  // The next day's run reads the saved one, and the vendor takes it.
  const next = await renewSignIns({ environment: { STACKDUKE_OAUTH_DEMO: kept.saved[0]?.value }, save: kept.save, mask: () => undefined, fetchImpl, now: () => now, servers: [demo] });
  assert.deepEqual(next.reports, [{ vendor: "demo", status: "renewed" }]);
});

test("a renewal that cannot be saved is a sign-in lost, though today's token still reads the server", async () => {
  const { reports, access } = await renewSignIns({ environment: environmentWith(stored()), save: saver(false).save, mask: () => undefined, ...vendor(), now: () => now, servers: [demo] });
  assert.deepEqual(reports, [{ vendor: "demo", status: "lost", detail: "it was renewed, but the renewed sign-in could not be saved, so the stored one may no longer work" }]);
  assert.deepEqual(access, { demo: "access-2" });
});

test("without a key to save with, nothing is renewed: the stored token is used while it lasts", async () => {
  const { fetchImpl, seen } = vendor();
  const fresh = await renewSignIns({ environment: environmentWith(stored({ expiresAt: "2026-10-18T05:00:00.000Z" })), mask: () => undefined, fetchImpl, now: () => now, servers: [demo] });
  assert.deepEqual(fresh.reports, [{ vendor: "demo", status: "kept", detail: "renewing is off here: no key to save a renewed sign-in with", fix: "set-up-app" }]);
  assert.deepEqual(fresh.access, { demo: "access-1" });
  const old = await renewSignIns({ environment: environmentWith(stored()), mask: () => undefined, fetchImpl, now: () => now, servers: [demo] });
  assert.equal(old.reports[0]?.status, "lost");
  assert.deepEqual(old.access, {});
  assert.equal(seen.length, 0);
});

test("a vendor that will not renew is a sign-in lost; one that is down is a missed day", async () => {
  const refused = await renewSignIns({ environment: environmentWith(stored()), save: saver().save, mask: () => undefined, ...vendor({ tokenStatus: 400 }), now: () => now, servers: [demo] });
  assert.deepEqual(refused.reports, [{ vendor: "demo", status: "lost", detail: "the vendor would not renew it (HTTP 400, invalid_grant)" }]);
  const busy = await renewSignIns({ environment: environmentWith(stored({ expiresAt: "2026-10-18T05:00:00.000Z" })), save: saver().save, mask: () => undefined, ...vendor({ tokenStatus: 429 }), now: () => now, servers: [demo] });
  assert.equal(busy.reports[0]?.status, "unreachable");
  const down = await renewSignIns({ environment: environmentWith(stored({ expiresAt: "2026-10-18T05:00:00.000Z" })), save: saver().save, mask: () => undefined, ...vendor({ tokenStatus: "down" }), now: () => now, servers: [demo] });
  assert.deepEqual(down.reports, [{ vendor: "demo", status: "unreachable", detail: "its sign-in server could not be reached" }]);
  assert.deepEqual(down.access, { demo: "access-1" });
});

test("a sign-in that is missing, unreadable or for another server is said so, and sends nothing", async () => {
  const { fetchImpl, seen } = vendor();
  const run = (environment: Record<string, string | undefined>) => renewSignIns({ environment, save: saver().save, mask: () => undefined, fetchImpl, now: () => now, servers: [demo] });
  assert.deepEqual((await run({})).reports, [{ vendor: "demo", status: "not-connected" }]);
  assert.deepEqual((await run(environmentWith("{oops"))).reports, [{ vendor: "demo", status: "lost", detail: "the stored sign-in cannot be read" }]);
  assert.deepEqual((await run(environmentWith({ ...stored(), issuer: "https://auth.elsewhere.example" }))).reports, [{ vendor: "demo", status: "lost", detail: "the stored sign-in is for another server" }]);
  assert.equal(seen.length, 0);
});

test("checking keeps only whether each server answered", async () => {
  const { fetchImpl } = vendor();
  assert.deepEqual(await checkSignIns({ demo: "access-1" }, { fetchImpl, servers: [demo] }), [{ vendor: "demo", status: "answered" }]);
  assert.deepEqual(await checkSignIns({ demo: "access-9" }, { fetchImpl, servers: [demo] }), [{ vendor: "demo", status: "refused", detail: "HTTP 401" }]);
  assert.deepEqual(await checkSignIns({}, { fetchImpl, servers: [demo] }), [{ vendor: "demo", status: "no-token" }]);
  assert.deepEqual(await checkSignIns({ demo: "access-1" }, { ...vendor({ echo: true }), servers: [demo] }), [{ vendor: "demo", status: "token-echoed" }]);
});

test("a check that fails says why, in the scanner's own words", async () => {
  const failing = (answer: () => Response | Promise<Response>) => (async () => answer()) as unknown as typeof fetch;
  assert.deepEqual(await checkSignIns({ demo: "access-1" }, { fetchImpl: failing(() => new Response("busy", { status: 503 })), servers: [demo] }), [{ vendor: "demo", status: "unreachable", detail: "it answered, but initialize answered 503" }]);
  assert.deepEqual(await checkSignIns({ demo: "access-1" }, { fetchImpl: failing(() => { throw new TypeError("fetch failed"); }), servers: [demo] }), [{ vendor: "demo", status: "unreachable", detail: "no answer (TypeError)" }]);
});

function issues(start: Array<{ number: number; title: string }> = [], { works = true } = {}) {
  const open = [...start], opened: Array<{ title: string; body: string }> = [], closed: number[] = [], printed: string[] = [];
  const deps: IssueDeps = {
    print: (line) => printed.push(line),
    listOpen: async () => (works ? [...open] : null),
    open: async (title, body) => { opened.push({ title, body }); open.push({ number: 100 + opened.length, title }); return works; },
    close: async (number) => { closed.push(number); return works; },
    servers: [demo],
  };
  return { deps, opened, closed, printed };
}

const lost: RenewReport[] = [{ vendor: "demo", status: "lost", detail: "the vendor would not renew it (HTTP 400, invalid_grant)" }];
const answered: CheckReport[] = [{ vendor: "demo", status: "answered" }];

test("a lost sign-in opens one issue, with the command to sign in again, and a good read closes it", async () => {
  const first = issues();
  assert.equal(await signInIssues(lost, [{ vendor: "demo", status: "no-token" }], "2026-10-18", first.deps), true);
  assert.deepEqual(first.opened.map((issue) => issue.title), [issueTitle("Demo")]);
  assert.match(first.opened[0]?.body as string, /npm run scan -- connect-oauth demo/);
  assert.match(first.opened[0]?.body as string, /shows this server as not read/);

  const again = issues([{ number: 7, title: issueTitle("Demo") }]);
  await signInIssues(lost, [], "2026-10-19", again.deps);
  assert.deepEqual(again.opened, []);

  const healed = issues([{ number: 7, title: issueTitle("Demo") }]);
  await signInIssues([{ vendor: "demo", status: "renewed" }], answered, "2026-10-20", healed.deps);
  assert.deepEqual(healed.closed, [7]);
});

test("a refused or echoed sign-in needs a person; a missed day or no sign-in yet changes nothing", () => {
  assert.equal(verdictsOf([{ vendor: "demo", status: "renewed" }], [{ vendor: "demo", status: "refused", detail: "HTTP 401" }], [demo])[0]?.verdict, "needs-person");
  assert.equal(verdictsOf([{ vendor: "demo", status: "renewed" }], [{ vendor: "demo", status: "token-echoed" }], [demo])[0]?.verdict, "needs-person");
  assert.equal(verdictsOf([{ vendor: "demo", status: "unreachable" }], [{ vendor: "demo", status: "unreachable" }], [demo])[0]?.verdict, "unknown");
  assert.equal(verdictsOf([{ vendor: "demo", status: "not-connected" }], [{ vendor: "demo", status: "no-token" }], [demo])[0]?.verdict, "unknown");
  // A renewal that could not be saved needs a person even though today's read worked.
  assert.equal(verdictsOf([{ vendor: "demo", status: "lost" }], answered, [demo])[0]?.verdict, "needs-person");
});

test("sign-in steps that did not finish open an issue of their own, closed once they finish", async () => {
  const stopped = issues();
  await signInIssues(null, null, "2026-10-18", stopped.deps);
  assert.deepEqual(stopped.opened.map((issue) => issue.title), [unfinishedTitle]);
  const finished = issues([{ number: 3, title: unfinishedTitle }]);
  await signInIssues([{ vendor: "demo", status: "renewed" }], answered, "2026-10-19", finished.deps);
  assert.deepEqual(finished.closed, [3]);
});

test("when an issue cannot be opened, the step fails, so the run shows that nobody was told", async () => {
  assert.equal(await signInIssues(lost, [], "2026-10-18", issues([], { works: false }).deps), false);
});

/** The run's steps, by name, with the text of each. */
function steps(): Map<string, string> {
  const text = readFileSync(new URL("../.github/workflows/track.yml", import.meta.url), "utf8");
  return new Map(text.split(/\n(?=      - name: )/).slice(1).map((block) => [/- name: (.+)/.exec(block)?.[1] as string, block]));
}

test("each browser sign-in reaches the renew step only, and the scan step gets only the keys", () => {
  const all = steps();
  const renew = all.get("Renew sign-ins") as string;
  const secretsIn = (block: string, prefix: string) => [...block.matchAll(new RegExp(`secrets\\.(${prefix}[A-Z0-9_]+)`, "g"))].map((match) => match[1]).sort();
  assert.deepEqual(secretsIn(renew, "STACKDUKE_OAUTH_"), oauthServers.map((server) => server.signInSecret).sort());
  for (const [name, block] of all) if (name !== "Renew sign-ins") assert.deepEqual(secretsIn(block, "STACKDUKE_OAUTH_"), [], name);
  const keyed = Object.values(signedInServers).filter((server) => server.kind === "api-key").map((server) => server.tokenVariable).sort();
  assert.deepEqual(secretsIn(all.get("Scan") as string, "STACKDUKE_SCAN_"), keyed);
  // The key that may write secrets goes to the renew step alone; the step that reads servers holds no GitHub key at all.
  for (const [name, block] of all) if (name !== "Renew sign-ins") assert.ok(!block.includes("steps.sign-in-key.outputs.token"), name);
  for (const name of ["Check sign-ins", "Scan"]) assert.ok(!/(?<![A-Z_])(GH_TOKEN|GITHUB_TOKEN)|github\.token/.test(all.get(name) as string), name);
  assert.match(all.get("Key for saving renewed sign-ins") as string, /permission-secrets: write/);
  assert.match(all.get("Forget the sign-ins") as string, /if: always\(\)/);
});

test("the scan is handed the access tokens of servers it tracks, published or privately, and of no other", () => {
  const quiet: OAuthServer = { ...demo, id: "quiet", publish: false, tracked: false, tokenVariable: "STACKDUKE_SCAN_QUIET_TOKEN", signInSecret: "STACKDUKE_OAUTH_QUIET" };
  const hidden: OAuthServer = { ...demo, id: "hidden", publish: false, tracked: true, tokenVariable: "STACKDUKE_SCAN_HIDDEN_TOKEN", signInSecret: "STACKDUKE_OAUTH_HIDDEN" };
  const handed = handOver({ demo: "access-1", quiet: "access-q", hidden: "access-h" }, [demo, quiet, hidden], { PATH: "/bin" });
  assert.deepEqual(handed, { PATH: "/bin", STACKDUKE_SCAN_DEMO_TOKEN: "access-1", STACKDUKE_SCAN_HIDDEN_TOKEN: "access-h" });
});

test("the private data is reached only by its own checkout and commit, and the public log is told nothing about it", () => {
  const all = steps();
  const usesKey = [...all].filter(([, block]) => /steps\.private(-save)?-key\.outputs\.token/.test(block)).map(([name]) => name);
  assert.deepEqual(usesKey, ["Check out the private data", "Commit the private data"]);
  for (const name of ["Key for the private data", "Key for saving the private data"]) {
    assert.match(all.get(name) as string, /repositories: stackduke-intelligence/, name);
    assert.match(all.get(name) as string, /permission-contents: write/, name);
  }
  assert.match(all.get("Scan") as string, /--private-data=/);
  assert.match(all.get("Private notice") as string, /--data=private-data/);
  assert.ok(!/echo .*\$\(|git (log|diff)(?! --cached --quiet)/.test(all.get("Commit the private data") as string), "it prints nothing about what changed");
});

test("the files the sign-in steps leave are readable by this user only", async () => {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "sign-ins-")), "sign-ins");
  await writePrivate(dir, "access.json", "{}");
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dir, "access.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await readStep(dir, "access.json", isAccess), {});
  assert.equal(await readStep(dir, "renewed.json", isAccess), null);
});

test("once a renewed sign-in cannot be saved, no other is renewed that run", async () => {
  const other: OAuthServer = { ...demo, id: "other", name: "Other", signInSecret: "STACKDUKE_OAUTH_OTHER", tokenVariable: "STACKDUKE_SCAN_OTHER_TOKEN" };
  const { fetchImpl, seen } = vendor();
  const kept = saver(false);
  const environment = { STACKDUKE_OAUTH_DEMO: JSON.stringify(stored()), STACKDUKE_OAUTH_OTHER: JSON.stringify({ ...stored({ expiresAt: "2026-10-18T06:00:00.000Z" }), vendor: "other" }) };
  const { reports, access } = await renewSignIns({ environment, save: kept.save, mask: () => undefined, fetchImpl, now: () => now, servers: [demo, other] });
  assert.equal(reports[0]?.status, "lost");
  assert.deepEqual(reports[1], { vendor: "other", status: "kept", detail: "renewing stopped in this run, after a renewed sign-in could not be saved" });
  assert.equal(access.other, "access-1");
  assert.equal(seen.filter((request) => request.url === tokenEndpoint).length, 1);
  assert.equal(kept.saved.length, 1);
});

test("a sign-in server that is down while the access token has run out is a sign-in lost, so a person is told", async () => {
  const { reports, access } = await renewSignIns({ environment: environmentWith(stored()), save: saver().save, mask: () => undefined, ...vendor({ tokenStatus: "down" }), now: () => now, servers: [demo] });
  assert.deepEqual(reports, [{ vendor: "demo", status: "lost", detail: "its sign-in server could not be reached, and the access token has run out" }]);
  assert.deepEqual(access, {});
  assert.equal(verdictsOf(reports, [{ vendor: "demo", status: "no-token" }], [demo])[0]?.verdict, "needs-person");
});

test("an access token about to run out is not handed on", async () => {
  const { reports } = await renewSignIns({ environment: environmentWith(stored({ expiresAt: "2026-10-18T04:30:00.000Z" })), mask: () => undefined, ...vendor(), now: () => now, servers: [demo] });
  assert.equal(reports[0]?.status, "lost");
});

test("without the app, a lost sign-in's issue says to set the app up first", async () => {
  const { reports } = await renewSignIns({ environment: environmentWith(stored()), mask: () => undefined, ...vendor(), now: () => now, servers: [demo] });
  assert.equal(reports[0]?.fix, "set-up-app");
  const told = issues();
  await signInIssues(reports, [], "2026-10-18", told.deps);
  assert.deepEqual(told.opened.map((issue) => issue.title), [renewalOffTitle, issueTitle("Demo")]);
  assert.match(told.opened.find((issue) => issue.title === issueTitle("Demo"))?.body as string, /First set up the GitHub App/);
  const plain = issues();
  await signInIssues(lost, [], "2026-10-18", plain.deps);
  assert.doesNotMatch(plain.opened[0]?.body as string, /GitHub App/);
});

test("a value is hidden from the log as itself, even when it holds what the runner would read as an escape", () => {
  assert.equal(maskCommand("abc%25def%0A"), "::add-mask::abc%2525def%250A\n");
  assert.equal(maskCommand("plain-token"), "::add-mask::plain-token\n");
});

test("saving a renewed sign-in is tried three times, then reported as not saved", async () => {
  let tries = 0;
  const failing = async () => { tries += 1; return false; };
  assert.equal(await saveSecret("STACKDUKE_OAUTH_DEMO", "{}", "Stackduke/mcp-scanner", { set: failing, wait: async () => undefined }), false);
  assert.equal(tries, 3);
  tries = 0;
  const second = async () => { tries += 1; return tries === 2; };
  assert.equal(await saveSecret("STACKDUKE_OAUTH_DEMO", "{}", "Stackduke/mcp-scanner", { set: second, wait: async () => undefined }), true);
  assert.equal(tries, 2);
});

test("a run with no key to save renewals opens one issue about the key, while sign-ins still work, and closes it once renewing works", async () => {
  const { reports } = await renewSignIns({ environment: environmentWith(stored({ expiresAt: "2026-10-18T09:00:00.000Z" })), mask: () => undefined, ...vendor(), now: () => now, servers: [demo] });
  assert.equal(reports[0]?.status, "kept");
  const off = issues();
  assert.equal(await signInIssues(reports, answered, "2026-10-18", off.deps), true);
  assert.deepEqual(off.opened.map((issue) => issue.title), [renewalOffTitle]);
  assert.match(off.opened[0]?.body as string, /Key for saving renewed sign-ins/);
  // The next broken run does not open it twice.
  const again = issues([{ number: 9, title: renewalOffTitle }]);
  await signInIssues(reports, answered, "2026-10-19", again.deps);
  assert.deepEqual(again.opened, []);
  // A run that renews again closes it.
  const fixed = issues([{ number: 9, title: renewalOffTitle }]);
  await signInIssues([{ vendor: "demo", status: "renewed" }], answered, "2026-10-20", fixed.deps);
  assert.deepEqual(fixed.closed, [9]);
});

test("a sign-in that gives no refresh token is kept without any alarm about the key", async () => {
  const { reports } = await renewSignIns({ environment: environmentWith(stored({ refreshToken: undefined, expiresAt: "2026-10-18T09:00:00.000Z" })), mask: () => undefined, ...vendor(), now: () => now, servers: [demo] });
  assert.deepEqual(reports, [{ vendor: "demo", status: "kept" }]);
  const quiet = issues();
  await signInIssues(reports, answered, "2026-10-18", quiet.deps);
  assert.deepEqual(quiet.opened, []);
});
