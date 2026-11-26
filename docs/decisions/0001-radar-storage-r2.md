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

**Cloudflare R2 (chosen).** Downloads are free (no egress charge), the S3 API means any S3 tool can read or copy everything out, create-only writes (`If-None-Match: *`, evaluated atomically by R2) and a bucket lock keep history from being overwritten, and a custom domain gives Cloudflare's cache, our own cache headers and CORS. Stackduke's domain and site are already on Cloudflare. The free tier covers today's use, and the cost at ten times today's size is a few dollars a month (below).

## The decision

History and evidence move to the R2 bucket `radar` (Stackduke's Cloudflare account, location ENAM, Standard storage), served publicly and read-only at `https://data.stackduke.com`. The layout is in [../data-layout.md](../data-layout.md). In short:

- `scans/<scan-id>/`: each scan's small records: `scan.json` (the sha256 of each of the scan's files), and the scan's `manifest.json` and signature when it has them.
- `snapshots/<scan-id>/`: each scan's copy of the data folder: the endpoints, every current tool list in one file, the feed, the servers table, the lookup, the registry state and the host counters (`hosts.json`).
- `lists/<endpoint-id>/<sha256>.json` and `evidence/<endpoint-id>/<sha256>.json`: one object per version, named by the hash of its content.
- `latest.json`: the one object that changes, written after everything else, naming the newest scan and listing every scan.

Every object but `latest.json` is written once and never changed or deleted.

Changes from the first proposal, and why:

