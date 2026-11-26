#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { backfillScans } from "./radar-backfill.ts";
import { planScan } from "./radar-layout.ts";
import type { ScanInput } from "./radar-layout.ts";
import type { RunCosign } from "./manifest.ts";
import { describePlan, folderStore, publish, s3Store, scanInputFromFolder } from "./radar-publish.ts";
import type { Store } from "./radar-publish.ts";

/**
 * Radar's storage commands. Kept apart from cli.ts until the Track workflow uses them (docs/decisions/0001-radar-storage-r2.md).
 * The R2 key is read from the environment, by the upload job only; the scan never holds it.
 */
const usage = `Usage:
  node src/radar-cli.ts publish --data=<scan folder> [--require-signature] <target>
      Publish one scan: the Track job's data folder, checked against its manifest.json (the whole folder's
      digest and each file's sha256). --require-signature also checks manifest.sigstore.json with cosign.
  node src/radar-cli.ts backfill --repo=<git folder> [--ref=origin/data] <target>
      Publish every scan in the data branch's history, oldest first. Reads the repository only.

  The target, exactly one of:
  --dry-run              Print what would be written. Reads no bucket, writes nothing.
  --to-folder=<dir>      Write the layout to a local folder, each key as a path.
  --bucket=<name>        Upload to that R2 bucket (radar), at https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com,
                         with R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY. --endpoint=<https origin> overrides the address.

  Every key but latest.json is written only if absent; one already there with other content stops the run.
  latest.json is written last, and only if no other run changed it since it was read (then it is read again).
  Nothing about a server tracked privately is ever published.`;

export interface RadarDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  now?: () => Date;
  /** For tests: what runs cosign when a signature is required. */
  cosign?: RunCosign;
}

export async function radarMain(argv: string[], { env = process.env, fetchImpl = fetch, log = console.log, now = () => new Date(), cosign }: RadarDeps = {}): Promise<number> {
  const [command, ...flags] = argv;
  const given = new Map<string, string>();
  for (const flag of flags) {
    const match = /^--(data|repo|ref|to-folder|bucket|endpoint)=(.+)$|^--(dry-run|require-signature)$/.exec(flag);
    const name = match?.[1] ?? match?.[3];
    if (!name || given.has(name)) { log(usage); return 2; }
    given.set(name, match?.[2] ?? "");
  }
  const targets = ["dry-run", "to-folder", "bucket"].filter((name) => given.has(name));
  const allowed = command === "publish" ? ["data", "require-signature"] : command === "backfill" ? ["repo", "ref"] : null;
  const needed = command === "publish" ? "data" : "repo";
  if (!allowed || targets.length !== 1 || !given.has(needed) || (given.has("endpoint") && !given.has("bucket"))
    || [...given.keys()].some((name) => !allowed.includes(name) && !["dry-run", "to-folder", "bucket", "endpoint"].includes(name))) { log(usage); return 2; }

  let store: Store | null = null;
  if (given.has("to-folder")) store = folderStore(given.get("to-folder") as string);
  if (given.has("bucket")) {
    const account = env.R2_ACCOUNT_ID ?? "";
    const endpoint = given.get("endpoint") ?? (/^[0-9a-f]{32}$/.test(account) ? `https://${account}.r2.cloudflarestorage.com` : "");
    if (!endpoint) { log("Set R2_ACCOUNT_ID (the Cloudflare account id, 32 hex characters) or pass --endpoint."); return 2; }
    const accessKeyId = env.R2_ACCESS_KEY_ID ?? "", secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? "";
    if (!accessKeyId || !secretAccessKey) { log("Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to upload."); return 2; }
    store = s3Store({ endpoint, bucket: given.get("bucket") as string, credentials: { accessKeyId, secretAccessKey }, fetchImpl, now });
  }

  const run = async (input: ScanInput, note = "") => {
    const plan = planScan(input);
    if (!store) { log(describePlan(plan) + (note ? `\n  ${note}.` : "")); return; }
    const report = await publish(plan, store, { now });
    log(`Scan ${plan.id}: ${report.written} objects written, ${report.present} already there${note ? `; ${note}` : ""}. latest.json points at ${report.pointer.scan} (${report.pointer.scans.length} scans).`);
  };
  if (command === "publish") {
    // The signature must be by this repository's Track workflow: in a workflow run, the repository it runs in.
    const repository = /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "") ? env.GITHUB_REPOSITORY : undefined;
    const input = await scanInputFromFolder(given.get("data") as string, { requireSignature: given.has("require-signature"), ...(repository ? { repository } : {}), ...(cosign ? { cosign } : {}) });
    // The pointer never moves back, so a scan dated in the future would hold it for good. A scan's folder is
    // kept for a week as an artifact; anything outside that is refused.
    const startedAt = input.source.kind === "track" ? Date.parse(input.source.scanStartedAt) : NaN;
    if (!(startedAt <= now().getTime() + 10 * 60_000 && startedAt >= now().getTime() - 8 * 86_400_000)) {
      log("The scan's start time is in the future or more than 8 days ago, so it was not published.");
      return 1;
    }
    await run(input);
  } else {
    let scans = 0;
    for await (const { input, leftOut } of backfillScans(given.get("repo") as string, given.get("ref") ?? "origin/data")) {
      // Counted, never named: a server tracked privately is not named in a log.
      await run(input, leftOut ? `${leftOut} records about servers tracked privately left out` : "");
      scans += 1;
    }
    log(`${scans} scans ${store ? "published" : "planned"}.`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  radarMain(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { console.error(error instanceof Error ? error.message : "The command failed."); process.exitCode = 1; },
  );
}
