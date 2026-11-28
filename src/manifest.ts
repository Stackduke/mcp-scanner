import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { writeWhole } from "./files.ts";
import { methodVersion } from "./method.ts";

/**
 * A scan's manifest: a digest of the whole data folder as the scan left it, the full sha256 of each file
 * the scan wrote, and what produced them (the scanner's commit, the method version, the workflow run, when
 * the registry was read).
 *
 * The daily workflow signs it with Sigstore keyless signing: a short-lived certificate for the workflow's
 * GitHub identity, logged in Sigstore's public transparency log. The signature sits next to it, so anyone
 * can check that the folder is the one that run left, and that the run was this repository's workflow.
 * The scanner itself holds no key. docs/verify-a-scan.md says how to check one.
 *
 * The digest covers every file, so a file changed, added or removed after the scan fails the check,
 * whichever scan wrote it. And before it changes anything, the scan checks the folder it starts from against
 * the previous scan's signed manifest, and records the result in `previous`: a file changed between two
 * scans would otherwise become part of what the next scan signs. It is one hash, not a list, because the paths of files a scan removes can name
 * a vendor tracked privately. `files` lists only what this scan wrote, as a readable record of what changed.
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
  /**
   * Whether the folder this scan started from was exactly a signed scan's, checked before the scan changed
   * anything. `reason` says why not, in fixed words (never a path: a path can name a vendor tracked privately).
   */
  previous: { verified: boolean; reason?: PreviousReason; run?: string; scanStartedAt?: string; manifestSha256?: string };
  /** The whole data folder as the scan left it: see `folderDigest`. */
  tree: { files: number; sha256: string };
  /** Every file written by the scan, relative to the data folder with "/" between folders, sorted. */
  files: ManifestFile[];
}

/** "not checked": cosign could not be run, so nothing is said about the signature either way. */
export type PreviousReason = "no manifest" | "not signed" | "not checked" | "signature did not verify" | "folder changed since that scan" | "manifest unreadable";
const previousReasons: readonly string[] = ["no manifest", "not signed", "not checked", "signature did not verify", "folder changed since that scan", "manifest unreadable"];

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** A path in a manifest names a file inside the data folder: relative, with no "..", no "\" and no empty parts. */
export const insideFolder = (relative: string) =>
  relative !== "" && !relative.startsWith("/") && !relative.includes("\\") && relative.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** Paths sorted by their bytes, as `LC_ALL=C sort` sorts them. */
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Left out of the digest: the manifest and its signature, which cannot cover themselves, and git's own folder. */
const outsideDigest = new Set([manifestName, signatureName, ".git"]);

/**
 * A digest of every file in the data folder: the sha256 of the lines `<sha256 of the file>  <path>`, one per
 * file, sorted by path bytes, each ending in a newline. Those lines are exactly what `sha256sum` prints, so
 * `find . -type f | sed 's|^\./||' | LC_ALL=C sort | xargs sha256sum | sha256sum` gives the same digest (left
 * out: the manifest, its signature and .git/ at the top). Bytes are hashed as stored; the folder's
 * .gitattributes keeps every checkout's line endings as committed. Anything that is not a plain file or a
 * folder (a link, say) is returned in `others`, so a check can refuse it.
 */
export async function folderDigest(dataDir: string): Promise<{ files: number; sha256: string; others: string[] }> {
  const files: string[] = [], others: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(dataDir, relative), { withFileTypes: true })) {
      if (!relative && outsideDigest.has(entry.name)) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
      else others.push(child);
    }
  };
  await walk("");
  const lines: string[] = [];
  for (const relative of files.sort(byBytes)) lines.push(`${sha256(await readFile(path.join(dataDir, relative)))}  ${relative}\n`);
  return { files: files.length, sha256: sha256(lines.join("")), others: others.sort(byBytes) };
}

export interface ManifestInput {
  dataDir: string;
  /** Paths relative to the data folder, with "/" between folders. */
  written: Iterable<string>;
  scanStartedAt: string;
  generatedAt: string;
  registry: Manifest["registry"];
  previous: Manifest["previous"];
  environment: Record<string, string | undefined>;
}

