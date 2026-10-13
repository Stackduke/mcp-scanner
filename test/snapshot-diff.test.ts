import assert from "node:assert/strict";
import { test } from "node:test";
import { diffSnapshots } from "../src/diff.ts";
import { canonical, fingerprint, takeSnapshot } from "../src/snapshot.ts";

test("the fingerprint ignores key order and changes with any field", () => {
  const a = { name: "t", description: "d", inputSchema: { type: "object", properties: { x: { type: "string" }, y: { type: "number" } } } };
  const reordered = { inputSchema: { properties: { y: { type: "number" }, x: { type: "string" } }, type: "object" }, description: "d", name: "t" };
  assert.equal(fingerprint(a), fingerprint(reordered));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, description: "d." }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, annotations: { readOnlyHint: true } }));
  // Array order can carry meaning in a schema, so it is kept.
  assert.notEqual(canonical({ required: ["a", "b"] }), canonical({ required: ["b", "a"] }));
});

test("a snapshot sorts tools, keeps the first of a repeated name and keeps named variants apart", () => {
  const snapshot = takeSnapshot("https://example.test/mcp", [{ name: "b" }, { name: "a", description: "first" }, { name: "a", description: "second" }, { name: "a", variant: "a_flagged", description: "variant" }], { name: "Demo" }, "2026-10-13T00:00:00.000Z");
  assert.deepEqual(snapshot.tools.map((tool) => [tool.name, tool.variant, tool.description]), [["a", undefined, "first"], ["a", "a_flagged", "variant"], ["b", undefined, undefined]]);
  assert.equal(snapshot.server?.name, "Demo");
  assert.match(snapshot.tools[0]?.hash ?? "", /^[0-9a-f]{64}$/);
});

test("a comparison reports added, removed and changed tools, and which fields changed", () => {
  const before = takeSnapshot("v1", [{ name: "keep", description: "same" }, { name: "gone" }, { name: "edit", description: "old", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
  const after = takeSnapshot("v2", [{ name: "keep", description: "same" }, { name: "new" }, { name: "edit", description: "new", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }]);
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.added.map((tool) => tool.name), ["new"]);
  assert.deepEqual(diff.removed.map((tool) => tool.name), ["gone"]);
  assert.deepEqual(diff.changed.map((change) => [change.name, change.fields]), [["edit", ["description", "annotations"]]]);
  assert.deepEqual(diff.changed[0]?.how, { description: "altered", annotations: "altered" });
  assert.equal(diff.unchanged, 1);
});

test("a field that only appeared or disappeared is told apart from one that was rewritten", () => {
  const before = takeSnapshot("v1", [{ name: "gains", description: "d" }, { name: "loses", description: "d", outputSchema: { type: "object" } }]);
  const after = takeSnapshot("v2", [{ name: "gains", description: "d", outputSchema: { type: "object" } }, { name: "loses", description: "d" }]);
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.changed.map((change) => [change.name, change.how]), [["gains", { outputSchema: "added" }], ["loses", { outputSchema: "removed" }]]);
});

test("a definition nested absurdly deep is refused with a clear message", () => {
  let nested: unknown = "x";
  for (let depth = 0; depth < 5000; depth += 1) nested = [nested];
  assert.throws(() => takeSnapshot("v1", [{ name: "deep", inputSchema: nested }]), /nested too deeply/);
});

test("a new variant of an existing tool is an addition, not hidden behind the plain definition", () => {
  const before = takeSnapshot("v1", [{ name: "list_issues", description: "d" }]);
  const after = takeSnapshot("v2", [{ name: "list_issues", description: "d" }, { name: "list_issues", variant: "list_issues_output", description: "d", outputSchema: { type: "object" } }]);
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.added.map((tool) => [tool.name, tool.variant]), [["list_issues", "list_issues_output"]]);
  assert.deepEqual(diff.addedToExistingTools, ["list_issues#list_issues_output"]);
  assert.equal(diff.unchanged, 1);
});
