import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { listToolsStdio, programEnvironment, splitCommand } from "../src/stdio.ts";

const node = process.execPath;
const sample = path.resolve("examples/sample-server/server.ts");

/** A program that answers each request with what `answer` returns for it, written as one line of JSON. */
function program(answer: string, before = ""): string[] {
  return [node, "-e", `
    ${before}
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      const result = (${answer})(message);
      if (result !== undefined) send(result);
    });`];
}
const hello = `(m) => m.method === "initialize" ? { jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "t" } } }`;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("lists every page of tools from a program, then stops it", async () => {
  const result = await listToolsStdio([node, sample]);
  assert.equal(result.outcome, "listed");
  assert.deepEqual(result.outcome === "listed" ? result.tools.map((tool) => tool.name) : [], ["search_notes", "create_note", "delete_note"]);
  assert.deepEqual(result.outcome === "listed" ? result.server : {}, { name: "sample-notes", version: "1.0.0" });
});

test("stops the program and anything it started", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "stdio-"));
  const pids = path.join(folder, "pids");
  const command = program(`${hello} : { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "a" }] } }`, `
    const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(pids)}, process.pid + " " + child.pid);`);
  const result = await listToolsStdio(command);
  assert.equal(result.outcome, "listed");
  const [parent, grandchild] = (await readFile(pids, "utf8")).split(" ").map(Number) as [number, number];
  for (let tries = 0; tries < 30 && (alive(parent) || alive(grandchild)); tries += 1) await sleep(100);
  assert.equal(alive(parent), false, "the program was stopped");
  assert.equal(alive(grandchild), false, "what it started was stopped too");
});

test("skips lines that are not JSON-RPC, and refuses requests from the program", async () => {
  const command = program(`(m) => {
    if (m.method === "initialize") { process.stdout.write("starting up...\\n{not json\\n"); send({ jsonrpc: "2.0", id: "x", method: "roots/list" }); return { jsonrpc: "2.0", id: m.id, result: {} }; }
    if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "b" + globalThis.refused }] } };
    if (m.error) globalThis.refused = m.error.code;
  }`, "globalThis.refused = '';");
  const result = await listToolsStdio(command);
  assert.deepEqual(result, { outcome: "listed", server: {}, tools: [{ name: "b-32601" }] });
});

test("a program that cannot be started is unreachable", async () => {
  const result = await listToolsStdio(["stackduke-no-such-program-here"]);
  assert.deepEqual(result, { outcome: "unreachable", detail: "the program could not be started (ENOENT)" });
});

test("a program that ends before answering is unreachable, and its last error output is kept", async () => {
  const result = await listToolsStdio([node, "-e", "console.error('missing API key'); process.exit(3)"]);
  assert.equal(result.outcome, "unreachable");
  assert.equal(result.outcome === "unreachable" ? result.detail : "", "the program ended before it answered (exit code 3)");
  assert.equal(result.stderrTail, "missing API key\n");
});

test("a program that never answers times out", async () => {
  const result = await listToolsStdio([node, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300 });
  assert.deepEqual(result, { outcome: "unreachable", detail: "no reply within 300 ms" });
});

test("a refused tools/list and an oversized reply are not usable", async () => {
  const refused = await listToolsStdio(program(`${hello} : { jsonrpc: "2.0", id: m.id, error: { code: -1, message: "no" } }`));
  assert.deepEqual(refused, { outcome: "not-usable", detail: "tools/list was refused" });
  const huge = await listToolsStdio(program(`${hello} : { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "x", description: "y".repeat(5_000_000) }] } }`));
  assert.deepEqual(huge, { outcome: "not-usable", detail: "a reply was larger than this scanner accepts" });
});

test("the program gets the environment it is given", async () => {
  const result = await listToolsStdio([node, sample], { env: { ...process.env, SAMPLE_SERVER_VARIANT: "changed" } });
  assert.equal(result.outcome === "listed" ? result.tools.length : 0, 4);
});

test("splits a command line into words the way a shell does for plain words and quotes", () => {
  assert.deepEqual(splitCommand("node dist/server.js --port 3000"), ["node", "dist/server.js", "--port", "3000"]);
  assert.deepEqual(splitCommand(`npx -y "@scope/my server" 'it''s' a\\ b ""`), ["npx", "-y", "@scope/my server", "its", "a b", ""]);
  assert.deepEqual(splitCommand(`echo "say \\"hi\\"" $HOME *.js | x`), ["echo", 'say "hi"', "$HOME", "*.js", "|", "x"]);
  assert.deepEqual(splitCommand('echo "\\$HOME \\`x\\`"'), ["echo", "$HOME `x`"]);
  assert.equal(splitCommand(`node "unclosed`), null);
  assert.deepEqual(splitCommand("   "), []);
});

test("reads a last reply that ends without a newline", async () => {
  const command = [node, "-e", `
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
      if (message.method === "tools/list") process.stdout.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "last" }] } }));
    });`];
  assert.deepEqual(await listToolsStdio(command), { outcome: "listed", server: {}, tools: [{ name: "last" }] });
});

test("the program's environment leaves out CI command files and tokens", () => {
  const env = programEnvironment({ PATH: "/bin", NOTES_API_KEY: "kept", GITHUB_ENV: "/x", GITHUB_STEP_SUMMARY: "/y", GITHUB_TOKEN: "t", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t", CI_JOB_TOKEN: "t", github_path: "/z" });
  assert.deepEqual(env, { PATH: "/bin", NOTES_API_KEY: "kept" });
});
