# Radar data layout (version 1)

Radar's scans are published as files at **https://data.stackduke.com**, served from the Cloudflare R2 bucket `radar`. Anyone can download them, with no account and no key. This page is the contract: the exact paths and formats, which files never change, and how to find the latest scan. Why the data lives here and not in git is in [decisions/0001-radar-storage-r2.md](decisions/0001-radar-storage-r2.md).

The code that writes this layout is `src/radar-layout.ts`. Its tests check every rule below.

## Paths

| Path | Format | Changes? |
| --- | --- | --- |
| `latest.json` | JSON, below | **The only file that changes.** Written last, after every other file of a scan is in place. |
| `scans/<scan-id>/scan.json` | JSON, below | Never |
| `scans/<scan-id>/manifest.json` | the scan's manifest: the sha256 of every file the scan wrote, and a digest of its whole folder ([verify-a-scan.md](verify-a-scan.md)) | Never |
| `scans/<scan-id>/manifest.sigstore.json` | the Sigstore bundle signing `manifest.json`, when the scan was signed | Never |
| `snapshots/<scan-id>/endpoints.jsonl.gz` | gzip of JSON Lines: one endpoint record per line, as the tracker's `endpoints.jsonl` | Never |
| `snapshots/<scan-id>/lists.jsonl.gz` | gzip of JSON Lines: every current tool list, one per line, below | Never |
| `snapshots/<scan-id>/feed.json` | as the tracker's `feed.json` | Never |
| `snapshots/<scan-id>/servers.json` | as the tracker's `servers.json` | Never |
| `snapshots/<scan-id>/lookup.json` | as the tracker's `lookup.json` | Never |
| `snapshots/<scan-id>/registry.json` | as the tracker's `registry.json` | Never |
| `snapshots/<scan-id>/hosts.json` | as the tracker's `hosts.json`: for each host the crawl ran out of time on, how many runs in a row, and when last | Never |
| `lists/<endpoint-id>/<sha256>.json` | one version of one endpoint's tool list, exactly as the scanner wrote it | Never |
| `evidence/<endpoint-id>/<sha256>.json` | reserved for the raw responses a scan keeps, the same way | Never |

- A **scan id** is the time the scan started, in UTC, to the second: `2026-11-25T142908Z`. Ids sort in time order. Scans taken from the data branch's history before scans had a manifest (before 26 November 2026) did not record their start, so their id is the time of their commit, about an hour after the scan started. `scan.json` says which (`source`).
- An **endpoint id** is the scanner's id for an address: the first 12 hex characters of the sha256 of the URL.
- In `lists/` and `evidence/`, `<sha256>` is the sha256 of the file's bytes, so the path proves the content. A list that did not change is not written again: each file is one version, first seen in the scan whose `scan.json` names it.
- A file a scan did not produce is not there. Early scans have no `lookup.json` or `hosts.json`. Scans taken from the data branch's history before 26 November 2026 have no manifest.
- Nothing else is ever written to the bucket, and nothing is ever deleted. The uploader refuses any other path.

### latest.json

```json
{
  "layout": 1,
  "scan": "2026-11-25T142908Z",
  "record": "scans/2026-11-25T142908Z/scan.json",
  "scans": ["2026-11-25T142908Z", "2026-11-24T041702Z"],
  "withdrawn": [],
  "updatedAt": "2026-11-25T15:01:12.345Z"
}
```

`scan` is the newest scan, and `scans` lists every scan in the bucket, newest first. The pointer never moves back to an older scan: publishing an old scan (the backfill does this) adds it to `scans` and leaves `scan` alone. Two uploads that overlap both end up listed: each one replaces `latest.json` only if it has not changed since that upload read it, and reads it again otherwise.

`withdrawn` lists scans taken back by hand, for example one published by mistake. Their files stay, but they are not in `scans` and are never made current again. Skip them.

### scan.json

```json
{
  "layout": 1,
  "id": "2026-11-25T142908Z",
  "source": { "kind": "track", "scanStartedAt": "2026-11-25T14:29:08.123Z", "scannerCommit": "…", "methodVersion": "1.1.0", "run": { "id": "…", "attempt": "1", "repository": "Stackduke/mcp-scanner" } },
  "signed": true,
  "files": [{ "key": "snapshots/2026-11-25T142908Z/endpoints.jsonl.gz", "sha256": "…", "bytes": 64205672 }],
  "lists": { "current": 24163, "written": ["lists/0a1b2c3d4e5f/….json"] },
  "evidence": []
}
```