/** The manifest for files already written, read back from disk so the hash is of what is there. */
export async function buildManifest({ dataDir, written, scanStartedAt, generatedAt, registry, previous, environment }: ManifestInput): Promise<Manifest> {
  const paths = [...new Set(written)].filter((relative) => relative !== manifestName && relative !== signatureName).sort();
  const files: ManifestFile[] = [];
  for (const relative of paths) {
    if (!insideFolder(relative)) throw new Error(`A manifest path must stay inside the data folder: ${relative}`);
    const bytes = await readFile(path.join(dataDir, relative));
    files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length });
  }
  // Anything that is not a plain file is left out of the digest; verify reports it, so such a folder is never signed.
  const tree = await folderDigest(dataDir);
  const { GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_REPOSITORY } = environment;
  return {
    version: 1,
    methodVersion,
    scanStartedAt,
    generatedAt,
    scanner: { commit: GITHUB_SHA || "unknown" },
    ...(GITHUB_RUN_ID ? { run: { id: GITHUB_RUN_ID, attempt: GITHUB_RUN_ATTEMPT || "1", repository: GITHUB_REPOSITORY || "" } } : {}),
    registry: { readAt: registry.readAt, attemptedAt: registry.attemptedAt, attemptOk: registry.attemptOk },
    previous,
    tree: { files: tree.files, sha256: tree.sha256 },
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
  const previous = manifest.previous as Record<string, unknown> | undefined;
  if (typeof previous?.verified !== "boolean" || (previous.reason !== undefined && !previousReasons.includes(previous.reason as string))) return "it does not say whether the folder it started from was checked";
  const tree = manifest.tree as Record<string, unknown> | undefined;
  if (!Number.isSafeInteger(tree?.files) || typeof tree?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(tree.sha256)) return "it has no digest of the whole folder";
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
  /** For tests: the time now, to say how old the scan is. */
  now?: Date;
  /**
   * Check this scan's folder and signature only, not whether it started from a signed scan. The workflow
   * publishes a signature this way: a scan that recorded an unclean start must still be signed, or the scans
   * after it could never start from a signed one again.
   */
  thisScanOnly?: boolean;
}

export interface Verification {
  ok: boolean;
  manifest?: Manifest;
  repository?: string;
  /** Said but not counted as a problem: an old scan may be a replay of an earlier, still validly signed one. */
  notes?: string[];
  /** Files whose hash matched. */
  matched: number;
  problems: string[];
  /**
   * The manifest's own record that its scan did not start from a signed folder. Kept apart from `problems`:
   * the folder can still be exactly that scan's, which is what the next scan's check asks.
   */
  inherited?: string[];
  /** What happened to the signature: verified, not checked, or why it failed. */
  signature: "verified" | "not checked" | "missing" | "failed";
}

/**
 * Checks a data folder against its manifest: the whole folder must match its digest, every file listed must
 * be there with the same sha256, and (unless only the hashes are asked for) the signature must be valid for
 * the Track workflow of the repository, at the scanner commit the manifest names.
 */
export async function verifyManifest(dataDir: string, { repository = "Stackduke/mcp-scanner", hashesOnly = false, cosign = runCosign, now = new Date(), thisScanOnly = false }: VerifyOptions = {}): Promise<Verification> {
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
  const tree = await folderDigest(dataDir);
  for (const other of tree.others) problems.push(`${other}: not a plain file`);
  if (tree.sha256 !== manifest.tree.sha256) {
    problems.push(`The folder does not match the manifest's digest of it (${tree.files} files here, ${manifest.tree.files} when the scan ended): a file was changed, added or removed since.`);
  }
  const inherited: string[] = [];
  if (!manifest.previous.verified) {
    inherited.push(`The scan started from a folder that was not exactly a signed scan's (${manifest.previous.reason ?? "no reason given"}). The files it did not write are as it found them, but are not shown to come from the tracker. The next scan's check says whether this one is clean.`);
  }
  const days = Math.floor((now.getTime() - Date.parse(manifest.scanStartedAt)) / 86_400_000);
  const notes = days >= 2 ? [`This scan is ${days} days old. An older scan stays validly signed, so check that its date and run ID are the scan you expect (the repository's Actions history lists every run).`] : [];

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
      // cosign missing says nothing about the signature: it was not checked, not found bad.
      signature = result.code === 0 ? "verified" : result.code === 127 ? "not checked" : "failed";
      if (result.code === 127) problems.push("cosign was not found. Install it (https://docs.sigstore.dev/cosign/system_config/installation/) or pass --hashes-only.");
      else if (result.code !== 0) problems.push(`The signature did not verify: ${result.output.split("\n").slice(-3).join(" ")}`);
    }
  }
  return { ok: problems.length === 0 && (thisScanOnly || inherited.length === 0), manifest, repository, notes, matched, problems, inherited, signature };
}

/**
 * The check a scan makes of the folder it starts from, before it changes anything: was it exactly the
 * previous scan's, as signed? The answer goes into the new manifest, so it is signed too.
 */
