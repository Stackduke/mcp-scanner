import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readToken, scanSignedIn, signedInServers } from "../src/signed-in.ts";

type Sent = { url: string; authorization: string | undefined };
function fakeServer(...responses: Response[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), authorization: (init?.headers as Record<string, string>).Authorization });
    const next = responses.shift();
    if (!next) throw new Error("no response prepared");
    return next;
  }) as typeof fetch;
  return { fetchImpl, sent };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
const hello = (name = "Demo") => json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name }, capabilities: {} } });
const tools = (list: unknown[]) => json({ jsonrpc: "2.0", id: 2, result: { tools: list } });
const token = "made-up-token-for-this-test";
const variable = "STACKDUKE_SCAN_GITHUB_TOKEN";

test("every signed-in server has a fixed https address and its own token variable", () => {
  const variables = Object.values(signedInServers).map((server) => server.tokenVariable);
  assert.equal(new Set(variables).size, variables.length);
  for (const server of Object.values(signedInServers)) {
    assert.equal(new URL(server.url).protocol, "https:");
    assert.equal(new URL(server.url).username + new URL(server.url).password + new URL(server.url).search, "");
    assert.match(server.tokenVariable, /^STACKDUKE_SCAN_[A-Z]+_TOKEN$/);
  }
});

test("a token is taken as it is, without the white space around it", () => {
  assert.deepEqual(readToken("  made-up_token.123\n"), { ok: true, token: "made-up_token.123" });
});

test("an absent or empty token is missing", () => {
  for (const value of [undefined, "", "   ", "\n"]) assert.deepEqual(readToken(value), { ok: false, reason: "missing" });
});

test("a value that could break out of a header is refused, and is not echoed", () => {
  for (const value of ["two words", "line\r\nX-Injected: yes", "tab\there", "caf\u00e9", "nul\u0000", "a".repeat(4_097)]) {
    const read = readToken(value);
    assert.deepEqual(read, { ok: false, reason: "malformed" });
    assert.ok(!JSON.stringify(read).includes(value));
  }
});

test("the token goes to the server's fixed address and nowhere else", async () => {
  const { fetchImpl, sent } = fakeServer(hello(), new Response(null, { status: 202 }), tools([{ name: "list_repositories" }]));
  const scan = await scanSignedIn("github", { [variable]: token }, fetchImpl);
  assert.equal(scan.outcome, "answered");
  assert.equal(scan.outcome === "answered" && scan.result.outcome, "listed");
  assert.deepEqual(sent, Array(3).fill({ url: signedInServers.github?.url, authorization: `Bearer ${token}` }));
  assert.ok(!JSON.stringify(scan).includes(token));
});

test("the former variable is still read, and the current one wins when both are set", async () => {
  const former = fakeServer(hello(), new Response(null, { status: 202 }), tools([]));
  assert.equal((await scanSignedIn("github", { AETHIS_SCAN_GITHUB_TOKEN: token }, former.fetchImpl)).outcome, "answered");
  assert.equal(former.sent[0]?.authorization, `Bearer ${token}`);
  const both = fakeServer(hello(), new Response(null, { status: 202 }), tools([]));
  await scanSignedIn("github", { [variable]: token, AETHIS_SCAN_GITHUB_TOKEN: "made-up-older-token" }, both.fetchImpl);
  assert.equal(both.sent[0]?.authorization, `Bearer ${token}`);
});

test("a name that is not in the list sends nothing, whatever it is", async () => {
  for (const name of ["", "gitlab", "__proto__", "constructor", "toString", "https://example.test/mcp", "GitHub"]) {
    const { fetchImpl, sent } = fakeServer(hello());
    assert.deepEqual(await scanSignedIn(name, { [variable]: token }, fetchImpl), { outcome: "unknown-server" });
    assert.equal(sent.length, 0);
  }
});

test("without a usable token nothing is sent", async () => {
  for (const [value, reason] of [[undefined, "missing"], ["", "missing"], ["two words", "malformed"]] as const) {
    const { fetchImpl, sent } = fakeServer(hello());
    assert.deepEqual(await scanSignedIn("github", { [variable]: value }, fetchImpl), { outcome: "no-token", tokenVariable: variable, reason });
    assert.equal(sent.length, 0);
  }
});

