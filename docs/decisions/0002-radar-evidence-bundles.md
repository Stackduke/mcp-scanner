# 0002: Per-server evidence bundles for Radar

- Status: **proposed**. Design only; no code yet. It needs approval before anything is built, because whatever is published under `evidence/` is permanent: the bucket lock on that prefix means nobody can overwrite or delete it without lifting the lock by hand.
- Date: 28 November 2026
- Builds on: signed scans (`manifest.json` and its Sigstore signature, [../verify-a-scan.md](../verify-a-scan.md)), check outcomes (method 1.1.0, [../METHOD.md](../METHOD.md)), and storage on R2 ([0001-radar-storage-r2.md](0001-radar-storage-r2.md)), which reserved the prefix `evidence/`.

## The goal

Every claim on a Radar server page should be checkable without trusting Stackduke. Today a page can say "on 3 December this server listed 14 tools, 2 of them labelled destructive", and a reader can check that the signed scan says so. They cannot check that the server really sent it: the scan keeps only fingerprints of each tool's fields (`src/tracker.ts:255-279`), not what the server sent.

An **evidence bundle** closes that gap. For each server and each scan, it is a JSON file holding what the scanner actually received when it checked that server: each HTTP answer's status and content type, and the bodies of the protocol answers (the `initialize` result and every `tools/list` page), as received. The scan's signed manifest covers every bundle, and each one is served from `https://data.stackduke.com`. Anyone, the vendor included, can then confirm that "Stackduke's scanner received X from this address on date Y", and recompute the tool list, the labels and the outcome from it.

On 26 November 2026 it was decided that bundles are **downloads only**: public, with no sign-up, as JSON files, and never rendered as page text. Tool descriptions and server instructions are third-party text that may hold instructions aimed at AI agents, and the rule that the site never quotes a server's words stands.

## 1. What is captured, per server, per scan

### What the scanner holds today, and drops

One check of a server with no sign-in runs `lookOpen` (`src/track.ts:322-333`), which calls `listToolsWithFacts` (`src/client.ts:200-249`) once, or twice when the first attempt may clear up. In memory, during the check:

| What | Where | Kept today? |
| --- | --- | --- |
| Each request's HTTP status, `Content-Type`, whether `WWW-Authenticate` was present, `Mcp-Session-Id`, and the body as text (up to 4 MB a reply, 8 MB for a whole list) | `send()`, `src/client.ts:209-231` | No. The text is parsed (`readRpcReply`, `src/client.ts:240`) and dropped. Only the **last** status survives, as a fact. |
| The `initialize` result: `protocolVersion`, `serverInfo`, `capabilities`, `instructions` | `listOver`, `src/client.ts:122-125`, `:242-243` | Only `serverInfo.name` and `.version`, and the agreed protocol version (cut to identifier characters). `capabilities` and `instructions` are dropped. |
| Each `tools/list` page, and its `nextCursor` | `src/client.ts:132-141` | No. `readTool` (`src/client.ts:92-101`) keeps only the protocol's fields of each tool (unknown fields such as `_meta` or icons are dropped), and the scan then keeps only a fingerprint of each field (`printOf`, `src/tracker.ts:272-279`). |
| Why the listing ended | `errorClassOf`, `src/client.ts:176-185` | Yes: the error class, last status, protocol version and retries (`lastCheck` and `checkDetails`, `src/tracker.ts:375-390`, `:419-424`). |
| The error behind a failed connection | `last.error`, `src/client.ts:227` | Only its class. The message (which can hold an IP address) is never kept. |
| Timing | | Not measured per request. The check's start time is kept, and the crawl adds up time per host (`src/track.ts:398`, `:407`). |
| A second read of a list that changed (the flapping check) | `record`, `src/track.ts:273-279` | Only its verdict. |
| An attempt cut off at 45 seconds | `withinTime`, `src/track.ts:107-112` | Recorded as a timeout. What came before the cut is lost. |

### What a bundle holds