export async function checkPrevious(dataDir: string, options: VerifyOptions = {}): Promise<Manifest["previous"]> {
  let bytes: Buffer;
  try { bytes = await readFile(path.join(dataDir, manifestName)); } catch { return { verified: false, reason: "no manifest" }; }
  const result = await verifyManifest(dataDir, options);
  if (!result.manifest) return { verified: false, reason: "manifest unreadable", manifestSha256: sha256(bytes) };
  const about = { ...(result.manifest.run ? { run: result.manifest.run.id } : {}), scanStartedAt: result.manifest.scanStartedAt, manifestSha256: sha256(bytes) };
  if (result.problems.length === 0) return { verified: true, ...about };
  const folderChanged = result.matched < result.manifest.files.length || result.problems.some((problem) => problem.startsWith("The folder does not match") || problem.endsWith(": not a plain file"));
  const reason: PreviousReason = result.signature === "missing" ? "not signed"
    : folderChanged ? "folder changed since that scan"
    : result.signature === "not checked" ? "not checked"
    : "signature did not verify";
  return { verified: false, reason, ...about };
}

/** One line of `git diff --name-status`: what happened to a path between the scan's commit and the one before. */
export interface PathChange { status: string; path: string }

/** `git diff --name-status --no-renames -z` output, read. */
export const readNameStatus = (output: string): PathChange[] => {
  const parts = output.split("\0").filter(Boolean);
  return Array.from({ length: Math.floor(parts.length / 2) }, (_, index) => ({ status: parts[2 * index] as string, path: parts[2 * index + 1] as string }));
};

/**
 * What a scan's commit changed that the scan did not account for. It may add or change only the files its
 * manifest lists and the manifest itself, and remove only the previous signature and files under lists/ and
 * watched/ (servers that moved to private tracking). Anything else came from somewhere other than the scan.
 */
export function unaccountedChanges(manifest: Manifest, changes: PathChange[]): string[] {
  const listed = new Set([...manifest.files.map((file) => file.path), manifestName]);
  return changes.flatMap(({ status, path: changed }) => {
    if ((status === "A" || status === "M") && listed.has(changed)) return [];
    if (status === "D" && (changed === signatureName || changed.startsWith("lists/") || changed.startsWith("watched/"))) return [];
    return [`${status} ${changed}`];
  });
}

const gitDiff = (dataDir: string) => new Promise<string>((resolve, reject) => {
  execFile("git", ["-C", dataDir, "diff", "--name-status", "--no-renames", "-z", "HEAD~1", "HEAD"], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/**
 * The checks the workflow makes before it signs a scan's commit: the manifest was written by this run, the
 * folder matches it, and the commit changed nothing the scan does not account for.
 */
export async function checkBeforeSigning(dataDir: string, runId: string, diff: (dataDir: string) => Promise<string> = gitDiff): Promise<string[]> {
  const result = await verifyManifest(dataDir, { hashesOnly: true });
  if (!result.manifest) return result.problems;
  const problems = [...result.problems];
  if (result.manifest.run?.id !== runId) problems.push(`The manifest is from run ${result.manifest.run?.id ?? "(none)"}, not this run (${runId}).`);
  for (const change of unaccountedChanges(result.manifest, readNameStatus(await diff(dataDir)))) problems.push(`The commit has a change the manifest does not account for: ${change}`);
  return problems;
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
  lines.push(...[...result.problems, ...(result.inherited ?? [])].map((problem) => `- ${problem}`));
  lines.push(...(result.notes ?? []).map((note) => `Note: ${note}`));
  lines.push(result.signature === "verified"
    ? "Signature: verified, made by the repository's Track workflow on main, and logged in Sigstore's transparency log."
    : `Signature: ${result.signature}.`);
  if (!result.ok || !manifest) lines.push("NOT VERIFIED.");
  else if (result.signature === "verified") {
    lines.push(`OK: all ${manifest.tree.files} files in this folder are exactly as run ${manifest.run?.id ?? "(none)"} of ${result.repository}'s Track workflow left them, at scanner commit ${manifest.scanner.commit}, in the scan started ${manifest.scanStartedAt}.`);
    // Only a verified start is claimed. With --this-scan-only an unclean start passes, and says so.
    lines.push(manifest.previous.verified
      ? `That scan started from the signed scan of run ${manifest.previous.run ?? "(none)"} (started ${manifest.previous.scanStartedAt ?? "(unknown)"}), unchanged.`
      : `Its start was not checked here (--this-scan-only). The scan recorded that the folder it started from was not exactly a signed scan's: ${manifest.previous.reason ?? "no reason given"}.`);
    lines.push("Not shown: that this is the latest scan, that the code at that commit was reviewed, or that the scanner read each server correctly.");
  } else lines.push(`Hashes OK: all ${manifest.tree.files} files match the manifest. The signature was not checked, so this does not show who wrote the manifest.`);
  return lines.join("\n");
}
