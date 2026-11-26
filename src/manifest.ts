import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeWhole } from "./files.ts";
import { methodVersion } from "./method.ts";

/**
 * A scan's manifest: the full sha256 of every file the scan wrote in the data folder, and what produced
 * them (the scanner's commit, the method version, the workflow run, when the registry was read).
 *
 * The daily workflow signs it with Sigstore keyless signing: a short-lived certificate for the workflow's
 * GitHub identity, logged in Sigstore's public transparency log. The signature sits next to it, so anyone
 * can check that the files are the ones that run wrote, and that the run was this repository's workflow.
 * The scanner itself holds no key. docs/verify-a-scan.md says how to check one.
 *
 * Only the files written in that scan are listed: a file the scan left alone was listed by the manifest
 * of the scan that last wrote it, in the data branch's history. Files a scan removes are not listed: the
 * only files the tracker removes are those of servers that moved to private tracking, and their paths
 * name the vendor. The data branch's history shows each removal.
 */
export const manifestName = "manifest.json";
/** The Sigstore bundle (certificate, signature and transparency-log proof) written by the workflow's sign job. */
export const signatureName = "manifest.sigstore.json";

export interface ManifestFile { path: string; sha256: string; bytes: number }

export interface Manifest {
  version: 1;
  methodVersion: string;
  /** When the scan started, and when the manifest was written at its end. */
  scanStartedAt: string;
  generatedAt: string;
  /** The scanner's commit, or "unknown" outside a workflow run. */
  scanner: { commit: string };
  /** The workflow run that made the scan; absent outside one. */
  run?: { id: string; attempt: string; repository: string };
  /** The last read of the registry that returned entries, and this scan's attempt. */
  registry: { readAt: string; attemptedAt: string; attemptOk: boolean };
  /** Every file written by the scan, relative to the data folder with "/" between folders, sorted. */
  files: ManifestFile[];
}

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** A path in a manifest names a file inside the data folder: relative, with no "..", no "\" and no empty parts. */
export const insideFolder = (relative: string) =>
  relative !== "" && !relative.startsWith("/") && !relative.includes("\\") && relative.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export interface ManifestInput {
  dataDir: string;
  /** Paths relative to the data folder, with "/" between folders. */
  written: Iterable<string>;
  scanStartedAt: string;
  generatedAt: string;
  registry: Manifest["registry"];
  environment: Record<string, string | undefined>;
}

/** The manifest for files already written, read back from disk so the hash is of what is there. */
export async function buildManifest({ dataDir, written, scanStartedAt, generatedAt, registry, environment }: ManifestInput): Promise<Manifest> {
  const paths = [...new Set(written)].filter((relative) => relative !== manifestName && relative !== signatureName).sort();
  const files: ManifestFile[] = [];
  for (const relative of paths) {
    if (!insideFolder(relative)) throw new Error(`A manifest path must stay inside the data folder: ${relative}`);
    const bytes = await readFile(path.join(dataDir, relative));
    files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length });
  }
  const { GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_REPOSITORY } = environment;
  return {
    version: 1,
    methodVersion,
    scanStartedAt,
    generatedAt,
    scanner: { commit: GITHUB_SHA || "unknown" },
    ...(GITHUB_RUN_ID ? { run: { id: GITHUB_RUN_ID, attempt: GITHUB_RUN_ATTEMPT || "1", repository: GITHUB_REPOSITORY || "" } } : {}),
    registry: { readAt: registry.readAt, attemptedAt: registry.attemptedAt, attemptOk: registry.attemptOk },
    files,
  };
}

/**
 * Writes the manifest, and removes the previous scan's signature: a signature belongs to one manifest,
 * and the sign job writes the new one. Until it does, the manifest is there unsigned, and says so when checked.
 */
