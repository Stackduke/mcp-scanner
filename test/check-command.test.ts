import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * The check end to end: the command itself, run against the sample server in examples/, as a
 * pipeline would run it.
 */
const cli = path.resolve("src/cli.ts");
const server = path.resolve("examples/sample-server/server.ts");
const committedLock = path.resolve("examples/sample-server/stackduke.lock.json");

function run(args: string[], options: { cwd?: string; variant?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: options.cwd, env: { ...process.env, SAMPLE_SERVER_VARIANT: options.variant ?? "" } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

test("passes against the approved sample server, and fails when its tools change", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "check-"));
  await copyFile(committedLock, path.join(folder, "stackduke.lock.json"));

  const passed = await run(["check", "--summary=summary.md", "--", process.execPath, server], { cwd: folder });
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /## Stackduke MCP tool check: passed/);
  assert.match(passed.stdout, /Compared the 3 tools listed by the local program given with `stackduke\.lock\.json`\./);
  assert.equal(await readFile(path.join(folder, "summary.md"), "utf8"), `${passed.stdout.trimEnd()}\n`);

  const failed = await run(["check", "--summary=summary.md", `--command=${process.execPath} ${server}`], { cwd: folder, variant: "changed" });
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /## Stackduke MCP tool check: failed/);
  assert.match(failed.stdout, /- `archive_all_notes`: added; counted as able to create or change things/);
  assert.match(failed.stdout, /- `create_note`: description rewritten/);
  assert.match(failed.stdout, /- `archive_all_notes` · `annotations`: Counted as able to create or change things, but it carries no risk annotation/);
  assert.match(await readFile(path.join(folder, "summary.md"), "utf8"), /check: failed/);

  // Approving the change: --update stops at the unannotated tool until the finding is accepted too.
  const refused = await run(["check", "--update", "--", process.execPath, server], { cwd: folder, variant: "changed" });
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /lockfile not updated/);
  assert.equal(await readFile(path.join(folder, "stackduke.lock.json"), "utf8"), await readFile(committedLock, "utf8"));
  const approved = await run(["check", "--update", "--accept-findings", "--", process.execPath, server], { cwd: folder, variant: "changed" });
  assert.equal(approved.code, 0);
  assert.match(approved.stdout, /lockfile updated/);
  const again = await run(["check", "--", process.execPath, server], { cwd: folder, variant: "changed" });
  assert.equal(again.code, 0, again.stdout);
  // And the original sample now fails, because the approved list moved on.
  assert.equal((await run(["check", "--", process.execPath, server], { cwd: folder })).code, 1);
});

test("--update writes the same file as the one committed, and leaves it alone when nothing changed", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "check-"));
  const first = await run(["check", "--update", "--lockfile=tools.lock.json", "--", process.execPath, server], { cwd: folder });
  assert.equal(first.code, 0);
  assert.equal(await readFile(path.join(folder, "tools.lock.json"), "utf8"), await readFile(committedLock, "utf8"));
  const second = await run(["check", "--update", "--lockfile=tools.lock.json", "--", process.execPath, server], { cwd: folder });
  assert.match(second.stdout, /already matches\. Nothing was written\./);
});

test("checks a server at a web address on this machine", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "check-"));
  await copyFile(committedLock, path.join(folder, "stackduke.lock.json"));
  const tools = JSON.parse(await readFile(committedLock, "utf8")).tools as unknown[];
  const http = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === "initialize" ? { serverInfo: { name: "http-sample" } } : { tools };
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = http.address() as AddressInfo;
    const passed = await run(["check", `http://127.0.0.1:${port}/mcp?key=private-value`], { cwd: folder });
    assert.equal(passed.code, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, new RegExp(`listed by the server at \`127\\.0\\.0\\.1:${port}\``));
    assert.doesNotMatch(passed.stdout, /private-value/, "only the host is shown");
  } finally {
    http.close();
  }
});

test("refuses what it should not do, before starting anything", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["check"], /one server/],
    [["check", "https://a.example/mcp", "--", "node", "x.js"], /one server/],
    [["check", "http://example.com/mcp"], /http:\/\/ only on this machine/],
    [["check", "https://user:secret@example.com/mcp"], /user name or password/],
    [["check", "--accept-findings", "https://example.com/mcp"], /only used with --update/],
    [["check", "--timeout=0", "https://example.com/mcp"], /--timeout takes/],
    [["check", "--updat", "https://example.com/mcp"], /does not take --updat/],
    [["check", "--command=node 'x.js"], /quotes closed/],
    [["check", `--command=""`], /quotes closed/],
    [["check", "--", ""], /no name/],
  ];
  for (const [args, message] of cases) {
    const result = await run(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.stderr, message, args.join(" "));
    assert.doesNotMatch(result.stderr + result.stdout, /secret/);
  }
});

test("a server that cannot be listed gives a summary and its own exit code", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "check-"));
  const result = await run(["check", "--summary=summary.md", "--", process.execPath, "-e", "console.error('needs NOTES_API_KEY'); process.exit(1)"], { cwd: folder });
  assert.equal(result.code, 4);
  assert.match(result.stdout, /check: could not run/);
  assert.match(result.stderr, /program stderr \| needs NOTES_API_KEY/);
  assert.doesNotMatch(await readFile(path.join(folder, "summary.md"), "utf8"), /NOTES_API_KEY/, "the program's own words stay out of the summary");
});

test("a definition nested too deeply to compare gives a summary, not a crash", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "check-"));
  const deep = `let schema = {}; for (let i = 0; i < 300; i += 1) schema = { a: schema };`;
  const program = `${deep}
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      const result = message.method === "initialize" ? {} : { tools: [{ name: "deep", inputSchema: schema }] };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    });`;
  const result = await run(["check", "--summary=summary.md", "--", process.execPath, "-e", program], { cwd: folder });
  assert.equal(result.code, 4, result.stdout + result.stderr);
  assert.match(await readFile(path.join(folder, "summary.md"), "utf8"), /nested too deeply/);
});

test("the program does not see the CI's command files or tokens", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "check-"));
  // The program lists one tool, named after the CI variables it can see.
  const program = `
    const seen = ["GITHUB_ENV", "GITHUB_TOKEN", "NOTES_SETTING"].filter((name) => process.env[name]).join("_") || "none";
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      const result = message.method === "initialize" ? {} : { tools: [{ name: "saw_" + seen, annotations: { readOnlyHint: true } }] };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    });`;
  const outcome = await new Promise<string>((resolve) => {
    execFile(process.execPath, [cli, "check", "--", process.execPath, "-e", program], { cwd: folder, env: { ...process.env, GITHUB_ENV: "/tmp/x", GITHUB_TOKEN: "t", NOTES_SETTING: "1" } }, (_error, stdout) => resolve(stdout));
  });
  assert.match(outcome, /`saw_NOTES_SETTING`/);
});
