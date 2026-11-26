# How to verify a tracker scan

Each daily scan commits its files to this repository's `data` branch with two more files:

- `manifest.json`: the full sha256 and size of every file that scan wrote, the method version ([METHOD.md](METHOD.md)), the scanner's commit, the workflow run's ID, and when the registry was read.
- `manifest.sigstore.json`: a [Sigstore](https://www.sigstore.dev/) bundle signing `manifest.json`. It holds the signature, a short-lived certificate for the GitHub identity of the workflow that signed it, and the proof that the signature was logged in Sigstore's public transparency log (Rekor).

No key is stored anywhere. The workflow proves who it is to Sigstore with a GitHub OIDC token, and Sigstore issues a certificate for that identity that lasts ten minutes. A valid bundle shows three things. The manifest has not changed since it was signed. It was signed by the `track.yml` workflow of this repository on `main`, at the scanner commit the manifest names. And the signing was logged publicly at that time. Changing a data file breaks its hash in the manifest. Changing the manifest breaks the signature. Producing a new signature takes this repository's workflow, and it leaves a public log entry.

The signature is added by the workflow's `sign` job, in a commit right after the scan's own commit. The scan's own commit has an unsigned manifest, and the commit after it has the signature.

## With the scanner (recommended)

You need Node 22.18 or later and [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) v3 or later. The workflow signs with cosign v3, which writes the current Sigstore bundle format. cosign v2 can read that format only when given `--new-bundle-format`.

```sh
git clone https://github.com/Stackduke/mcp-scanner.git
cd mcp-scanner
git clone --branch data --single-branch https://github.com/Stackduke/mcp-scanner.git tracker-data
npm run scan -- verify-manifest --data=tracker-data
```

It prints the run, the scanner commit and the method version, then checks every file listed against its sha256, then has cosign check the signature. It exits 0 only if every check passes. `--hashes-only` skips the signature (it then says the signature was not checked). `--repo=owner/name` checks a fork's own workflow instead.

To check an earlier scan, check out the signing commit that came after it, in `tracker-data`, and run the same command:

```sh
git -C tracker-data log --oneline -- manifest.sigstore.json   # one commit per signed scan
git -C tracker-data checkout <commit>
```

## By hand, with cosign and sha256sum only

```sh
cd tracker-data
COMMIT=$(jq -r .scanner.commit manifest.json)
cosign verify-blob manifest.json \
  --bundle manifest.sigstore.json \
  --certificate-identity "https://github.com/Stackduke/mcp-scanner/.github/workflows/track.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  --certificate-github-workflow-sha "$COMMIT"
jq -r '.files[] | "\(.sha256)  \(.path)"' manifest.json | sha256sum --check
```

Both commands must pass. `cosign verify-blob` prints `Verified OK`, and `sha256sum` prints `OK` for every file.

## What it does and does not show

- A manifest lists only the files written in that scan. A file the scan left alone (for example, a server's tool list that did not change) is covered by the manifest of the scan that last wrote it. To check every file, check each scan's signing commit in turn.
- Files a scan removed are not listed. The branch's history shows each removal.
- The signature shows which workflow produced the files, and when. It does not show that what a server sent was read correctly. The method version says which rules were used, and [METHOD.md](METHOD.md) describes them.
- Scans from before manifests were added have none. Their history is the `data` branch's git history only.