- `source.kind` is `track` for a scan published by the Track workflow, or `data-branch` (with `commit` and `committedAt`, and `scanStartedAt` when the commit has a manifest) for one taken from the data branch's history.
- `files` lists the scan's other files (its manifest and signature under `scans/<scan-id>/`, and everything under `snapshots/<scan-id>/`) with the sha256 and size **of its content**. For a `.gz` file that is the content after decompressing it, so check a download by decompressing it first.
- `lists.written` names the list versions first seen in this scan. Together, the `written` lists of all scans hold the history of every endpoint's tools.

### lists.jsonl.gz

One line per list file in the scan's folder:

```json
{"id":"0a1b2c3d4e5f","path":"lists/0a/mcp.example.com-0a1b2c3d4e5f.json","sha256":"…","list":{"source":"https://mcp.example.com/mcp","takenAt":"…","tools":[…]}}
```

`list` is the list file's JSON, unchanged, and always the line's last field. `path` is where the file sits in the tracker's folder; the file there is that JSON followed by a newline, and `sha256` is the sha256 of that file. The same version is at `lists/<id>/<sha256>.json`. `id` is the endpoint whose record names the file. A few lists belong to endpoints no record names any more (they left the registry, or are no longer checked); they are kept too, with `id` taken from the end of the file's name.

## How to read the latest scan

1. Get `latest.json`. Take `scan`.
2. Get the files you need under `snapshots/<scan>/` and `scans/<scan>/`. Every path you request should come from `latest.json` or a `scan.json`: then it exists, because every file of a scan is in place before `latest.json` names it.
3. To check a download, compare its sha256 with `scan.json`. To check the scanner wrote it, verify `manifest.json` with its signature as [verify-a-scan.md](verify-a-scan.md) describes, then compare each file's sha256 in `manifest.json` with the file. The manifest's digest of the whole folder (`tree`) cannot be checked from the bucket alone, because the folder also held files the bucket does not keep (such as `.gitattributes`).

```sh
SCAN=$(curl -s https://data.stackduke.com/latest.json | jq -r .scan)
curl -s "https://data.stackduke.com/snapshots/$SCAN/endpoints.jsonl.gz" | gunzip | head -n 1
```

Do not guess paths for scans that may not be there yet. Cloudflare caches a "not found" answer for a few minutes, so a path requested too early can stay missing for a while after it is written.

## Headers

| Files | Content-Type | Cache-Control |
| --- | --- | --- |
| `latest.json` | `application/json` | `public, max-age=60` |
| every other `.json` | `application/json` | `public, max-age=31536000, immutable` |
| `.jsonl.gz` | `application/gzip` | `public, max-age=31536000, immutable` |

The `.gz` files are served as gzip files. They are not served with `Content-Encoding: gzip`, so they reach you compressed and you decompress them yourself. JSON files are sent compressed when your client accepts it, as for any page on Cloudflare.

The uploader also stores the sha256 of each object's content with it (as S3 metadata, `source-sha256`), to compare when the object is already there. Readers do not need it: `scan.json` has the same hashes.

## Reading from a browser (CORS)

The bucket answers cross-origin `GET` and `HEAD` requests from any origin, without credentials, so a web page anywhere can read the data. No cookie or key is ever needed or accepted.

## Reading it for a website build

A site that today downloads the whole `data` branch as one archive, to read `lookup.json`, `endpoints.jsonl` and every file under `lists/`, makes four requests instead:

1. `latest.json`, for `scan`.
2. `snapshots/<scan>/lookup.json`, read as before.
3. `snapshots/<scan>/endpoints.jsonl.gz`, decompressed, then read line by line as before.
4. `snapshots/<scan>/lists.jsonl.gz`, decompressed. Each line's `id` and `list` take the place of a `lists/<xx>/<host>-<id>.json` file found in the archive: the id comes from the line instead of the file name, and the list is already parsed.

A local build can use a folder written by `node src/radar-cli.ts publish --to-folder=<dir>` (or `backfill --to-folder`) in place of the bucket: the folder has the same paths.

## Privacy

Only public data is published:
- **Servers that need a sign-in are tracked privately,** and nothing about them is ever uploaded. Layout 1 publishes no server watched with a sign-in at all.
- **Sites whose terms forbid publishing about them are kept off:** no address on them is checked, kept or published.

The uploader refuses a whole scan that holds any endpoint record, feed entry, `servers.json` row, tool list or `watched/` file of such a server, or a `hosts.json` host on a kept-off site. It also refuses:
- a file with fields this layout does not know;
- `servers.json` rows that are not endpoints of the same scan;
- a `lookup.json` that is not the lookup of its `servers.json`.

The tests check each case.

Scans taken from the data branch's history have those records removed first. Before 24 October 2026 the branch also held servers now tracked privately, and from 16 to 23 October endpoints on kept-off sites. The totals in those days' `feed.json` never counted the servers tracked privately.