test("the token is not sent when certificate checking is switched off", async () => {
  const { fetchImpl, sent } = fakeServer(hello());
  assert.deepEqual(await scanSignedIn("github", { [variable]: token, NODE_TLS_REJECT_UNAUTHORIZED: "0" }, fetchImpl), { outcome: "unsafe-connection", tokenVariable: variable });
  assert.equal(sent.length, 0);
});

test("a server that sends the token back has nothing it returned passed on", async () => {
  const inName = fakeServer(hello(`Demo ${token}`), new Response(null, { status: 202 }), tools([]));
  assert.deepEqual(await scanSignedIn("github", { [variable]: token }, inName.fetchImpl), { outcome: "token-echoed", url: signedInServers.github?.url });
  const inTool = fakeServer(hello(), new Response(null, { status: 202 }), tools([{ name: "echo", description: `You sent ${token}` }]));
  assert.deepEqual(await scanSignedIn("github", { [variable]: token }, inTool.fetchImpl), { outcome: "token-echoed", url: signedInServers.github?.url });
});

// The command itself, in the cases that stop before any request is made.
const run = promisify(execFile);
async function command(args: string[], environment: Record<string, string>) {
  const { PATH = "" } = process.env;
  try { const { stdout, stderr } = await run(process.execPath, ["src/cli.ts", ...args], { env: { PATH, ...environment } }); return { code: 0, output: stdout + stderr }; }
  catch (error) { const failed = error as { code?: number; stdout?: string; stderr?: string }; return { code: failed.code, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` }; }
}

test("the command never prints a token, and does not take one as an argument", async () => {
  const malformed = await command(["signed-in", "github"], { [variable]: "made-up secret-with-a-space" });
  assert.equal(malformed.code, 2);
  assert.ok(!malformed.output.includes("secret-with-a-space"));

  const asArgument = await command(["signed-in", "github", "made-up-token-as-argument"], {});
  assert.equal(asArgument.code, 2);
  assert.match(asArgument.output, /read from the environment only/);
  assert.ok(!asArgument.output.includes("made-up-token-as-argument"));

  const unknown = await command(["signed-in", "__proto__"], { [variable]: token });
  assert.equal(unknown.code, 2);
  assert.ok(!unknown.output.includes(token));

  const unchecked = await command(["signed-in", "github"], { [variable]: token, NODE_TLS_REJECT_UNAUTHORIZED: "0" });
  assert.equal(unchecked.code, 2);
  assert.match(unchecked.output, /was not sent/);
  assert.ok(!unchecked.output.includes(token));
});

test("connect tests each token on its vendor's server before storing it, and never prints it", async () => {
  const { connect } = await import("../src/connect.ts");
  const printed: string[] = [], stored: Array<[string, string, string]> = [];
  const answers = [token, "", "made-up-refused-token"];
  const respond = (value: string) => (value === token ? [hello(), new Response(null, { status: 202 }), tools([{ name: "list_issues" }])] : [new Response(null, { status: 401 })]);
  const result = await connect(["github", "linear", "stripe", "nobody"], "Stackduke/mcp-scanner", {
    readSecret: async () => answers.shift() ?? "",
    storeSecret: async (name, value, repository) => { stored.push([name, value, repository]); return true; },
    scan: (vendor, environment) => {
      const value = Object.values(environment)[0] as string;
      return scanSignedIn(vendor, environment, fakeServer(...respond(value)).fetchImpl);
    },
    print: (...lines) => printed.push(...lines),
  });
  assert.deepEqual(result, { stored: ["github"], skipped: ["linear", "stripe", "nobody"] });
  assert.deepEqual(stored, [["STACKDUKE_SCAN_GITHUB_TOKEN", token, "Stackduke/mcp-scanner"]]);
  assert.ok(printed.includes("  It works: the server listed 1 tool."));
  assert.ok(printed.includes("  The server refused it (HTTP 401). Not stored."));
  assert.ok(!printed.join("\n").includes(token) && !printed.join("\n").includes("made-up-refused-token"));
});