The bundle is the **attempt whose result was recorded** (the retry, when there was one; earlier attempts appear only as the `retries` count). When the flapping check read the list again and the server was found unstable, that second read is kept as a second bundle, so the claim "unstable" is checkable too.

A bundle records **only what was received**, not what the scanner made of it, and nothing that differs from one day to the next when the server's answer has not changed. That is what lets an unchanged server cost nothing new each day (section 4). The scanner's reading (outcome, error class, timing, retries) goes in the scan's evidence index instead (section 4), which is per scan and small.

```json
{
  "evidence": 1,
  "endpoint": "0a1b2c3d4e5f",
  "url": "https://mcp.example.com/mcp",
  "client": { "userAgent": "stackduke-mcp-scanner/0.2 (+https://stackduke.com/tracker)", "protocolVersion": "2025-06-18" },
  "exchanges": [
    { "request": { "id": 1, "method": "initialize" },
      "status": 200, "contentType": "text/event-stream", "sessionIssued": true,
      "body": { "bytes": 812, "sha256": "…", "text": "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{…}}\n\n" } },
    { "request": { "method": "notifications/initialized" },
      "status": 202, "contentType": "", "body": { "bytes": 0, "sha256": "e3b0c442…" } },
    { "request": { "id": 2, "method": "tools/list" },
      "status": 200, "contentType": "application/json",
      "body": { "bytes": 18231, "sha256": "…", "text": "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[…],\"nextCursor\":\"p2\"}}" } },
    { "request": { "id": 3, "method": "tools/list", "cursor": "p2" }, "status": 200, "contentType": "application/json", "body": { … } }
  ],
  "end": "answered"
}
```

- **`exchanges`**, in order: what we asked (the JSON-RPC method, our own id, and the cursor we sent back), the HTTP status, the content type (section 2), whether the server issued a session id (a yes or no, never the id), and the body.
- **`body.bytes` and `body.sha256`** are of the raw bytes received, before any decoding, for every answer. A vendor that logs its responses can match them exactly.
- **`body.text`** is the body decoded as UTF-8, kept only for a 2xx answer whose content type is JSON or an event stream, and only up to the cap (section 5). The `initialize` result (protocol version, `serverInfo`, `capabilities`, `instructions`) and every `tools/list` page are in it as the server sent them, unknown fields included. Nothing is parsed and written out again, so nothing is lost or reordered.
- **`end`** says how the attempt ended, in the scanner's own words: `answered`, `redirect` (the client never follows one), `cut` (the 45-second attempt limit), or `{ "error": "ENOTFOUND" }` (the error's code only: never its message, which can hold an IP address).
- A check that got no answer at all (DNS, TLS, connection, timeout) still has a bundle: no exchanges, and its `end`. These are tiny and rarely change, so they cost almost nothing.

New capture needed, in the build phase:

1. `listToolsWithFacts` takes an optional recorder (`capture`), which `send()` feeds for each exchange. `readCapped` (`src/client.ts:56-68`) also hashes the raw bytes as it reads them. The recorder refuses to start when a `bearerToken` is given (section 3).
2. `send()` measures each exchange's duration, for the index.
3. `lookOpen` and `record` (`src/track.ts`) hand the recorded attempt, and the flapping check's second read when the server was unstable, to a new evidence writer (`src/evidence.ts`). `withinTime` keeps what was recorded before a cut.
4. The writer applies the rules of sections 2 and 5, writes the bundles and the index into a folder of their own (section 6), and gives `buildManifest` (`src/manifest.ts:106-133`) the index's digest.

## 2. What is never captured, or is stripped

