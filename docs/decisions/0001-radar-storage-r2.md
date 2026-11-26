# 0001: Radar's history and evidence move from git to Cloudflare R2

- Status: accepted. Phase 1 (this change: the layout, the uploader, the backfill) adds code only. Phase 2 wires it into the Track workflow.
- Date: 26 November 2026
- Deadline: phase 2 live by about **5 December 2026**. The fallback below must be ready to apply by about 8 December, in case it slips.

## The problem

The Track workflow commits each day's scan to this repository's `data` branch, and the site and anyone else read it from there. The branch's main file is `endpoints.jsonl`: every endpoint from the MCP registry, with its recent checks and changes, rewritten whole each day.

| Date | `endpoints.jsonl` | Endpoints |
| --- | --- | --- |
| 20 Oct 2026 | 15.6 MB | 29,876 |
| 30 Oct 2026 | 27.7 MB | 34,739 |
| 12 Nov 2026 | 44.7 MB | 42,344 |
| 19 Nov 2026 | 55.3 MB | 46,216 |
| 25 Nov 2026 | 64.2 MB | 50,179 |

It grows by about 1.3 to 1.5 MB a day. GitHub refuses a push with a file over 100 MB. At that rate alone the daily push would fail around 19 or 20 December; with the per-check facts the check-outcomes change adds to each record, it fails around **15 or 16 December 2026**, and the tracker stops recording. The rest of the branch is no small matter either:

- `lists/` holds 24,165 files (64.4 MB), each endpoint's latest tool list. About 1,100 to 1,600 of them change each day.
- After 55 commits in six weeks, the branch's history holds 2.57 GB of file versions (205 MB packed). Every daily version of the 64 MB file is kept forever.
- The site's build downloads the whole branch as one archive (about 19 MB compressed) to read three kinds of file.
- The next step adds evidence: the raw response behind each check, as downloadable JSON. That is far more data than the lists, and git is the wrong place for it.

## Options considered

**Split the files in git** (for example, `endpoints.jsonl` in 16 shards by id). Each file stays under 100 MB for a while, but the history keeps every daily copy of every shard, so the branch grows by roughly the same amount each day. Clones and the site's archive download keep growing, and evidence still has nowhere to go. Good as a stopgap (see the fallback), not as the answer.

**Git LFS.** It moves large files out of the packed history, but every daily version is still stored, storage and bandwidth beyond a small allowance are billed by GitHub, every public download counts against that bandwidth, and readers need LFS-aware tools or GitHub's media URLs. The files get no cache headers we control and no stable per-file URL that a browser can read across origins.

**GitHub Releases** (a daily release with the files attached). Downloads are free and public, but any maintainer can replace or delete an asset, asset downloads do not answer browsers' cross-origin requests, and it misuses releases for data.

**Amazon S3 or Google Cloud Storage.** Both work, but public downloads are billed as egress (around $0.09/GB), which makes an open dataset cost more the more it is used.

**Cloudflare R2 (chosen).** Downloads are free (no egress charge), the S3 API means any S3 tool can read or copy everything out, a create-only write (`If-None-Match: *`, evaluated atomically by R2) makes history impossible to overwrite by mistake, and a custom domain gives Cloudflare's cache, our own cache headers and CORS. Stackduke's domain and site are already on Cloudflare. The free tier covers today's use, and the cost at ten times today's size is a few dollars a month (below).

## The decision