export async function writeManifest(dataDir: string, manifest: Manifest): Promise<void> {
  await rm(path.join(dataDir, signatureName), { force: true });
  await writeWhole(path.join(dataDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** A manifest read back with nothing taken on trust, or the reason it is not one. */
export function readManifest(value: unknown): Manifest | string {
  if (typeof value !== "object" || value === null) return "it is not a JSON object";
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1) return "its version is not 1";
  if (typeof manifest.methodVersion !== "string") return "it has no method version";
  const scanner = manifest.scanner as Record<string, unknown> | undefined;
  if (typeof scanner?.commit !== "string") return "it names no scanner commit";
  if (!Array.isArray(manifest.files)) return "it has no list of files";
  const fileOk = (file: unknown) => {
    const { path: relative, sha256: hash, bytes } = (file ?? {}) as Record<string, unknown>;
    return typeof relative === "string" && insideFolder(relative) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) && Number.isSafeInteger(bytes);
  };
  if (!manifest.files.every(fileOk)) return "a file in it has a path outside the data folder, or no full sha256";
  return value as Manifest;
}

/** Runs cosign with these arguments; resolves with its exit code and output. */
export type RunCosign = (args: string[]) => Promise<{ code: number; output: string }>;

const runCosign: RunCosign = (args) => new Promise((resolve) => {
  // No shell: every argument reaches cosign as it is.
  execFile("cosign", args, { timeout: 120_000 }, (error, stdout, stderr) => {
    const output = `${stdout}${stderr}`.trim();
    if (!error) resolve({ code: 0, output });
    else if ((error as NodeJS.ErrnoException).code === "ENOENT") resolve({ code: 127, output: "cosign was not found" });
    else resolve({ code: typeof error.code === "number" ? error.code : 1, output });
  });
});

export const githubIssuer = "https://token.actions.githubusercontent.com";
/** The identity a scan is signed with: the Track workflow on the repository's main branch. */
export const signerIdentity = (repository: string) => `https://github.com/${repository}/.github/workflows/track.yml@refs/heads/main`;

export interface VerifyOptions {
  /** The repository whose Track workflow must have signed the manifest. Default Stackduke/mcp-scanner. */
  repository?: string;
  /** Check the hashes only, and say the signature was not checked. */
  hashesOnly?: boolean;
  /** For tests: what runs cosign. */
  cosign?: RunCosign;
}

export interface Verification {
  ok: boolean;
  manifest?: Manifest;
  /** Files whose hash matched. */
  matched: number;
  problems: string[];
  /** What happened to the signature: verified, not checked, or why it failed. */
  signature: "verified" | "not checked" | "missing" | "failed";
}

/**
 * Checks a data folder against its manifest: every file listed must be there with the same sha256, and
 * (unless only the hashes are asked for) the signature must be
 * valid for the Track workflow of the repository, at the scanner commit the manifest names.
 */
export async function verifyManifest(dataDir: string, { repository = "Stackduke/mcp-scanner", hashesOnly = false, cosign = runCosign }: VerifyOptions = {}): Promise<Verification> {
  const failed = (problem: string): Verification => ({ ok: false, matched: 0, problems: [problem], signature: "not checked" });
  let text: string;
  try { text = await readFile(path.join(dataDir, manifestName), "utf8"); } catch { return failed(`There is no ${manifestName} in ${dataDir}.`); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return failed(`${manifestName} is not valid JSON.`); }
  const manifest = readManifest(parsed);
  if (typeof manifest === "string") return failed(`${manifestName} cannot be used: ${manifest}.`);

  const problems: string[] = [];
  let matched = 0;
  for (const file of manifest.files) {
    let bytes: Buffer;
    try { bytes = await readFile(path.join(dataDir, file.path)); } catch { problems.push(`${file.path}: missing`); continue; }
    if (sha256(bytes) === file.sha256 && bytes.length === file.bytes) matched += 1;
    else problems.push(`${file.path}: does not match its sha256 in the manifest`);
  }

  let signature: Verification["signature"] = "not checked";
  if (!hashesOnly) {
    const bundle = path.join(dataDir, signatureName);
    if (!(await readFile(bundle).then(() => true, () => false))) {
      signature = "missing";
      problems.push(`There is no ${signatureName}: this manifest is not signed (yet). Check an earlier or later commit, or pass --hashes-only.`);
    } else {
      const args = ["verify-blob", "--bundle", bundle, "--certificate-identity", signerIdentity(repository), "--certificate-oidc-issuer", githubIssuer];
      // The certificate holds the commit the workflow ran at; it must be the scanner commit the manifest claims.
      if (/^[0-9a-f]{40}$/.test(manifest.scanner.commit)) args.push("--certificate-github-workflow-sha", manifest.scanner.commit);
      else problems.push(`The manifest names no scanner commit (${manifest.scanner.commit}), so the signature cannot be tied to one.`);
      const result = await cosign([...args, path.join(dataDir, manifestName)]);
      signature = result.code === 0 ? "verified" : "failed";
      if (result.code === 127) problems.push("cosign was not found. Install it (https://docs.sigstore.dev/cosign/system_config/installation/) or pass --hashes-only.");
      else if (result.code !== 0) problems.push(`The signature did not verify: ${result.output.split("\n").slice(-3).join(" ")}`);
    }
  }
  return { ok: problems.length === 0, manifest, matched, problems, signature };
}

/** The result in plain words, for the terminal. */
export function describeVerification(result: Verification): string {
  const lines: string[] = [];
  const { manifest } = result;
  if (manifest) {
    const run = manifest.run ? `run ${manifest.run.id} (attempt ${manifest.run.attempt}) of ${manifest.run.repository}` : "no workflow run";
    lines.push(`Scan started ${manifest.scanStartedAt}: ${run}, scanner commit ${manifest.scanner.commit}, method ${manifest.methodVersion}.`);
    lines.push(`${result.matched} of ${manifest.files.length} files written in that scan match their sha256.`);
  }
  lines.push(...result.problems.map((problem) => `- ${problem}`));
  lines.push(result.signature === "verified"
    ? "Signature: verified, made by the repository's Track workflow on main, and logged in Sigstore's transparency log."
    : `Signature: ${result.signature}.`);
  lines.push(!result.ok ? "NOT VERIFIED." : result.signature === "verified" ? "OK." : "Hashes OK. The signature was not checked, so this does not show who wrote the manifest.");
  return lines.join("\n");
}