| Never captured | Why |
| --- | --- |
| **Request headers.** | Ours are fixed and documented (the bundle's `client` block). For a public check they hold no credential: none is sent. |
| **Response headers**, except an allow-list: the `Content-Type`, reduced to the media type and `charset` (lower case, at most 100 characters, identifier characters only, otherwise `"unreadable"`), and on a 401 or 403 the **names** of the schemes in `WWW-Authenticate` (`Bearer`, say). | Headers carry cookies (`Set-Cookie`), session ids (`Mcp-Session-Id`, which can act as a key to that session), request and trace ids, internal host names and load-balancer details. None of them helps check a claim, and all of them are permanent once published. |
| **The details of a sign-in challenge**: `realm`, `resource_metadata`, `error_description` and the rest. | Whether the challenge was there decides the error class (`http_4xx_auth`), so its presence and scheme names are kept. Its parameters are the server's free text and can hold anything. |
| **The body of a non-2xx answer, or of a 2xx answer that is neither JSON nor an event stream** (an HTML landing page or login page, say). Its size and sha256 are kept, not its text. | Login and error pages are large, change often, and can hold anything, including tracking and session data. "This address asked for a sign-in" is shown by the status and the challenge's presence. A vendor can still match the hash. |
| **`Location`** of a redirect. | It can hold a token. A redirect is recorded as `end: "redirect"`. |
| **Our own run identifiers, tokens and addresses**: the runner's IP, the run id, any token. | Public checks send no token. Error messages, which can name IP addresses, are reduced to their code. The bundle has no time and no run id, so it can be shared across scans. |
| **Anything from a server watched with a sign-in.** | Section 3. |

### A body that holds something that looks secret

A server can send back a credential in its own text: a key pasted into a tool description, an example that is really a live key, or an echo of something it was sent. Once published it cannot be taken back.

**Decision: withhold, do not redact.** When a body kept as text trips the credential check, that check's bundle keeps every exchange's status, content type, size and sha256, drops every `text`, and says `"withheld": "credential-shaped text"`. The index marks it, and the page says the evidence was withheld.

- **Why not redact.** A redacted body is no longer what the server sent, so the bundle stops being evidence of anything, and every published byte would depend on our redaction code being right, forever. Withholding keeps one simple rule that a reader can rely on: every `text` in a bundle is exactly what was received. The hashes still let a vendor confirm the answer against their own logs.
- **Why not refuse the whole scan.** One server's text would stop every server's evidence, and the scan, for that day.
- **What trips it** (high-confidence shapes only, in `src/evidence.ts`): private-key blocks (`-----BEGIN … PRIVATE KEY-----`), JSON Web Tokens (three base64url parts, the first decoding to a JSON header), and the published prefixes of common keys (cloud provider access keys, source-host tokens, chat-platform tokens, live payment keys, AI API keys). A false alarm only withholds one server's text for one scan, so the list leans towards withholding.
- **Plus the job's own secrets.** The `track` job holds vendor tokens for its private work (section 6). The writer refuses to keep any body that contains one of them byte for byte, as `src/signed-in.ts` already refuses a server that sends its token back. The values are compared, never logged.
- The same check runs again before signing and before upload. A hit there means the writer let one through, so the scan is refused whole, in line with the uploader's other privacy rules.

## 3. Privacy, enforced in code

Evidence follows the uploader's rules ([0001](0001-radar-storage-r2.md#privacy)) with no exceptions, and they are checked at each layer, not just written down here.

**Where capture runs (the `track` job):**

- Only on the public path: `lookOpen` (`src/track.ts:322`). Never on `lookSignedIn` (`src/track.ts:303`). `listToolsWithFacts` throws if a recorder is passed together with a `bearerToken`, so no future caller can capture a token-bearing exchange by mistake.
- Never for an address on a kept-off site: the tracker never checks one (`src/track.ts:248-262`). The writer also tests each bundle's `url` with the uploader's `siteVerdict` (`src/radar-layout.ts:112`) and drops any that is not `public`.
- Never for an endpoint whose id is not 12 hex characters (a `signed-in-<vendor>` id).
- The anonymous check of a registry address that belongs to a privately tracked vendor (it answered "sign-in required") is public, like its endpoint record (decision of 26 November 2026). Its bundle holds a status, a content type, the challenge's scheme names and a body hash, nothing more.

**Where it is checked again (the `sign` and `upload` jobs, `planScan` in `src/radar-layout.ts`):** a scan is refused whole, with a message that names no server, when any of these hold:

- a bundle's endpoint is not an endpoint of the scan, is a private record (`isPrivateRecord`), or has an id that is not 12 hex characters;
- a bundle's `url` is not exactly its endpoint record's `url`, or is not `public` by `siteVerdict` (it fails closed: an unreadable address is refused);
- a bundle or an index line has a field this layout does not know, as for the top files today (`knownFields`, `src/radar-layout.ts:185-190`);
- a header name other than the allow-list appears anywhere in a bundle;
- a bundle is over the size caps (section 5), or trips the credential check;
- an index line names an endpoint or a bundle that is not part of the scan;
- the index's sha256 is not the one the manifest gives (section 4).

`restore` never puts evidence back (it is not part of the data folder), and the backfill publishes none.

**Tests, named for the build phase:**

| File | Test |
| --- | --- |
| `test/client.test.ts` | "a recorder with a bearer token is refused"; "the recorder keeps only Content-Type and the scheme names of WWW-Authenticate"; "an error keeps its code and never its message"; "a redirect's Location is not kept"; "the body's sha256 is of the raw bytes" |
| `test/evidence.test.ts` (new) | "a look at a server watched with a sign-in writes no evidence"; "an endpoint on a kept-off site writes no evidence"; "a non-2xx body keeps only its size and sha256"; "an HTML body keeps only its size and sha256"; "a body over the cap is cut, with its full size and sha256"; "a private key, a JWT or a known key prefix withholds the bundle"; "a body holding one of the job's tokens is withheld, and the token is not logged"; "the same answer on two days gives the same bundle bytes"; "a site past its evidence budget gets hash-only bundles"; "a scan past its evidence budget gets hash-only bundles" |
| `test/radar-storage.test.ts` | "refuses evidence for a signed-in-<vendor> id"; "refuses evidence for an endpoint not in the scan"; "refuses evidence whose url differs from its endpoint's"; "refuses evidence on a kept-off site, including a trailing-dot host"; "refuses evidence with an unreadable url"; "refuses a bundle with an unknown field or header"; "refuses a bundle over the size cap"; "refuses a bundle that trips the credential check"; "refuses an index whose sha256 is not the manifest's"; "refuses an index line naming a bundle not in the scan"; "a bundle already in the bucket is not written again" |
| `test/manifest.test.ts` | "the manifest's evidence digest is signed with the rest"; "a manifest with no evidence section still reads" |
| `test/workflow.test.ts` | "track hands evidence on, and holds no R2 key or id-token"; "sign checks evidence before signing"; "upload checks evidence before uploading"; "the evidence artifact is checked for links" |

As with the uploader, the privacy checks are run over real data before anything is published (section 9): fixtures alone missed real cases last time.

## 4. Format, keys, and how the signature covers them

### Keys

| Key | What | New? |
| --- | --- | --- |
| `evidence/<endpoint-id>/<sha256>.json` | One bundle. `<sha256>` is the sha256 of the file's bytes, so the key proves the content, as for `lists/`. | Reserved by layout 1 |
| `snapshots/<scan-id>/evidence.jsonl.gz` | The scan's evidence index: one line per endpoint the scan checked or left (below). | New file name in an existing prefix |

Both prefixes are already under the bucket lock. Layout stays at version 1: the change only adds a documented file, and `latest.json` and `scan.json` keep their shape. `scan.json`'s `evidence` (an empty list in every scan so far) names the bundle keys first written in that scan, as `lists.written` does for lists, and its `files` lists `evidence.jsonl.gz` with its sha256.

**Deduplicated by content.** A server that sends the same bytes as yesterday gives the same bundle, the same key, and nothing new to store. That is why a bundle holds no time, no timing and no reading of the scanner's: those go in the index.

### The index

```json
{"id":"0a1b2c3d4e5f","at":"2026-12-03T14:31:07.120Z","outcome":"L","errorClass":"ok","status":200,"retries":0,"ms":[311,40,520,488],"evidence":"evidence/0a1b2c3d4e5f/9f2c….json"}
{"id":"7d3e9a0b1c2f","at":"2026-12-03T14:31:09.004Z","outcome":"S","errorClass":"http_4xx_auth","status":401,"retries":0,"ms":[95],"evidence":"evidence/7d3e9a0b1c2f/41aa….json"}
{"id":"5c6d7e8f9a0b","at":"2026-12-03T14:32:40.551Z","outcome":"L","errorClass":"ok","status":200,"retries":0,"ms":[280,35,610],"evidence":"evidence/5c6d7e8f9a0b/0b7e….json","reread":"evidence/5c6d7e8f9a0b/c3d1….json","flags":["unstable"]}
{"id":"1f2e3d4c5b6a","at":"2026-12-03T14:40:02.000Z","skipped":"host_budget_exceeded"}
```

One line per endpoint, sorted by id. The outcome letters and error classes are those of [../METHOD.md](../METHOD.md); `ms` gives each exchange's duration; `flags` may say `unstable`, `truncated`, `withheld` or `over-budget`. A check left for the next run (its host had used its time) has a line and no bundle: nothing was asked.

### The chain a reader checks

The scan's `manifest.json` gains one section, written by the `track` job like the rest and signed with it:

```json
"evidence": { "index": { "sha256": "…", "bytes": 5210331, "lines": 24049 }, "bundles": { "new": 1497, "newBytes": 30411200 } }
```

So: the **signature** covers `manifest.json` → the manifest gives the **index's** sha256 → the index gives each **bundle's** key → the key is the bundle's sha256. No link in that chain needs our code: `cosign verify-blob`, `gunzip`, `jq` and `sha256sum` are enough, and [../verify-a-scan.md](../verify-a-scan.md) gets a section showing how.

The section is optional, and `readManifest` (`src/manifest.ts:141-160`) already ignores fields it does not know, so the manifest stays at version 1, and today's `verify-manifest` keeps working on new scans.

### From a server page to its bundle for a date

1. The page knows the endpoint id (the first 12 hex characters of the sha256 of its address) and the date.
2. `latest.json` lists every scan id. Take the one for that date (a scan id is its start time).
3. In `snapshots/<scan-id>/evidence.jsonl.gz`, the line with that `id` gives the bundle's key.
4. Download `https://data.stackduke.com/<key>`; its sha256 must be the name in the key.

A site build does steps 2 and 3 once, ahead of time, so a page carries the link itself (section 7).

## 5. Size and cost

### Measured from the current data

From the bucket's latest scan (`2026-11-27T135611Z`) and the four before it, read from `https://data.stackduke.com`:

| | Value |
| --- | --- |
| Endpoints | 51,798 |
| Checked in one scan | about 24,000 (24,049 on 27 Nov; 20,000 to 27,000 a day over the last 8 days) |
| Of those, listed tools | 21,591, with 297,114 tools (mean 13.8, median 6, 90th percentile 26, 99th 124, most 1,960) |
| Sign-in required / not usable / unreachable | 1,769 / 496 / 193 |
| Lists whose tools really changed in that scan | 1,132 (5.2% of those listed) |
| New lists in that scan (new endpoints) | 349 |
| List versions written per scan, last 5 scans | 1,481 to 1,651 |
| Endpoints with more than 650 tools | 15 (4 over 1,300) |

The scan keeps no raw answers, so their size is estimated. The full tool definitions kept on the data branch in October (8 servers, 380 tools) average **1,546 bytes per tool** as compact JSON (from 861 to 2,208), and gzip to 14% to 32% of that. Those are large, well-documented servers; the registry's long tail (median 6 tools) is likely terser, so the estimate below uses **800 to 1,550 bytes a tool**, plus about 15% for the body being kept as an escaped JSON string, plus about 1.5 KB for `initialize`, the framing and the exchanges' details.

So a bundle for a server that listed tools is about **14 to 26 KB** on average; the others are under 1 KB.

How often a bundle changes is the big unknown. The fingerprints changed for 5.2% of listed servers in a day, but a server whose answer carries something that moves every time (a timestamp, a request id in the body) gives a new bundle every day even when its tools are the same. The shadow week (section 9) measures it. The two ends:

| | Low: bundles change as often as tool lists | High: every listed server's bundle is new each day |
| --- | --- | --- |
| First scan with evidence | 0.30 to 0.56 GB, once | 0.30 to 0.56 GB, once |
| New bundles a day | about 1,500 → 21 to 39 MB | about 21,600 → 0.30 to 0.56 GB |
| Index, a day | about 1 MB | about 1 MB |
| Growth a month | 0.6 to 1.2 GB | 9 to 17 GB |
| Added after a year | 8 to 15 GB | 110 to 205 GB |
| Writes a month (Class A) | about 50,000 | about 650,000 |

Against what is there already: the bucket holds about 1.85 GB (the backfill's 1.75 GB plus the first daily scans) and grows about 1.6 GB a month without evidence, so it passes the 10 GB of free storage around **late April 2027** either way. With evidence it passes it in about 3 months (low) or 2 to 3 weeks (high).

What that costs, at $0.015 per GB-month above 10 GB, with writes inside the free million a month in both cases:

| After a year | Bucket | Storage a month |
| --- | --- | --- |
| Without evidence | about 21 GB | about $0.17 |
| Low | about 29 to 36 GB | about $0.29 to $0.39 |
| High | about 130 to 225 GB | about $1.80 to $3.20 |
| High, stored gzipped | about 50 to 75 GB | about $0.60 to $1.00 |

The money is small at either end. The real constraint is that nothing under `evidence/` can ever be deleted: the high case reaches 0001's "look at retention again" mark of 100 GB within a year, and stays there for good. Hence the shadow week before anything is published, and a fallback ready if churn turns out high (open question 1).

### Caps, so a hostile server cannot bloat the bucket

The scanner already stops reading a reply past 4 MB, a list past 8 MB, 2,000 tools or 50 pages (`src/client.ts:47-51`). Evidence adds its own, enforced by the writer and checked again before signing and before upload:

| Cap | Limit | Past it |
| --- | --- | --- |
| One body's `text` | 1 MiB | The text is cut there, with `"truncated": true`. `bytes` and `sha256` are still those of the whole body, so the cut is visible and the full answer can still be matched. |
| One bundle | 2 MiB | Bodies are cut, longest first, until it fits. |
| New evidence from one site in one scan | 20 MiB | That site's further new bundles keep sizes and hashes only (`over-budget`). |
| New evidence in one scan | 1 GiB | The same, for every further new bundle. |

From the measurements, one body cut at 1 MiB touches only the handful of servers with roughly 650 tools or more on one page. The site budget matters because the crawl may check up to 150 addresses on one site a run (`--per-site`): without it, one operator with many registry entries could add 300 MB a day. The scan budget is about twice the estimated high case, so it bounds abuse without cutting a normal day.

## 6. Security of the pipeline

The rules of 0001 stay as they are: the job that reads what servers send gets no R2 key and no OIDC token, and only the `upload` job holds the key.

- **`track` builds the bundles.** It is the job that parses untrusted answers. It holds no R2 key and no `id-token`; it does hold vendor tokens and the sign-in app key for its private work, which is why capture never runs on the signed-in path and why the writer refuses any body holding one of those tokens. The writer applies the privacy rules, the credential check and the caps as it writes, into **`tracker-evidence/`, a folder beside the data folder**: `bundles/<endpoint-id>/<sha256>.json` and `evidence.jsonl`. It is never committed to the `data` branch (keeping the bulk out of git was the point of 0001), and it is outside the folder the manifest's `tree` digests, so `restore` and the next scan's check of its starting folder are unaffected (this settles 0001's note on evidence).
- **Deduplication before hand-off.** The `track` job reads the previous scan's index from `https://data.stackduke.com` (public, no key) and leaves out of the folder any bundle that index already names: it is in the bucket. If that read fails, every bundle goes, which costs only time. Unchanged servers then cost no upload work either.
- **Hand-off unchanged.** The folder goes to the next jobs as its own artifact, `evidence`, under the same conditions and link check as `scan` (`.github/workflows/track.yml:229-248`).
- **`sign` checks before it signs.** It downloads `evidence` outside its checkout and runs `check-evidence`: the index's sha256 against the manifest, every bundle in the folder against its name, and the schema, privacy, credential and size rules. Only then does it sign. So the size limits are enforced, and a bad bundle stops the scan, before the signature exists.
- **`upload` checks again before it uploads.** As today: the scanner's code from the run's own commit, the signature, the folder's digest and every file's sha256, and then the evidence chain and all of the rules above. An index line naming a bundle that is not in the artifact must name one already in the bucket (a `HEAD`, which is a cheap read); if it is not there, the scan is refused. Bundles are written create-only, like every key, before `scan.json` and `latest.json`.
- **Fails closed.** Any problem with evidence refuses the whole scan's upload, as the other privacy rules do. The `data` branch commit and its signature are not affected, and "Re-run failed jobs" works as before.

## 7. The web side (no web work here)

A server page on stackduke-web gets a **"Download evidence (JSON)"** link beside each check it shows, pointing at `https://data.stackduke.com/evidence/<endpoint-id>/<sha256>.json`, with the sha256 next to it and a link to the verification steps. The site's build reads the evidence index of each scan it shows and writes the links into the page, so the browser never fetches or displays a bundle's content: it only downloads the file (Content-Type `application/json`, the `download` attribute). A check whose bundle was withheld or cut says so, a check left for the next run says nothing was asked, and checks before the first scan with evidence say "no evidence: recorded before <date>". The index carries everything those labels need.

## 8. Options considered

**Raw full responses (chosen).** The bodies exactly as received, hashed as raw bytes, with headers reduced to an allow-list, non-JSON and error bodies kept as hashes, credential-shaped text withheld, and caps. It is the only option where a third party checks what the server sent rather than what our parser made of it, and where a vendor can match our hashes against their own logs. It also lets a later method version re-read old answers instead of re-scanning. Its costs are storage (section 5), and that third-party text becomes permanent public data, which is what the withholding rule, the caps and the download-only rule are for.

**A normalised extract.** Parse the answers and keep the useful fields (each tool's protocol fields, `serverInfo`, `capabilities`, `instructions`), dropping whitespace, framing and unknown fields. Smaller, perhaps by a third, and steadier from day to day, since volatile fields are dropped. But it is not what was received: the extractor is our code, so the reader is back to trusting it, the bytes can no longer be matched against a vendor's logs, and a bug in the extractor is published for good. It also drops fields (`_meta`, icons, future protocol fields) that a later method may want. Rejected.

**Hashes only in public, raw answers kept private.** Publish each body's sha256 and keep the bodies in a private store, revealed on request. Tiny, and nothing hostile or secret is ever published. But only someone who already has their own copy of the answer can check anything; everyone else has to ask us and trust what we hand over, which is what this work is meant to remove. It also needs a private store that grows with the public one, and a process for requests. Rejected as the default. It is what a withheld or over-budget bundle falls back to.

**Raw only when the tool list or outcome changes, hashes on the other days.** Considered as the fallback if churn is high: on a day the server's tools read the same as in the last stored bundle, the index carries that day's body hashes and points to the last stored bundle. Every claim stays checkable (each tool list shown has a stored bundle behind it), and growth is close to the low case whatever the churn. It is weaker for a vendor checking a particular day's bytes. Held in reserve (open question 1).

## 9. Rollout

**Method version 1.2.0**, with a METHOD.md entry in the same pull request. No tool moves to another kind and no change is recorded differently, but a scan now records, signs and publishes a new kind of fact for every check, and readers need one version number that says which scans carry evidence ("from 1.2.0 on"). The entry will also add a line to the numbering rules saying that a new recorded fact is a minor version.

**No backfill.** Scans before 1.2.0 have no raw answers: the scanner never kept them for servers with no sign-in, only fingerprints. They cannot be rebuilt, and a re-scan today would be evidence of today, not of then. Pages say so plainly (section 7).

**Steps:**

1. **This record is approved** (the open questions answered).
2. **Build**, off by default: capture, the writer, the manifest section, `check-evidence` in `sign` and `upload`, the layout's new file, `verify-evidence`, the docs ([../data-layout.md](../data-layout.md), [../verify-a-scan.md](../verify-a-scan.md), METHOD.md), and the tests of section 3. A repository variable, `RADAR_EVIDENCE`, takes `off` (the default), `shadow` or `on`. It works under dual-write (0001's phase 2A) and after the switch (2B) alike.
3. **Look at real bundles by hand.** A small command captures bundles for a few named public addresses into a local folder. A person reads about 50 of them, from servers of every outcome, before anything runs in the workflow.
4. **Shadow week** (`RADAR_EVIDENCE=shadow`, about 7 days). The `track` job captures and runs every check `sign` and `upload` would run, then reports aggregates only in the job summary: bundles, bytes, new against the day before, withheld, truncated, over budget, largest. The full bundles never leave the runner: workflow artifacts in a public repository can be downloaded, and nothing unchecked should be. Only a hash-only index goes on as an artifact, so day-to-day churn can be compared. The manifest gets no evidence section in shadow mode, so no published scan refers to evidence that is not there.
5. **Decide with the numbers**: full or change-gated (open question 1), plain or gzipped (open question 2).
6. **On** (`RADAR_EVIDENCE=on`). Check the first scan's evidence by hand, against the chain in section 4, with `cosign`, `jq` and `sha256sum` alone.
7. **stackduke-web** adds the links (section 7), as its own change.

**Test plan for the build phase:** the tests named in section 3; a run of `track` against local stand-in servers (as `test/radar-track.test.ts` does) that answer with every case (listed over several pages, event stream, 401 with and without a challenge, 5xx, redirect, HTML, a timeout mid-list, a body over the cap, a planted key, a token echo); that run published to a local folder with `publish --to-folder` and checked with `verify-evidence`; `restore` shown to be unaffected; and the shadow week's checks over real data, before `on`.

## 10. Open questions

1. **If the shadow week shows high churn, which fallback?** Proposed: keep full raw bundles every day if new evidence stays under about **3 GB a month**; above that, switch to "raw only when the tool list or outcome changes, hashes on the other days" (section 8). Is 3 GB a month the right line?
2. **Plain JSON or gzipped bundles?** Proposed: plain `.json`, so a download opens as it is and `sha256sum` of the file equals its name. Gzip would store about a quarter of the bytes, but downloads would be `.gz` files. Switch to gzip only if question 1 lands on the high side and you would rather keep full bundles.
3. **Error and login pages: hash only, or a little text?** Proposed: hash and size only for any non-2xx or non-JSON body. The alternative is to keep the first 4 KB of a 401 or 403 body, which would show a login wall's own words, at the cost of publishing arbitrary page text.
4. **Withheld bundles: publish a hash-only bundle, or nothing?** Proposed: the hash-only bundle, so the page can say "withheld" and a vendor can still match the hashes.
5. **Takedown requests.** A vendor may ask for a bundle to be removed (their own leaked key, say). The only way is 0001's manual one: an account admin lifts the lock, deletes the object and puts the lock back. Should verify-a-scan.md state publicly when that is done (for example, a credential or personal data only)?