History and evidence move to the R2 bucket `radar` (Stackduke's Cloudflare account, location ENAM, Standard storage), served publicly and read-only at `https://data.stackduke.com`. The layout is in [../data-layout.md](../data-layout.md). In short:

- `scans/<scan-id>/…`: each scan's files (the endpoints, every current tool list in one file, the feed, the servers table, the lookup, the registry state, the manifest and its signature) and a `scan.json` with the sha256 of each. Never changed once written.
- `lists/<endpoint-id>/<sha256>.json` and `evidence/<endpoint-id>/<sha256>.json`: one object per version, named by the hash of its content. Never changed.
- `latest.json`: the one object that changes, written after everything else, naming the newest scan and listing every scan.

Changes from the first proposal, and why:

- **One folder per scan, named by the scan's start time** (`scans/2026-11-25T142908Z/`), not one `checks/YYYY-MM-DD.jsonl.gz` per day. A second run on the same day (a manual re-run) would otherwise need to overwrite an immutable file. A run id was also considered, but scans taken from the data branch's history have none.
- **The manifest goes in the scan's folder** (`scans/<id>/manifest.json`) instead of `manifests/<run-id>.json`, so one prefix holds everything that one pointer names.
- **Each scan stores the full endpoint file and a bundle of every current list.** A reader (the site's build, or a researcher) gets the whole picture of any day in two downloads, with no replay of earlier days. The content-addressed `lists/` objects keep each version on its own, so one endpoint's history can be read without the bundles.

**What stays in git:** the scanner's code, the catalog, and the documentation. Nothing from a scan. The `data` branch is frozen at the switch (its history stays readable, it is never rewritten or deleted) and its README points to `data.stackduke.com`. The private data of servers tracked privately stays where it is, in the private repository; none of it goes to the bucket.

**What is public:** everything in the bucket, which is everything already public on the `data` branch today, except the records of servers now tracked privately (below). The bucket's S3 API is not public: only the upload job's key can write, and nobody needs a key to read.

**No new dependency.** The uploader uses Node's `fetch` and its own AWS Signature Version 4 signing (about 25 lines, tested against AWS's published examples and a local stand-in for the S3 API that checks every signature). The AWS CLI was considered: it cannot express "write only if absent, and otherwise compare hashes" without wrapping it in a script, which would be harder to test than the Node code.

## Privacy

The bucket is public, so nothing about a server tracked privately may reach it. This is enforced in code, not only here:

- Planning a scan refuses the whole scan if any endpoint record, feed entry, `servers.json` row, tool list or `watched/` file belongs to a server tracked privately. It reads only fields the scanner writes itself (`signedIn`, and ids of the form `signed-in-<vendor>`), so no server can block uploads by giving a tool a vendor's name. The refusal names no server, because workflow logs are public. Tests cover each case, against the catalog's real settings.
- Before 24 October 2026 the `data` branch also held servers now tracked privately (12 commits, from 18 to 23 October). The backfill removes their records, lists and `watched/` files before planning, and planning checks again. The totals in those days' `feed.json` (servers and tools counted) still include them, as numbers.

## Security of the upload

The R2 key is a credential that can write to a public bucket, so only one small job ever holds it.

- **Three jobs.** The `track` job reads what third-party servers send. It gets no R2 key and no OIDC token. It hands its output to the next jobs as a workflow artifact. The `sign` job (from the signed-manifests change) signs the manifest with Sigstore keyless signing. The `upload` job holds the R2 key, and nothing else of value.
- **The upload job checks before it uploads.** It runs the scanner's code checked out from the workflow's own commit, never code from the artifact. It verifies the manifest's signature with cosign (`verify-manifest`), and the uploader then checks every file the manifest lists against its sha256 and refuses any file the layout has no place for. It also refuses a scan whose start time is in the future or more than 8 days ago, since the pointer never moves back and a scan dated ahead would hold it. A compromised `track` job could at worst publish a wrong new scan under new keys: it cannot rewrite history, because no existing key is ever overwritten.
- **A GitHub Environment holds the key.** Environment `r2-upload`, with deployment branches limited to `main`: only a job that names the environment and runs from `main` gets the secrets, so a workflow dispatched from another branch cannot use them. Repository-level secrets would reach every job.
- **The token can do one thing.** An R2 API token with Object Read & Write on the bucket `radar` only. It cannot list or create buckets, change settings, or touch anything else in the account.

## Cost

R2 charges $0.015 per GB-month of storage above 10 GB-month, $4.50 per million Class A operations (writes) above 1 million a month, and $0.36 per million Class B operations (reads, HEAD) above 10 million a month. Downloads (egress) are free. Measured from the real data with the backfill's dry run:

| | Today | 10 times today |
| --- | --- | --- |
| One scan, stored | 50.8 MB (endpoints 12.3 MB gzip, lists bundle 17.5 MB gzip, servers 8.7 MB, lookup 2.6 MB, feed 0.6 MB, 1,561 new list versions 8.9 MB) | about 510 MB |
| Growth per month (one scan a day) | about 1.55 GB | about 15.5 GB |
| Backfill of the data branch (53 scans) | 1.75 GB, 73,509 objects, once | n/a |
| Writes per month (one per object, plus the pointer) | about 47,000 | about 470,000 |
| Reads per month by the uploader (a HEAD per object) | about 47,000 | about 470,000 |
| Storage billed after 12 months | about 10 GB → **$0.16 a month** (about $0.60 for the first year in all) | about 178 GB → **$2.67 a month** (about $17 for the first year) |
| Operations billed | none: well inside the free tier | none: still inside the free tier |

Reads by the public go through Cloudflare's cache, so most never reach R2. Even uncached, ten million reads a month are free, and each million after that costs $0.36.

If storage ever matters, an R2 lifecycle rule could delete the per-scan bundles (`lists.jsonl.gz`, `servers.json`, `lookup.json`) after a year while keeping each scan's `endpoints.jsonl.gz` and every list version: that is most of the growth. It is not set up: history is the point of the data.

## Rollback

- **Phase 1** changes nothing that runs: the new commands are not called by any workflow. Reverting this change removes them.
- **Phase 2, the workflow.** Revert the workflow change and the tracker commits to the `data` branch again. The branch resumes from its frozen state; the scans made in between stay in R2 and can be restored into it (phase 2 adds a `restore` command that rebuilds a data folder from a scan). The 100 MB limit then applies again, so the fallback below would be needed too.
- **Phase 2, the site.** Keep the site's archive reader behind a switch for the first week, so the site can go back to the `data` branch by changing one setting.
- **A bad scan was published.** Its objects stay (they cannot be overwritten), but readers follow `latest.json`. Put back a pointer naming the previous scan with an account admin's credentials, for example with `npx wrangler r2 object put radar/latest.json --file=latest.json --content-type=application/json --cache-control="public, max-age=60" --remote`, then purge `https://data.stackduke.com/latest.json` from Cloudflare's cache. Deleting the bad objects is a separate, manual decision.

## Fallback if phase 2 slips past 5 December

Have this ready to apply by about 8 December, so it can ship before the push fails around 15 December. Shard `endpoints.jsonl` in the `data` branch by the first hex digit of the endpoint id (16 files of about 4 MB each), and teach the tracker and the site's build to read the shards. Sharding by month was considered, but `endpoints.jsonl` is today's state, rewritten whole each day, not a log: a month's file would still hold every endpoint. Shards keep the push working for many months, but do not stop the history from growing, so they are a stopgap only.

## Phase 2: the workflow change (not applied)

Phase 2 waits for the signed-manifests and check-outcomes changes to merge, since they change the same workflow and Track code. It adds a `restore` command (the `track` job rebuilds its data folder from the latest scan, read from `https://data.stackduke.com` with no key), removes the commits to the `data` branch, and adds the jobs below. Action versions are pinned by commit, as in the rest of the workflow.

```yaml
jobs:
  track:
    # As today, except: the data folder is restored from the latest scan instead of checked out from the
    # data branch, nothing is committed to the data branch, and the output is handed on as an artifact.
    # This job holds no R2 key and cannot ask for an OIDC token.
    steps:
      # ...
      - name: Restore the latest scan
        run: node src/radar-cli.ts restore --from=https://data.stackduke.com --to=tracker-data
      # ... renew, check sign-ins, scan, private notice and private commit, as today ...
      - name: Hand the scan on
        uses: actions/upload-artifact@<pinned sha> # v4
        with:
          name: scan
          path: tracker-data/
          retention-days: 7

  sign:
    needs: track
    permissions:
      contents: read
      id-token: write
    steps:
      # As in the signed-manifests change, but the data comes from the artifact and the signature
      # goes on as an artifact instead of a commit.
      - uses: actions/download-artifact@<pinned sha> # v4
        with: { name: scan, path: tracker-data }
      # ... verify-manifest --hashes-only, cosign sign-blob, verify-manifest ...
      - uses: actions/upload-artifact@<pinned sha> # v4
        with: { name: signature, path: tracker-data/manifest.sigstore.json }

  upload:
    needs: [track, sign]
    runs-on: ubuntu-latest
    timeout-minutes: 30
    # Only this job gets the R2 key, and only from main: the environment's deployment branches are limited to main.
    environment: r2-upload
    permissions:
      contents: read
    steps:
      # The scanner's code from this run's commit. Nothing in the artifacts is ever run.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "22"
      - uses: actions/download-artifact@<pinned sha> # v4
        with: { name: scan, path: tracker-data }
      - uses: actions/download-artifact@<pinned sha> # v4
        with: { name: signature, path: tracker-data }
      - uses: sigstore/cosign-installer@756fe2d284c7292c4e9b62c8a28f1e5629c59532 # v4.1.3
        with:
          cosign-release: v3.1.4
      - name: Verify the signed manifest
        run: node src/cli.ts verify-manifest --data=tracker-data --repo="$REPOSITORY"
        env:
          REPOSITORY: ${{ github.repository }}
      - name: Upload the scan
        run: node src/radar-cli.ts publish --data=tracker-data --require-signature --bucket=radar
        env:
          R2_ACCOUNT_ID: ${{ vars.R2_ACCOUNT_ID }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

The backfill runs once, before the switch, as a one-off `workflow_dispatch` job in the same `r2-upload` environment, so the key never leaves GitHub: fetch the data branch's full history (`git fetch origin data`, in a checkout with `fetch-depth: 0`), then `node src/radar-cli.ts backfill --repo=. --ref=origin/data --bucket=radar`. It only reads the branch. Planning takes about three minutes, and it writes 73,509 objects. Running it again writes nothing new.

## Setup (done by a person, in Cloudflare and GitHub)

1. **Bucket** `radar` in the Stackduke account, location ENAM, Standard storage, public access off. (Done.)
2. **API token:** R2 → Manage API tokens → Create Account API token, permission **Object Read & Write**, applied to the bucket `radar` only. An account token outlives any one person's user. Copy the Access Key ID and Secret Access Key it shows once.
3. **GitHub Environment** `r2-upload` on Stackduke/mcp-scanner, deployment branches limited to `main`, with secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and the variable `R2_ACCOUNT_ID` (the account id; the endpoint is `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`). No required reviewers: the upload runs unattended each day.
4. **Custom domain:** bucket → Settings → Custom Domains → Connect Domain → `data.stackduke.com`. Leave the `r2.dev` development URL disabled: it is rate-limited and not cached.
5. **Cache rule** for the zone `stackduke.com`: when the hostname is `data.stackduke.com`, eligible for cache, Edge TTL "use the origin's Cache-Control", Browser TTL "respect origin". Without it Cloudflare does not cache JSON. Smart Tiered Cache is optional.
6. **CORS** on the bucket (Settings → CORS policy):

   ```json
   [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": [], "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"], "MaxAgeSeconds": 86400 }]
   ```

   Any origin, because the data is public and anyone may build on it; no credentials are involved. Purge the cache for the hostname after changing the policy.
