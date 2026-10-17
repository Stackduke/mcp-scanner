import assert from "node:assert/strict";
import { test } from "node:test";
import { catalog, catalogProblems, readCatalog } from "../src/catalog.ts";
import { signedInServers, signedInServersOf } from "../src/signed-in.ts";

const server = (changes: Record<string, unknown> = {}) => ({
  id: "demo", name: "Demo", url: "https://mcp.demo.example/mcp", site: "https://demo.example",
  signIn: "oauth-dcr", signInCheckedOn: "2026-10-17", termsCheckedOn: "2026-10-17",
  tracker: { publish: true, access: { kind: "api-key", tokenVariable: "STACKDUKE_SCAN_DEMO_TOKEN", keyPage: "https://demo.example/keys", keyAdvice: "Read only." } },
  ...changes,
});
const problemsOf = (...servers: unknown[]) => catalogProblems({ version: 1, servers });

test("the catalog in the repository is usable", () => {
  assert.deepEqual(catalogProblems(catalog), []);
  assert.ok(catalog.servers.length > 0);
});

test("the tracker sends tokens to the same four addresses as before the catalog", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(signedInServers).map(([id, entry]) => [id, [entry.url, entry.tokenVariable]])), {
    github: ["https://api.githubcopilot.com/mcp/", "STACKDUKE_SCAN_GITHUB_TOKEN"],
    linear: ["https://mcp.linear.app/mcp", "STACKDUKE_SCAN_LINEAR_TOKEN"],
    stripe: ["https://mcp.stripe.com/", "STACKDUKE_SCAN_STRIPE_TOKEN"],
    supabase: ["https://mcp.supabase.com/mcp", "STACKDUKE_SCAN_SUPABASE_TOKEN"],
  });
  assert.equal(signedInServers.github?.formerVariable, "AETHIS_SCAN_GITHUB_TOKEN");
});

test("a server the tracker does not publish is never given a token", () => {
  const listed = signedInServersOf([server({ id: "kept-quiet", tracker: { publish: false, reason: "Its terms forbid it." } })] as never);
  assert.deepEqual(listed, {});
  for (const quiet of catalog.servers.filter((entry) => !entry.tracker.publish)) assert.ok(!Object.hasOwn(signedInServers, quiet.id));
});

test("Sentry and Intercom are in the catalog, never published, and marked as forbidden by their terms", () => {
  for (const id of ["sentry", "intercom"]) assert.deepEqual(catalog.servers.find((entry) => entry.id === id)?.tracker, { ...catalog.servers.find((entry) => entry.id === id)?.tracker, publish: false, forbidden: true });
  assert.deepEqual(problemsOf(server({ termsCheckedOn: null, tracker: { publish: false, reason: "Forbidden.", forbidden: true } })), ["demo: is marked forbidden, but nobody has read its terms"]);
});

test("a well-formed server has no problems", () => {
  assert.deepEqual(problemsOf(server()), []);
});

test("an address that could carry a secret or point elsewhere is refused", () => {
  for (const url of ["http://mcp.demo.example/mcp", "https://user:pass@mcp.demo.example/mcp", "https://mcp.demo.example/mcp?token=x", "https://mcp.demo.example/mcp#x", "mcp.demo.example", "https://MCP.demo.example/mcp"]) {
    assert.ok(problemsOf(server({ url })).some((problem) => problem.includes("url")), url);
  }
});

test("publishing needs someone to have read the vendor's terms", () => {
  assert.deepEqual(problemsOf(server({ termsCheckedOn: null })), ["demo: is published, but nobody has read its terms"]);
});

test("a server kept off the tracker says why", () => {
  assert.deepEqual(problemsOf(server({ tracker: { publish: false } })), ["demo: a server the tracker does not publish needs a reason"]);
});

test("ids, addresses and token variables are each used once", () => {
  const twice = problemsOf(server(), server());
  assert.ok(twice.includes("demo: id is used twice"));
  assert.ok(twice.includes("demo: url is used twice"));
  assert.ok(twice.includes("demo: STACKDUKE_SCAN_DEMO_TOKEN is used twice"));
});

test("an id that could reach an object's built-in properties is refused", () => {
  for (const id of ["__proto__", "Demo", "a"]) {
    assert.ok(problemsOf(server({ id })).some((problem) => problem.includes("id must be")), id);
  }
});

test("unknown sign-in methods, bad dates and bad token variable names are refused", () => {
  assert.ok(problemsOf(server({ signIn: "password" }))[0]?.includes("signIn must be one of"));
  assert.ok(problemsOf(server({ signInCheckedOn: "17 Oct" }))[0]?.includes("signInCheckedOn"));
  const badVariable = server({ tracker: { publish: true, access: { kind: "api-key", tokenVariable: "PATH", keyPage: "https://demo.example/keys", keyAdvice: "Read only." } } });
  assert.ok(problemsOf(badVariable)[0]?.includes("its token variable must be STACKDUKE_SCAN_DEMO_TOKEN"));
  assert.ok(problemsOf(server({ signInCheckedOn: "2026-02-30" }))[0]?.includes("signInCheckedOn"), "a day that does not exist");
});

test("a token variable is named after its server, so an edit cannot hand one vendor's token to another", () => {
  const swapped = server({ id: "other", url: "https://mcp.other.example/mcp" });
  assert.ok(problemsOf(server(), swapped).includes("other: its token variable must be STACKDUKE_SCAN_OTHER_TOKEN"));
  const hyphen = server({ id: "cloud-bindings", tracker: { publish: true, access: { kind: "api-key", tokenVariable: "STACKDUKE_SCAN_CLOUD_BINDINGS_TOKEN", keyPage: "https://demo.example/keys", keyAdvice: "Read only." } } });
  assert.deepEqual(problemsOf(hyphen), []);
  const former = server({ tracker: { publish: true, access: { kind: "api-key", tokenVariable: "STACKDUKE_SCAN_DEMO_TOKEN", formerVariable: "AETHIS_SCAN_GITHUB_TOKEN", keyPage: "https://demo.example/keys", keyAdvice: "Read only." } } });
  assert.ok(problemsOf(former)[0]?.includes("former token variable"));
});

test("text the console will show has no control or invisible characters, and an address differing by a slash is the same", () => {
  assert.ok(problemsOf(server({ name: "Demo\u001b[2J" }))[0]?.includes("needs a name"));
  assert.ok(problemsOf(server({ tracker: { publish: false, reason: "Hidden\u200b text" } }))[0]?.includes("needs a reason"));
  assert.ok(problemsOf(server(), server({ id: "again", url: "https://mcp.demo.example/mcp/", tracker: { publish: false, reason: "Twice." } })).includes("again: url is used twice"));
});

test("a catalog with problems is not loaded", () => {
  assert.throws(() => readCatalog(JSON.stringify({ version: 1, servers: [server({ url: "http://x" })] })), /not usable/);
  assert.throws(() => readCatalog(JSON.stringify({ servers: [] })), /not usable/);
});