- **One folder per scan, named by the scan's start time** (`2026-11-25T142908Z`), not one `checks/YYYY-MM-DD.jsonl.gz` per day. A second run on the same day (a manual re-run) would otherwise need to overwrite an immutable file. A run id was also considered, but scans taken from the data branch's history have none.
- **The manifest goes with the scan's record** (`scans/<id>/manifest.json`) instead of `manifests/<run-id>.json`, so one id finds everything about a scan.
- **Each scan stores the full endpoint file and a bundle of every current list.** A reader (the site's build, or a researcher) gets the whole picture of any day in two downloads, with no replay of earlier days. The content-addressed `lists/` objects keep each version on its own, so one endpoint's history can be read without the bundles.
- **The bulk has its own prefix, `snapshots/`, apart from the records under `scans/`.** R2's bucket rules (locks, lifecycle rules) match by key prefix only, and keys cannot change once readers use them. With the split, a future rule can treat the bulk and the records differently without moving anything.

**Decisions taken on 26 November 2026:**

1. **CORS allows any origin** (`*`) for `GET` and `HEAD`, without credentials: the data is public and anyone may build on it.
2. **Retention: never delete.** There is no lifecycle rule, and every object stays in Standard storage for good. Infrequent Access was considered and rejected at this scale. It saves only $0.005 per GB-month ($0.015 against $0.01). It has no free tier, so the 10 GB-month that Standard gives free would be lost, and it adds a 30-day minimum, a $0.01/GB retrieval fee, and a Class A operation ($9 per million) for each transition. At about 20 GB after a year, that would save cents a month at best, and every read of an old scan would cost money. Revisit if the bucket passes about 100 GB.
3. **The backfill strips servers tracked privately** (below), rather than leaving out whole scans.
4. **The backfill runs once, from GitHub,** as a one-off `workflow_dispatch` job in the `r2-upload` environment, so the key never leaves GitHub.
5. **The shard stopgap stays the documented fallback** (below), in case phase 2 slips.
6. **The `data` branch is frozen at the switch,** with a README pointing to `data.stackduke.com`. Its history stays readable, and it is never rewritten or deleted.

**What stays in git:** the scanner's code, the catalog, and the documentation. Nothing from a scan after the switch. The private data of servers tracked privately stays where it is, in the private repository; none of it goes to the bucket.

**What is public:** everything in the bucket, which is everything already public on the `data` branch today, except the records of servers now tracked privately (below). The bucket's S3 API is not public: only the upload job's key can write, and nobody needs a key to read.

**No new dependency.** The uploader uses Node's `fetch` and its own AWS Signature Version 4 signing, about 25 lines. AWS's two published S3 signing examples are the real test of the signing, and both pass. The tests also run the uploader against a local stand-in for the S3 API. That stand-in checks each request's signature with the same code that made it, so it shows the requests are wired up, not that the signing is right. The AWS CLI was considered: it cannot express "write only if absent, and otherwise compare hashes" without wrapping it in a script, which would be harder to test than the Node code.

## Privacy

The bucket is public, so nothing about a server tracked privately, or on the site of a vendor whose terms forbid publishing about it, may reach it. This is enforced in code, not only here:

- Planning a scan refuses the whole scan if any endpoint record, feed entry, `servers.json` row, tool list or `watched/` file belongs to a server watched with a sign-in. It reads only fields the scanner writes itself (`signedIn`, and ids of the form `signed-in-<vendor>`), so no server can block uploads by giving a tool a vendor's name. The refusal names no server, because workflow logs are public.
- Layout 1 has no place for any server watched with a sign-in, so all of them are refused, even a vendor the catalog marks `publish: true` (none is today). Publishing one would first need a key for its `watched/` file and for its list, whose id is not 12 hex characters.
- **Kept-off sites.** The catalog marks some vendors `forbidden`: their terms forbid publishing about their service (Sentry, Intercom and Airtable today). The tracker keeps their sites off: it never checks an address on them. When a site becomes kept off, it now also deletes the endpoint's saved list and the site's `hosts.json` entries. The uploader does not rely on that. It refuses a whole scan with any endpoint record, feed entry, `hosts.json` host or tool list on such a site. A tool list is judged both by the host in its file name and by the address it was read from (`source`).
- Beyond those fields, each file may hold only what the layout knows:
  - `feed.json`, `registry.json`, `lookup.json` and `hosts.json` may have only the top-level fields of the tracker's own types;
  - every `servers.json` row must be an endpoint of the same scan;
  - `lookup.json` must be exactly the lookup the tracker makes from that `servers.json`;
  - a `hosts.json` entry may hold only its two counters.

  A field added to the tracker later stops the upload until the layout is told it holds only public data.
- Before 24 October 2026 the `data` branch also held servers now tracked privately (12 commits, from 18 to 23 October), and from 16 to 23 October public endpoint records for Airtable and Sentry addresses. The backfill removes both, with their lists, feed entries and servers rows, rebuilds the lookup from the rows it keeps, and planning checks again. It never reads `watched/`. The totals in those days' `feed.json` never counted the servers tracked privately: the tracker added up public endpoints only.
- Tests cover each case.

## Security of the upload

The R2 key is a credential that can write to a public bucket, so only one small job ever holds it.

- **Separate jobs.** The `track` job reads what third-party servers send. It gets no R2 key and no OIDC token, and hands its output on as a workflow artifact. The `sign` job signs the manifest with Sigstore keyless signing. The `upload` job holds the R2 key and nothing else of value.
- **The upload job checks before it uploads.** It runs the scanner's code checked out from the workflow's own commit, never code from the artifact. `publish --require-signature` checks the folder with the scanner's own manifest check (`verify-manifest`):
  - the cosign signature, made by this repository's Track workflow;
  - the whole folder's digest (`tree`), which covers the lists the scan did not rewrite;
  - every file the manifest lists, against its sha256.

  It then refuses any file the layout has no place for. Each file is checked against the manifest again as it is read for upload, so a write to the folder after the check is caught. It also refuses a scan whose start time is in the future or more than 8 days ago, since the pointer never moves back and a scan dated ahead would hold it. `publish` to a bucket refuses to run without `--require-signature`; only `--unsigned`, given on purpose, skips it, and that is for the scratch-bucket check alone.
- **History cannot be overwritten, at two layers.** The uploader writes every key create-only and compares hashes when a key is already there. That protects against mistakes, not against a leaked key: an R2 token with Object Read & Write can also overwrite and delete. The bucket lock (setup step 7) closes that gap. Under it, no key under `scans/`, `snapshots/`, `lists/` or `evidence/` can be overwritten or deleted by anyone, an account admin included, until the lock rule itself is removed. A compromised `upload` job or a leaked key could then at worst add a wrong new scan under new keys, or point `latest.json` at a wrong scan.
- **Overlapping runs cannot move the pointer back.** `latest.json` is read again just before it is written, and written only if it is still the version just read (`If-Match` with its ETag, or `If-None-Match: *` when there is none). The run that loses a race reads it again and retries, so neither scan is dropped. The backfill job also shares the Track workflow's concurrency group, so the two do not run at once.
- **A GitHub Environment holds the key.** Environment `r2-upload`, with deployment branches limited to `main`: only a job that names the environment and runs from `main` gets the secrets, so a workflow dispatched from another branch cannot use them. Repository-level secrets would reach every job.
- **The token can do one thing.** An R2 API token with Object Read & Write on the bucket `radar` only. It cannot list or create buckets, change settings (the lock included), or touch anything else in the account.

## Cost

R2 charges $0.015 per GB-month of storage above 10 GB-month, $4.50 per million Class A operations (writes) above 1 million a month, and $0.36 per million Class B operations (reads, HEAD) above 10 million a month. Downloads (egress) are free. Measured from the real data with the backfill's dry run:

| | Today | 10 times today |
| --- | --- | --- |
| One scan, stored | 50.8 MB (endpoints 12.3 MB gzip, lists bundle 17.5 MB gzip, servers 8.7 MB, lookup 2.6 MB, feed 0.6 MB, 1,561 new list versions 8.9 MB) | about 510 MB |
| Growth per month (one scan a day) | about 1.55 GB | about 15.5 GB |
| Backfill of the data branch (53 scans) | about 1.75 GB and 73,500 objects, once | n/a |
| Writes per month (one per object, plus the pointer) | about 47,000 | about 470,000 |
| Reads per month by the uploader (a HEAD per object) | about 47,000 | about 470,000 |
| Storage billed after 12 months | about 10 GB → **$0.16 a month** (about $0.60 for the first year in all) | about 178 GB → **$2.67 a month** (about $17 for the first year) |
| Operations billed | none: well inside the free tier | none: still inside the free tier |

Reads by the public go through Cloudflare's cache, so most never reach R2. Even uncached, ten million reads a month are free, and each million after that costs $0.36. Nothing is ever deleted (decision 2), so storage only grows. At today's rate the bucket passes 100 GB, the point to look at retention again, in about five years; at ten times today's size, in about six months.

## Rollback

- **Phase 1** changes nothing that runs: the new commands are not called by any workflow. Reverting this change removes them.
- **Phase 2, the workflow.** Revert the workflow change and the tracker commits to the `data` branch again. The branch resumes from its frozen state; the scans made in between stay in R2 and can be restored into it with the `restore` command. The 100 MB limit then applies again, so the fallback below would be needed too.
- **Phase 2, the site.** Keep the site's archive reader behind a switch for the first week, so the site can go back to the `data` branch by changing one setting.
- **A bad scan was published.** Its objects stay (the lock keeps them), but readers follow `latest.json`, which the lock does not cover. Withdraw the scan in `latest.json`, with an account admin's credentials:
  1. Download `latest.json`.
  2. Move the bad id from `scans` to `withdrawn`, and set `scan` and `record` to the newest scan left.
  3. Upload it, for example with `npx wrangler r2 object put radar/latest.json --file=latest.json --content-type=application/json --cache-control="public, max-age=60" --remote`.
  4. Purge `https://data.stackduke.com/latest.json` from Cloudflare's cache.

  Every upload keeps `withdrawn` as it found it. A withdrawn scan is never listed or made current again, and a re-run of its upload is refused before anything is sent. Removing a scan's objects (a takedown, or something that should never have been published) means removing the lock rule first. That is a deliberate, manual step for an account admin, and the rule goes back straight after.

## Fallback if phase 2 slips past 5 December

Have this ready to apply by about 8 December, so it can ship before the push fails around 15 December. Shard `endpoints.jsonl` in the `data` branch by the first hex digit of the endpoint id (16 files of about 4 MB each), and teach the tracker and the site's build to read the shards. Sharding by month was considered, but `endpoints.jsonl` is today's state, rewritten whole each day, not a log: a month's file would still hold every endpoint. Shards keep the push working for many months, but do not stop the history from growing, so they are a stopgap only.

## Phase 2: the workflow change (not applied)

### Restoring the data folder

The `track` job needs the previous scan's folder to start from. A `restore` command rebuilds it from the bucket, with no key: it reads `latest.json`, then that scan's files.

- `endpoints.jsonl`, `feed.json`, `servers.json`, `lookup.json`, `registry.json` and `hosts.json` come from `snapshots/<scan>/`.
- Each line of `lists.jsonl.gz` becomes the file at its `path`: the raw text of its `list`, as it stands in the line, followed by a newline, checked against its `sha256`. `list` is always the line's last field, so its text is everything after `"list":` but the closing `}`. It is taken as it is, not parsed and written out again, which could change the bytes. Lists no endpoint names are in the bundle too, so every list comes back.
- `manifest.json` and `manifest.sigstore.json` come from `scans/<scan>/`.
- `.gitattributes` is written from the scanner's own constant (`dataAttributes` in `track.ts`). It is the same in every scan, so it needs no copy in the bucket.

The folder then digests to the previous manifest's `tree`, so the scanner's check of the previous scan passes, with two exceptions to plan for:

- **The first restored run.** The data branch's `README.md` was part of the last git scan's `tree` and is not restored, so that run records an unclean start once. Every later manifest is made from a restored folder, so the runs after it are clean.
- **Evidence.** The bucket keeps evidence by content hash, not by its path in the folder. Before the tracker writes evidence into the data folder, either keep it outside the folder that `tree` covers, or record each file's path in `scan.json` so `restore` can put it back.

### The jobs

The `track` job restores the folder instead of checking out the data branch, commits nothing to the data branch, and hands the folder on as an artifact. The `sign` job takes the folder from that artifact. Its `check-before-signing` step reads the scan's data commit today, so it needs a variant that checks the folder alone. The `upload` job replaces `publish-signature`. Action versions are pinned by commit, as in the rest of the workflow.

```yaml
concurrency:
  group: track
  cancel-in-progress: false

jobs:
  track:
    # As today, except: the data folder is restored from the latest scan instead of checked out from the
    # data branch, nothing is committed to the data branch, and the folder is handed on as an artifact.
    # This job holds no R2 key and no OIDC token.
    steps:
      # ...
      - name: Restore the latest scan
        run: node src/radar-cli.ts restore --from=https://data.stackduke.com --to=tracker-data
      # ... renew, check sign-ins, scan, private notice and private commit, as today ...
      - name: Hand the scan on
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: scan
          path: tracker-data/
          include-hidden-files: true # .gitattributes is part of the signed folder
          retention-days: 7

  sign:
    needs: track
    permissions:
      contents: read
      id-token: write
    steps:
      # As today, but the folder comes from the artifact, and the check before signing runs on the folder alone.
      # Hands manifest.sigstore.json on as the artifact manifest-signature, as today.

  upload:
    needs: [track, sign]
    if: ${{ !cancelled() && needs.sign.result == 'success' }}
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
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with: { name: scan, path: tracker-data }
      # Unpacked outside the folder, so the artifact can put nothing else there; only the one file is copied in.
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with: { name: manifest-signature, path: "${{ runner.temp }}/signature" }
      - run: |
          test -f "$RUNNER_TEMP/signature/manifest.sigstore.json" && test ! -L "$RUNNER_TEMP/signature/manifest.sigstore.json"
          cp "$RUNNER_TEMP/signature/manifest.sigstore.json" tracker-data/manifest.sigstore.json
      - uses: sigstore/cosign-installer@756fe2d284c7292c4e9b62c8a28f1e5629c59532 # v4.1.3
        with:
          cosign-release: v3.1.4
      # Verifies the signature, the folder's digest and every file's sha256 before anything is sent.
      - name: Upload the scan
        run: node src/radar-cli.ts publish --data=tracker-data --require-signature --bucket=radar
        env:
          R2_ACCOUNT_ID: ${{ vars.R2_ACCOUNT_ID }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

### The backfill job

It runs once, before the switch, from its own workflow file. It shares the Track workflow's concurrency group, so it never runs alongside a scan, and it reads the data branch only.

```yaml
name: Radar backfill
on: workflow_dispatch
permissions:
  contents: read
concurrency:
  group: track
  cancel-in-progress: false
jobs:
  backfill:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    environment: r2-upload
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "22"
      - run: git fetch -q origin data
      - run: node src/radar-cli.ts backfill --repo=. --ref=origin/data --bucket=radar
        env:
          R2_ACCOUNT_ID: ${{ vars.R2_ACCOUNT_ID }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

Planning takes about three minutes, and it writes about 73,500 objects. Running it again writes nothing new. Run it after the last scan committed to the data branch and before the first scan published to the bucket. Otherwise that last scan has to be backfilled again, which is safe.

### Before the first upload: check R2 with a scratch bucket

The uploader relies on four things that Cloudflare's S3 compatibility page does not fully confirm. Check them once, in a throwaway bucket with its own token, before phase 2 runs:

1. A `PUT` with `Content-Type`, `Cache-Control` and `x-amz-meta-source-sha256` comes back with all three on `HEAD`. If the metadata is dropped, every re-run stops with "different content": that fails safe, but re-runs become impossible.
2. A `PUT` with `If-None-Match: *` to a key already there answers 412 and leaves the object as it was.
3. A `PUT` of `latest.json` with `If-Match` and a stale ETag answers 412. With the current ETag (as `GET` returns it, quotes included), it succeeds.
4. With a lock rule on the scratch bucket, a create-only `PUT` to a locked key answers 409 `ObjectLockedByBucketPolicy`. The uploader treats that like a 412.

`node src/radar-cli.ts publish --data=<a scan folder> --bucket=<scratch bucket> --unsigned`, run twice, covers 1 and 2 (the second run must report every object "already there"). Then remove the scratch bucket's lock rule (a bucket cannot be emptied while one is set), empty and delete the bucket, and delete its token.

## Setup (done by a person, in Cloudflare and GitHub)

1. **Bucket** `radar` in the Stackduke account, location ENAM, Standard storage, public access off. (Done.)
2. **API token:** R2 → Manage API tokens → Create Account API token, permission **Object Read & Write**, applied to the bucket `radar` only. An account token outlives any one person's user. (Done.)
3. **GitHub Environment** `r2-upload` on Stackduke/mcp-scanner, deployment branches limited to `main`, with secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, and the variable `R2_ACCOUNT_ID` (the account id; the endpoint is `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`). No required reviewers: the upload runs unattended each day. (Done.)
4. **Custom domain:** bucket → Settings → Custom Domains → Connect Domain → `data.stackduke.com`. Leave the `r2.dev` development URL disabled: it is rate-limited and not cached. (Done.)
5. **Cache rule** for the zone `stackduke.com`: when the hostname is `data.stackduke.com`, eligible for cache, Edge TTL "use the origin's Cache-Control", Browser TTL "respect origin". Without it Cloudflare does not cache JSON. Smart Tiered Cache is optional.
6. **CORS** on the bucket (Settings → CORS policy):

   ```json
   [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": [], "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"], "MaxAgeSeconds": 86400 }]
   ```

   Any origin, because the data is public and anyone may build on it (decision 1); no credentials are involved. Purge the cache for the hostname after changing the policy.
7. **Bucket lock**, after the scratch-bucket check and before the backfill: four indefinite rules, one per immutable prefix, and none for `latest.json`.

   ```sh
   for prefix in scans/ snapshots/ lists/ evidence/; do
     npx wrangler r2 bucket lock add radar "keep-${prefix%/}" "$prefix" --retention-indefinite
   done
   ```

   What it blocks: overwriting or deleting any object under those prefixes, by the upload token, a leaked key, a lifecycle rule or an account admin, until the rule is removed (bucket → Settings → Bucket lock rules, or `wrangler r2 bucket lock remove`). That covers taking down a scan or file after it was published, too: remove the rule, delete, and put the rule back. It does not block new keys, and it does not cover `latest.json`, which every run rewrites.
8. **The data branch,** at the switch: commit a README pointing to `https://data.stackduke.com` and [../data-layout.md](../data-layout.md) as the branch's last commit (decision 6).
