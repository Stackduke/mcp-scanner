import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cellOf, cells, leading, readSet, score, sensitivity, wilson, type SetEntry, type Weights } from "../eval/score.ts";

const entry = (id: string, name: string, expected: SetEntry["expected"], extra: Partial<SetEntry["tool"]> = {}): SetEntry => ({
  id, server: "https://example.com/mcp", takenOn: "2026-11-01", tool: { name, ...extra }, sampledAs: "read/words", expected, reason: "test",
});

test("both sides are compared on what the tracker leads with", () => {
  assert.deepEqual(leading(["write", "money"]), ["money"]);
  assert.deepEqual(leading(["destructive", "send", "write"]), ["destructive", "send"]);
  assert.deepEqual(leading(["write"]), ["write"]);
  assert.deepEqual(leading(["read"]), ["read"]);
  assert.deepEqual(leading([]), ["unclear"]);
});

test("precision and recall are counted per label", () => {
  const result = score([
    entry("a", "delete_file", ["destructive"]),
    entry("b", "list_files", ["read"]),
    entry("c", "list_and_purge_files", ["destructive"]),
    entry("d", "get_record", ["write"]),
    entry("e", "send_email", ["send"]),
  ]);
  assert.equal(result.size, 5);
  assert.equal(result.right, 4);
  const read = result.byLabel.find((item) => item.label === "read");
  assert.deepEqual([read?.truePositives, read?.falsePositives, read?.falseNegatives], [1, 1, 0]);
  const write = result.byLabel.find((item) => item.label === "write");
  assert.equal(write?.recall.value, 0);
  assert.equal(write?.precision.value, null);
  assert.deepEqual(result.actingShownAsRead.map((row) => row.entry.id), ["d"]);
  assert.deepEqual(result.riskyMissed, []);
});

test("weights count each tool by how common its cell is", () => {
  const set = [
    { ...entry("a", "list_files", ["read"]), sampledAs: "read/words" as const },
    { ...entry("b", "get_thing", ["write"]), sampledAs: "write/words" as const },
  ];
  // Nine read tools for every write tool in the tracker: one right read outweighs one wrong write.
  const result = score(set, { kindCountsInTracker: { read: 90, write: 10 }, toolsSeenByCell: { "read/words": 5, "write/words": 5 } });
  assert.equal(result.right, 1);
  assert.ok(result.agreement.value !== null && Math.abs(result.agreement.value - 0.9) < 1e-9);
  assert.equal(result.inThisSet.value, 0.5);
});

test("a miss among common tools weighs on recall more than a hit among rare ones", () => {
  const set = [
    { ...entry("a", "send_email", ["send"]), sampledAs: "send/words" as const },
    { ...entry("b", "send_sms", ["send"]), sampledAs: "send/words" as const },
    // "ask" reads, but this one posts in public: a send the scanner misses, drawn from the large read cell.
    { ...entry("c", "ask_question", ["send"]), sampledAs: "read/words" as const },
  ];
  const weights = { kindCountsInTracker: { read: 99, send: 1 }, toolsSeenByCell: { "read/words": 1, "send/words": 1 } };
  const plain = score(set).byLabel.find((item) => item.label === "send");
  const weighted = score(set, weights).byLabel.find((item) => item.label === "send");
  assert.ok(plain?.recall.value !== null && Math.abs((plain?.recall.value ?? 0) - 2 / 3) < 1e-9);
  assert.ok((weighted?.recall.value ?? 1) < 0.2, String(weighted?.recall.value));
  assert.ok((weighted?.recall.low ?? 1) <= (weighted?.recall.value ?? 0) && (weighted?.recall.value ?? 1) <= (weighted?.recall.high ?? 0));
  assert.equal(weighted?.precision.value, 1);
});

test("a cell is the kind the tracker leads with and what decided it", () => {
  assert.equal(cellOf({ kind: "money", basis: "server" }), "money/server");
  assert.equal(cellOf({ kind: "send", basis: "name" }), "send/words");
  assert.equal(cellOf({ kind: "write", basis: "description" }), "write/words");
  assert.equal(cellOf({ kind: "unclear", basis: "server" }), "unclear");
});

test("each kind is split between annotations and words as seen while drawing", () => {
  const set = [
    { ...entry("a", "list_files", ["read"]), sampledAs: "read/server" as const },
    { ...entry("b", "get_thing", ["write"]), sampledAs: "read/words" as const },
  ];
  // Nine in ten read tools were decided by annotations: the right one there outweighs the wrong one.
  const result = score(set, { kindCountsInTracker: { read: 100 }, toolsSeenByCell: { "read/server": 90, "read/words": 10 } });
  assert.ok(result.agreement.value !== null && Math.abs(result.agreement.value - 0.9) < 1e-9);
  assert.throws(() => score(set, { kindCountsInTracker: {}, toolsSeenByCell: {} }), /no tool counts/);
});

test("the arguable labels are scored left out and given the scanner's label", () => {
  const set = [entry("a", "delete_file", ["destructive"]), { ...entry("b", "get_record", ["write"]), doubt: "arguable" }];
  const check = sensitivity(set);
  assert.equal(check.doubtful, 1);
  assert.equal(check.withoutDoubtful.size, 1);
  assert.equal(check.doubtfulAsScanner.right, 2);
});

test("the Wilson interval stays inside 0 to 1 and holds the share", () => {
  const [low, high] = wilson(180, 200);
  assert.ok(low > 0.85 && low < 0.9 && high > 0.9 && high < 0.94);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  assert.equal(wilson(10, 10)[1], 1);
});

test("an entry without an expected label or reason is refused", () => {
  assert.throws(() => readSet(JSON.stringify({ ...entry("a", "x", []) })), /expected/);
  assert.throws(() => readSet(JSON.stringify({ ...entry("a", "x", ["read"]), reason: "" })), /reason/);
  assert.throws(() => readSet(JSON.stringify({ ...entry("a", "x", ["maybe" as never]) })), /expected/);
});

test("the committed set is complete: every tool labelled, with a reason, from a known cell", () => {
  const set = readSet(readFileSync(new URL("../eval/labels-2026-11.jsonl", import.meta.url), "utf8"));
  assert.ok(set.length >= 190, `only ${set.length} tools`);
  assert.equal(new Set(set.map((item) => item.id)).size, set.length);
  for (const item of set) assert.ok((cells as readonly string[]).includes(item.sampledAs), item.id);
  for (const label of ["read", "write", "destructive", "money", "send"] as const) assert.ok(set.some((item) => item.expected.includes(label)), `no tool expected to be ${label}`);
  assert.equal(score(set).size, set.length);
});

test("the README states what the committed set measures today", () => {
  // When the rules change, these move: run node eval/score.ts and update the README's "What it does not do" with them.
  const set = readSet(readFileSync(new URL("../eval/labels-2026-11.jsonl", import.meta.url), "utf8"));
  const weights = JSON.parse(readFileSync(new URL("../eval/labels-2026-11.meta.json", import.meta.url), "utf8")) as Weights;
  const result = score(set, weights);
  const rounded = (value: number | null) => Math.round((value ?? 0) * 100);
  const precision = (label: string) => rounded(result.byLabel.find((item) => item.label === label)?.precision.value ?? null);
  assert.deepEqual(
    { overall: rounded(result.agreement.value), labelled: rounded(result.labelled.value), destructive: precision("destructive"), money: precision("money"), send: precision("send") },
    { overall: 71, labelled: 90, destructive: 34, money: 17, send: 46 },
  );
});
