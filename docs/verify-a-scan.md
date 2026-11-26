# How to verify a tracker scan

Each daily scan commits its files to this repository's `data` branch with two more files:

- `manifest.json` holds:
  - `tree`: a digest of every file in the folder;
  - `files`: the full sha256 and size of each file the scan wrote, as a record of what changed;
  - the method version ([METHOD.md](METHOD.md)), the scanner's commit, the workflow run's ID, and when the registry was read;
  - `previous`: whether the folder the scan started from was exactly the previous scan's, as signed.
- `manifest.sigstore.json`: a [Sigstore](https://www.sigstore.dev/) bundle signing `manifest.json`. It holds the signature, a short-lived certificate for the GitHub identity of the workflow that signed it, and the proof that the signature was logged in Sigstore's public transparency log (Rekor).

No key is stored anywhere. The workflow proves who it is to Sigstore with a GitHub OIDC token, and Sigstore issues a certificate for that identity that lasts ten minutes.

The signature is made by the workflow's `sign` job and committed by its `publish-signature` job, in a commit right after the scan's own. The scan's own commit has an unsigned manifest, and the commit after it has the signature.

## What a passing check shows

`verify-manifest` ends with `OK` only when all of these hold:

1. **Every file in the folder is exactly as that scan left it.** This covers files the scan wrote and files it did not touch. Changing, adding or removing any file, whichever scan wrote it, makes the folder's digest differ from `tree` in the manifest.
2. **The manifest was signed by this repository's `track.yml` workflow on `main`,** at the scanner commit the manifest names, and the signing was logged publicly at that time.
3. **That scan started from the previous scan's signed folder, unchanged.** Before it changes anything, each scan checks the folder it starts from against the previous signed manifest, and records the answer, signed, in `previous`.

   If someone changed a file between two scans, the next scan records `"verified": false` with a reason, and every check of that scan fails. Without this step, the next scan would hash the edited file and sign it as its own.

What it does **not** show:

- **That this is the latest scan.** An older scan, with its manifest and signature, stays validly signed. Someone could hand you one, or restore one on the branch. Check that the scan date and run ID printed are the ones you expect. The repository's Actions history lists every run. `verify-manifest` adds a note when a scan is two or more days old.
- **That no file was ever changed outside the tracker in the past.** Point 3 checks one step back. An edit made before an earlier scan is recorded in that scan's manifest (`previous.verified: false`), not in today's. To check the whole history, check each signed scan in turn (below).
- **That the code at that commit was reviewed.** The signature names a commit on `main`. Its value depends on what can reach `main`, and the commit is public, so anyone can read it.
- **That the scanner read each server correctly.** The method version says which rules were used, and [METHOD.md](METHOD.md) describes them.

The very first signed scan has no signed scan before it, so its own check fails on point 3 (`previous.reason: "no manifest"`). So does a scan that follows a day whose signing failed (`"not signed"`), or a scan that could not run cosign (`"not checked"`, which says nothing either way about the signature). The next scan after a clean signed one passes again.

Anything in the data folder that is not a plain file, a link for example, is never followed. A scan removes it before it writes anything, and records an unclean start (`"folder changed since that scan"`).

## With the scanner (recommended)

You need Node 22.18 or later and [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) v3 or later (the workflow signs with v3.1.4).

```sh
git clone https://github.com/Stackduke/mcp-scanner.git
cd mcp-scanner
git clone --branch data --single-branch https://github.com/Stackduke/mcp-scanner.git tracker-data
npm run scan -- verify-manifest --data=tracker-data
```

It prints the run, the scanner commit and the method version. It then checks the whole folder, and each file the scan wrote, against the manifest, and has cosign check the signature. It exits 0 only if every check passes.

- `--hashes-only` skips the signature, and the output then says the signature was not checked.
- `--repo=owner/name` checks a fork's own workflow instead.
- `--this-scan-only` leaves out point 3. The workflow uses it before it publishes a signature, so that a scan which recorded an unclean start still gets signed.

To check every signed scan, from the newest back:

```sh
for commit in $(git -C tracker-data log --format=%H --diff-filter=A -- manifest.sigstore.json); do
  git -C tracker-data checkout -q "$commit"
  npm run --silent scan -- verify-manifest --data=tracker-data > /dev/null || echo "Not verified: $commit"
done
git -C tracker-data checkout -q data
```

This walk can only see the history the branch shows. A force push could remove the scan that recorded an edit, and the walk would not notice that it is missing. The walk is only as reliable as a ruleset on `data` that blocks force pushes and deletion. Each manifest's `previous.run` and `previous.manifestSha256` name the scan before it, so a gap can also be found by comparing them, though the walk above does not do that.

## By hand, with cosign and sha256sum only

```sh
cd tracker-data
COMMIT=$(jq -r .scanner.commit manifest.json)
cosign verify-blob manifest.json \
  --bundle manifest.sigstore.json \
  --certificate-identity "https://github.com/Stackduke/mcp-scanner/.github/workflows/track.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  --certificate-github-workflow-sha "$COMMIT"
# The folder's digest: sha256sum of every file but the manifest, its signature and .git/, sorted by path bytes.
find . -path ./.git -prune -o -type f -print | sed 's|^\./||' | grep -vxE 'manifest\.json|manifest\.sigstore\.json' \
  | LC_ALL=C sort | xargs -d '\n' sha256sum | sha256sum | cut -d' ' -f1
jq -r .tree.sha256 manifest.json   # must print the same digest
jq .previous manifest.json         # "verified" must be true
```

`cosign verify-blob` must print `Verified OK`. The two digests must be the same. `previous.verified` must be `true`.

## Line endings on Windows

The data branch's `.gitattributes` (`* text eol=lf`) keeps every file's LF line endings as committed, on every system. That matters because hashes are of the exact bytes. The scan writes that file itself, so a checkout of any scan from 26 November 2026 on has it. For older commits, or if your git ignores it, clone with `git -c core.autocrlf=false clone ...`.
