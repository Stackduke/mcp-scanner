import assert from "node:assert/strict";
import { test } from "node:test";
import { diffSnapshots } from "../src/diff.ts";
import { snapshotFromRepository } from "../src/sources/github-snapshots.ts";

function fakeGitHub(files: Record<string, unknown>, options: { truncated?: boolean; missing?: string[] } = {}) {
  const requested: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ truncated: options.truncated ?? false, tree: [...Object.keys(files).map((path) => ({ path, type: "blob" })), { path: "pkg/github/__toolsnaps__", type: "tree" }, { path: "README.md", type: "blob" }] }), { status: 200 });
    }
    const path = decodeURIComponent(url.split("/v2.0.0/")[1] ?? "");
    if (options.missing?.includes(path)) return new Response("", { status: 404 });
    return new Response(typeof files[path] === "string" ? (files[path] as string) : JSON.stringify(files[path]), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requested };
}
const dir = "pkg/github/__toolsnaps__";

test("definition files become a snapshot, and only files in the named directory are read", async () => {
  const { fetchImpl, requested } = fakeGitHub({ [`${dir}/list_issues.snap`]: { name: "list_issues", description: "Lists issues." }, [`${dir}/issue_write.snap`]: { name: "issue_write" }, "docs/__other__/x.snap": { name: "ignored" } });
  const snapshot = await snapshotFromRepository({ repository: "github/github-mcp-server", ref: "v2.0.0", fetchImpl });
  assert.equal(snapshot.source, "github:github/github-mcp-server@v2.0.0");
  assert.deepEqual(snapshot.tools.map((tool) => tool.name), ["issue_write", "list_issues"]);
  assert.ok(!requested.some((url) => url.includes("__other__") || url.includes("README")));
});

test("a second file for the same tool is kept as a named variant", async () => {
  const { fetchImpl } = fakeGitHub({ [`${dir}/list_issues.snap`]: { name: "list_issues" }, [`${dir}/list_issues_output.snap`]: { name: "list_issues", outputSchema: { type: "object" } } });
  const snapshot = await snapshotFromRepository({ repository: "github/github-mcp-server", ref: "v2.0.0", fetchImpl });
  assert.deepEqual(snapshot.tools.map((tool) => [tool.name, tool.variant]), [["list_issues", undefined], ["list_issues", "list_issues_output"]]);
});

test("a variant keeps one identity across tags, whether or not a plain definition exists beside it", async () => {
  const flagged = { name: "foo", description: "flagged" };
  const earlier = await snapshotFromRepository({ repository: "o/r", ref: "v2.0.0", fetchImpl: fakeGitHub({ [`${dir}/foo_flag.snap`]: flagged }).fetchImpl });
  const later = await snapshotFromRepository({ repository: "o/r", ref: "v2.0.0", fetchImpl: fakeGitHub({ [`${dir}/foo_flag.snap`]: flagged, [`${dir}/foo.snap`]: { name: "foo", description: "plain" } }).fetchImpl });
  assert.deepEqual(earlier.tools.map((tool) => [tool.name, tool.variant]), [["foo", "foo_flag"]]);
  const diff = diffSnapshots(earlier, later);
  assert.deepEqual([diff.added.map((tool) => [tool.name, tool.variant]), diff.changed.length, diff.unchanged], [[["foo", undefined]], 0, 1]);
});

test("the same file name in two directories gives two definitions, not one silently dropped", async () => {
  const { fetchImpl } = fakeGitHub({ [`pkg/a/${"__toolsnaps__"}/foo.snap`]: { name: "foo", description: "a" }, [`pkg/b/${"__toolsnaps__"}/foo.snap`]: { name: "foo", description: "b" } });
  const snapshot = await snapshotFromRepository({ repository: "o/r", ref: "v2.0.0", fetchImpl });
  assert.deepEqual(snapshot.tools.map((tool) => [tool.name, tool.variant]), [["foo", undefined], ["foo", "pkg/b/__toolsnaps__/foo"]]);
});

test("an incomplete read fails loudly instead of looking like removed tools", async () => {
  const files = { [`${dir}/a.snap`]: { name: "a" }, [`${dir}/b.snap`]: { name: "b" } };
  await assert.rejects(snapshotFromRepository({ repository: "o/r", ref: "v2.0.0", fetchImpl: fakeGitHub(files, { missing: [`${dir}/b.snap`] }).fetchImpl }), /1 of 2 definition files could not be read/);
  await assert.rejects(snapshotFromRepository({ repository: "o/r", ref: "v2.0.0", fetchImpl: fakeGitHub({ ...files, [`${dir}/c.snap`]: "not json" }).fetchImpl }), /could not be read/);
  await assert.rejects(snapshotFromRepository({ repository: "o/r", ref: "v2.0.0", fetchImpl: fakeGitHub(files, { truncated: true }).fetchImpl }), /cut short/);
  await assert.rejects(snapshotFromRepository({ repository: "o/r", ref: "v2.0.0", fetchImpl: fakeGitHub({}).fetchImpl }), /no files under/);
  await assert.rejects(snapshotFromRepository({ repository: "not a repo", ref: "v2.0.0" }), /owner\/name/);
});

test("a token, when given, goes only to the listing request", async () => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return url.startsWith("https://api.github.com/") ? new Response(JSON.stringify({ tree: [{ path: `${dir}/a.snap`, type: "blob" }] }), { status: 200 }) : new Response(JSON.stringify({ name: "a" }), { status: 200 });
  }) as typeof fetch;
  await snapshotFromRepository({ repository: "o/r", ref: "v2.0.0", fetchImpl, token: "token-for-test" });
  assert.equal(seen[0]?.auth, "Bearer token-for-test");
  assert.equal(seen[1]?.auth, undefined);
});
