import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** The daily workflow, read as text: the workflow's own header, and each job's block by name. */
const text = readFileSync(new URL("../.github/workflows/track.yml", import.meta.url), "utf8");
const [header = "", body = ""] = text.split("\njobs:\n");
const jobBlocks = body.split(/\n(?=  [\w-]+:\n)/);
const jobs = new Map(jobBlocks.map((block) => [/^ {2}([\w-]+):/.exec(block)?.[1] as string, block]));
const job = (name: string) => jobs.get(name) ?? assert.fail(`no job ${name}`);

/** A job's own permissions, as "name: level" lines without comments, or null when it sets none. */
function permissionsOf(block: string): string[] | null {
  const match = /\n {4}permissions:\n((?: {6}.*\n| *#.*\n)+)/.exec(block);
  return match ? (match[1] as string).split("\n").map((line) => line.replace(/#.*/, "").trim()).filter(Boolean).sort() : null;
}

test("only the sign job may ask for an identity token, and it cannot push; the job that pushes the signature holds no token", () => {
  assert.deepEqual([...jobs.keys()], ["track", "sign", "publish-signature"]);
  for (const [name, block] of jobs) if (name !== "sign") assert.ok(!block.includes("id-token"), name);
  assert.ok(!header.includes("id-token"), "not at the workflow's level either");
  assert.deepEqual(permissionsOf(job("sign")), ["contents: read", "id-token: write"]);
  assert.deepEqual(permissionsOf(job("publish-signature")), ["contents: write"]);
  // The scan job keeps the workflow's permissions, which have no id-token, and gets none of its own.
  assert.equal(permissionsOf(job("track")), null);
  assert.ok(!/secrets\./.test(job("sign")) && !/secrets\./.test(job("publish-signature")), "the signing jobs hold no secrets");
  assert.match(job("sign"), /upload-artifact@/);
  assert.match(job("publish-signature"), /download-artifact@/);
});

test("only a run on main pushes scan data, so the data branch never holds data the signature cannot name", () => {
  const commit = /- name: Commit what changed\n(?: {8}.*\n)+/.exec(job("track"))?.[0] ?? assert.fail("no commit step");
  assert.match(commit, /if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/main' && /);
  // Nor does a run from another branch send the private notice, or make the key for, or push, the private data.
  for (const name of ["Private notice", "Key for saving the private data", "Commit the private data"]) {
    const step = new RegExp(`- name: ${name}\\n(?: {8}.*\\n)+`).exec(job("track"))?.[0] ?? assert.fail(`no step ${name}`);
    assert.match(step, /\n {8}if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/main' && /, name);
  }
  assert.match(job("sign"), /if: \$\{\{ !cancelled\(\) && needs\.track\.outputs\.data-commit != '' \}\}/);
});

test("the scan's commit is checked before it is signed, and every action is pinned to a full commit", () => {
  const sign = job("sign");
  assert.ok(sign.indexOf("check-before-signing") < sign.indexOf("cosign sign-blob"), "checked first");
  assert.match(sign, /fetch-depth: 2/);
  // The artifact is unpacked outside the data checkout, and only the signature file is copied in.
  const publish = job("publish-signature");
  assert.match(publish, /name: manifest-signature\n {10}path: \$\{\{ runner\.temp \}\}\/signature\n/);
  assert.doesNotMatch(publish, /path: tracker-data\n(?! {10}persist)/);
  assert.match(publish, /cp "\$RUNNER_TEMP\/signature\/manifest\.sigstore\.json" tracker-data\/manifest\.sigstore\.json/);
  // cosign is installed whenever the scan runs, so a failed sign-in step cannot make a good signature look bad.
  assert.match(job("track"), /- name: Install cosign to check the previous signature\n {8}if: \$\{\{ !cancelled\(\) \}\}\n/);
  // A scan that started from an unclean folder must still have its signature published, or signing never recovers.
  assert.match(job("publish-signature"), /verify-manifest --data=tracker-data --repo="\$REPOSITORY" --this-scan-only\n/);
  const uses = [...text.matchAll(/uses: (\S+)/g)].map((match) => match[1] as string);
  assert.ok(uses.length > 0);
  for (const action of uses) assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, action);
});
