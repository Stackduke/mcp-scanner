import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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
  assert.deepEqual([...jobs.keys()], ["track", "sign", "publish-signature", "upload"]);
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

/** Every workflow, read as text: its header, and each job's block by name with comment lines taken out. */
const workflowsFolder = new URL("../.github/workflows/", import.meta.url);
const workflows = new Map(readdirSync(workflowsFolder).filter((name) => name.endsWith(".yml")).map((name) => {
  const code = readFileSync(new URL(name, workflowsFolder), "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const [head = "", rest = ""] = code.split("\njobs:\n");
  const blocks = new Map(rest.split(/\n(?=  [\w-]+:\n)/).map((block) => [/^ {2}([\w-]+):/.exec(block)?.[1] as string, block]));
  return [name, { code, head, jobs: blocks }];
}));
const workflow = (name: string) => workflows.get(name) ?? assert.fail(`no workflow ${name}`);
const allJobs = [...workflows].flatMap(([file, { jobs: blocks }]) => [...blocks].map(([name, block]) => ({ where: `${file} ${name}`, block })));
/** The secrets a block names. */
const secretsOf = (block: string) => [...new Set([...block.matchAll(/secrets\.(\w+)/g)].map((match) => match[1] as string))].sort();
/** A step's block, by its name. */
const stepOf = (block: string, name: string) => new RegExp(`- name: ${name}\\n(?: {8}.*\\n?)+`).exec(block)?.[0] ?? assert.fail(`no step ${name}`);

test("the R2 key reaches only the upload and backfill jobs, the scratch bucket's key only the pre-flight job, each from its environment", () => {
  const holding = (pattern: RegExp) => allJobs.filter(({ block }) => pattern.test(block)).map(({ where }) => where).sort();
  const inEnvironment = (name: string) => allJobs.filter(({ block }) => new RegExp(`\\n {4}environment: ${name}\\n`).test(block)).map(({ where }) => where).sort();
  assert.deepEqual(holding(/secrets\.R2_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)\b/), ["radar-backfill.yml backfill", "track.yml upload"]);
  assert.deepEqual(inEnvironment("r2-upload"), ["radar-backfill.yml backfill", "track.yml upload"]);
  assert.deepEqual(holding(/secrets\.R2_PREFLIGHT_/), ["radar-preflight.yml preflight"]);
  assert.deepEqual(inEnvironment("r2-preflight"), ["radar-preflight.yml preflight"]);
  // No workflow hands a key to every job, or names an environment for all of them.
  for (const [file, { head }] of workflows) assert.doesNotMatch(head, /secrets\.|environment:/, file);
  for (const { where, block } of allJobs.filter(({ block }) => /environment: r2-/.test(block))) {
    // Those keys, and nothing else: no other secret, no write to the repository, no identity token, main only.
    assert.deepEqual(secretsOf(block), where.startsWith("radar-preflight") ? ["R2_PREFLIGHT_ACCESS_KEY_ID", "R2_PREFLIGHT_SECRET_ACCESS_KEY"] : ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"], where);
    assert.deepEqual(permissionsOf(block), ["contents: read"], where);
    assert.doesNotMatch(block, /id-token/, where);
    assert.match(block, /\n {4}if: \$\{\{ (!cancelled\(\) && )?github\.ref == 'refs\/heads\/main'( && |\s*\}\})/, where);
  }
});

test("the track job holds no R2 key and no identity token; the upload job runs on main after signing, and needs the signature", () => {
  assert.doesNotMatch(job("track"), /R2_|r2-|id-token/);
  const upload = workflow("track.yml").jobs.get("upload") ?? assert.fail("no upload job");
  // Off until RADAR_UPLOAD is "on", once the scratch-bucket check, the bucket lock and the backfill are done.
  assert.match(upload, /\n {4}needs: \[track, sign\]\n {4}if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/main' && needs\.sign\.result == 'success' && vars\.RADAR_UPLOAD == 'on' \}\}\n/);
  assert.match(upload, /\n {8}run: node src\/radar-cli\.ts publish --data="\$RUNNER_TEMP\/scan" --require-signature --bucket=radar\n/);
  // The artifacts are unpacked outside the checkout; nothing from them is run.
  assert.match(upload, /name: scan\n {10}path: \$\{\{ runner\.temp \}\}\/scan\n/);
  assert.match(upload, /name: manifest-signature\n {10}path: \$\{\{ runner\.temp \}\}\/signature\n/);
  // Dual-write: nothing waits on the upload, so a failed upload leaves the data branch's commit and signature as they are.
  for (const [name, block] of workflow("track.yml").jobs) assert.doesNotMatch(block, /needs: .*upload/, name);
  assert.match(job("publish-signature"), /\n {4}needs: \[track, sign\]\n/);
  // The scan is handed on only when it was committed, without git's folder, and a failure there fails the upload, not the scan.
  const handOff = stepOf(job("track"), "Hand the scan to the upload job");
  assert.match(handOff, /if: \$\{\{ !cancelled\(\) && steps\.commit\.outputs\.commit != '' \}\}\n {8}continue-on-error: true\n/);
  assert.match(handOff, /path: \|\n {12}tracker-data\/\n {12}!tracker-data\/\.git\/\*\*\n/);
  assert.match(handOff, /include-hidden-files: true/);
  // --unsigned is for a scratch bucket by hand; no workflow uses it.
  for (const [file, { code }] of workflows) assert.doesNotMatch(code, /--unsigned/, file);
});

test("the backfill takes only a full commit SHA on the data branch, and never runs alongside a scan", () => {
  const { head, jobs: blocks } = workflow("radar-backfill.yml");
  assert.match(head, /\non:\n {2}workflow_dispatch:\n/);
  assert.doesNotMatch(head, /schedule:|push:|pull_request/);
  assert.match(head, /\nconcurrency:\n {2}group: track\n {2}cancel-in-progress: false\n/);
  const backfill = blocks.get("backfill") ?? assert.fail("no backfill job");
  // The format is checked first, before anything is checked out.
  const steps = [...backfill.matchAll(/\n {6}- (?:name: (.+)|uses: (\S+))/g)].map((match) => match[1] ?? match[2]);
  assert.equal(steps[0], "Take only a full commit SHA");
  assert.ok(steps.indexOf("Take the commit only if it is on the data branch") < steps.indexOf("Publish the data branch's history to R2"));
  assert.match(stepOf(backfill, "Take the commit only if it is on the data branch"), /run: git merge-base --is-ancestor "\$SHA" origin\/data\n/);
  assert.match(stepOf(backfill, "Publish the data branch's history to R2"), /run: node src\/radar-cli\.ts backfill --repo=\. --ref="\$SHA" --bucket=radar\n/);
  // The input reaches scripts through the environment only, never pasted into one.
  assert.equal([...backfill.matchAll(/inputs\.sha/g)].length, [...backfill.matchAll(/\n {10}SHA: \$\{\{ inputs\.sha \}\}/g)].length);
  // The check itself, run as the workflow runs it.
  const script = /run: \|\n((?: {10}.*\n)+)/.exec(stepOf(backfill, "Take only a full commit SHA"))?.[1]?.replace(/^ {10}/gm, "") ?? assert.fail("no script");
  const accepts = (sha: string) => spawnSync("bash", ["-e", "-c", script], { env: { SHA: sha }, encoding: "utf8" }).status === 0;
  const sha = "4f21632a69097ba48f2ca23a2ee7cfa2731fd82d";
  assert.ok(accepts(sha));
  for (const bad of ["data", "origin/data", "refs/heads/data", "4f21632", sha.toUpperCase(), `${sha}0`, sha.slice(1), `${sha}\n`, `${sha} --all`, `$(echo ${sha})`, ""]) assert.ok(!accepts(bad), JSON.stringify(bad));
});

test("the pre-flight check uses the scratch bucket's own key and bucket, never radar", () => {
  const { code, head } = workflow("radar-preflight.yml");
  assert.match(head, /\non:\n {2}workflow_dispatch:\n/);
  assert.doesNotMatch(head, /schedule:|push:|pull_request/);
  const buckets = [...code.matchAll(/--bucket=(\S+)/g)].map((match) => match[1]);
  assert.ok(buckets.length >= 3);
  for (const bucket of buckets) assert.equal(bucket, "radar-preflight");
  assert.match(code, /preflight --bucket=radar-preflight \$\{LOCK:\+--expect-lock\}\n/);
});

test("every action in the R2 workflows is pinned to a full commit", () => {
  for (const file of ["track.yml", "radar-backfill.yml", "radar-preflight.yml"]) {
    const uses = [...workflow(file).code.matchAll(/uses: (\S+)/g)].map((match) => match[1] as string);
    assert.ok(uses.length > 0, file);
    for (const action of uses) assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${file}: ${action}`);
  }
});

