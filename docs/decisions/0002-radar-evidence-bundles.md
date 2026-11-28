# 0002: Per-server evidence bundles for Radar

- Status: **proposed** (revision 2, after an independent review). Design only; no code yet. It needs approval before anything is built, because what is published under `evidence/` is meant to last: today the bucket lock on that prefix means nobody can overwrite or delete it without lifting the lock by hand (open question 1 asks whether that should stay so).
- Date: 28 November 2026
- Builds on: signed scans (`manifest.json` and its Sigstore signature, [../verify-a-scan.md](../verify-a-scan.md)), check outcomes (method 1.1.0, [../METHOD.md](../METHOD.md)), and storage on R2 ([0001-radar-storage-r2.md](0001-radar-storage-r2.md)), which reserved the prefix `evidence/`.

## The goal

A Radar server page can say "on 3 December this server listed 14 tools, 2 of them labelled destructive", and a reader can check that the signed scan says so. They cannot see what the server sent: the scan keeps only fingerprints of each tool's fields (`src/tracker.ts:255-279`).

An **evidence bundle** fills that gap. For each server and scan, it is a JSON file holding what the scanner received when it checked that server: each HTTP answer's status and content type, and the bodies of the protocol answers (the `initialize` result and every `tools/list` page), with the hash of each body. A separately signed **evidence statement** ties the bundles to the scan. Together they are **Stackduke's signed attestation** of what its scanner received from an address at a time. A vendor can confirm or dispute it against their own records. Anyone can check that it is internally consistent: the bundles match the signed hashes, and the tool list, labels and outcome on the page follow from the bundle. It does not prove that a server sent something without trusting the scanner: a dishonest scanner could sign anything. It makes the claim specific, permanent and open to challenge.

Decided on 26 November 2026: bundles are **downloads only**, public with no sign-up, as JSON files, and never rendered as page text. Tool descriptions and server instructions are third-party text that may hold instructions aimed at AI agents, and the site never quotes a server's words.

Everything about evidence is **separate from the scan**. Evidence is checked, signed and uploaded alongside the main scan, but a failure anywhere in evidence drops that scan's evidence only. The scan, its manifest, its signature, its `data` branch commit and its upload never wait on evidence (section 6).

## 1. What is captured, per server, per scan

### What the scanner holds today, and drops

One check of a server with no sign-in runs `lookOpen` (`src/track.ts:322-333`), which calls `listToolsWithFacts` (`src/client.ts:200-249`) once, or twice when the first attempt may clear up. In memory, during the check:

| What | Where | Kept today? |
| --- | --- | --- |
| Each request's HTTP status, `Content-Type`, whether `WWW-Authenticate` was present, `Mcp-Session-Id`, and the body as decoded text (up to 4 MB a reply, 8 MB for a list) | `send()`, `src/client.ts:209-231` | No. The text is parsed (`readRpcReply`, `src/client.ts:240`) and dropped. Only the **last** status survives, as a fact. |
| The `initialize` result: `protocolVersion`, `serverInfo`, `capabilities`, `instructions` | `listOver`, `src/client.ts:122-125`, `:242-243` | Only `serverInfo.name` and `.version`, and the agreed protocol version (cut to identifier characters). |
| Each `tools/list` page and its `nextCursor`, up to 50 pages (`src/client.ts:120`, `:200`) | `src/client.ts:132-141` | No. `readTool` (`src/client.ts:92-101`) keeps only the protocol's fields of each tool, and the scan keeps a fingerprint of each field (`printOf`, `src/tracker.ts:272-279`). |
| Why the listing ended | `errorClassOf`, `src/client.ts:176-185` | Yes: the error class, last status, protocol version and retries (`lastCheck`, `checkDetails`, `src/tracker.ts:375-390`, `:419-424`). |
| The error behind a failed connection | `last.error`, `src/client.ts:227` | Only its class. The message (which can hold an IP address) is never kept. |
| Timing | | Not per request. The check's start time is kept, and the crawl adds up time per host (`src/track.ts:398`, `:407`). |
| The flapping check's second read | `record`, `src/track.ts:273-279` | Only its verdict. |
| An attempt cut off at 45 seconds | `withinTime`, `src/track.ts:107-112` | Recorded as a timeout; what came before the cut is lost. |

### What a bundle holds

A bundle records **only what was received**, and nothing that differs from one day to the next when the server's answer has not changed: no time, no timing, no scanner version, no reading of the scanner's. Those go in the evidence index (section 4). The bundle is the attempt whose result was recorded (the retry, when there was one).

```json
{
  "evidence": 1,
  "endpoint": "0a1b2c3d4e5f",
  "url": "https://mcp.example.com/mcp",
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

- **`exchanges`**, in order: what we asked (the method, our own JSON-RPC id, the cursor we sent back), the HTTP status, the content type (section 2), whether the server issued a session id (yes or no, never the id), and the body.
- **Which bytes are hashed.** `body.bytes` and `body.sha256` are of the body as `fetch` hands it over: after any HTTP content coding (gzip, brotli) has been removed, and before any character decoding. A vendor matching against their own logs must hash the uncompressed body.
- **When text is kept.** `body.text` is kept only for a 2xx answer whose content type is JSON or an event stream, and only when the text is an exact copy of those bytes: the bytes are decoded as UTF-8 with no replacement and no BOM removed (`TextDecoder` with `fatal: true, ignoreBOM: true`), and the UTF-8 encoding of the text must hash to `body.sha256`. Otherwise the body is hash-only. So every whole `text` in a bundle is byte for byte what was received. A cut `text` (section 5) is a prefix of those bytes, cut at a code-point boundary and marked `"truncated": true`.
- The `initialize` result (protocol version, `serverInfo`, `capabilities`, `instructions`) and every `tools/list` page are inside the kept text as the server sent them, unknown fields included. Nothing is parsed and written out again.
- **`end`**, in the scanner's own words: `answered`, `redirect` (never followed), `cut` (the 45-second attempt limit), or `{ "error": "ENOTFOUND" }` (an error's code, never its message).
- A check that got no answer still has a bundle: no exchanges, and its `end`.

### New capture needed (build phase)

1. `listToolsWithFacts` takes an optional recorder (`capture`), which `send()` feeds for each exchange, with its duration. `readCapped` (`src/client.ts:56-68`) keeps the raw bytes it reads (it already stops at the limit) so they can be hashed and checked against the text. The recorder refuses to start when a `bearerToken` is given (section 3).
2. The recorded exchanges travel **inside `Looked`** (`src/track.ts:131`), so every path that records a look carries them: `lookOpen`, the official servers' `lookNow`, and the second looks after the crawl (`lookAgain`, `src/track.ts:416-425`), including a second look recorded from its first (`:417-420`).
3. `withinTime` (`src/track.ts:107-112`), when it cuts an attempt off, **copies** what was recorded up to the cut, so nothing the abandoned request does afterwards can change the bundle.
4. A new writer (`src/evidence.ts`) applies sections 2 and 5, decides per endpoint whether a new bundle is due (section 5), and writes the bundles, the index and the statement into their own folder (section 6).

## 2. What is never captured, or is stripped

| Never captured | Why |
| --- | --- |
| **Request headers.** | Ours are fixed and documented (the index's `client` block). A public check sends no credential. |
| **Response headers**, except two: the `Content-Type`, and on a 401 or 403 the **names** of the schemes in `WWW-Authenticate` (`Bearer`, say). The content type is normalised to `<type>/<subtype>`, plus `; charset=<value>` when given, in lower case and at most 100 characters. Type, subtype and charset are RFC 9110 tokens (letters, digits, the backtick and `!#$%&'*+-.^_|~`), joined by `/`, `; ` and `=`. Anything else is recorded as `"unreadable"`. | Headers carry cookies (`Set-Cookie`), session ids (`Mcp-Session-Id`, which can act as a key to that session), request and trace ids, internal host names and load-balancer details. None of them helps check a claim. |
| **A sign-in challenge's parameters**: `realm`, `resource_metadata`, `error_description` and the rest. | Whether the challenge was there decides the error class (`http_4xx_auth`), so its presence and scheme names are kept. Its parameters are the server's free text. |
| **The text of a non-2xx answer, or of an answer that is neither JSON nor an event stream** (an HTML login page, say). Size and sha256 only. | Login and error pages are large, change often, and can hold anything. "This address asked for a sign-in" is shown by the status and the challenge. |
| **`Location`** of a redirect. | It can hold a token. |
| **Our own run identifiers, tokens and addresses.** | Public checks send no token. Error messages, which can name IP addresses, are reduced to their code. Bundles hold no time or run id. |
| **Anything from a server watched with a sign-in.** | Section 3. |

**Hash-only is a guess-checker.** A body kept as hash and size is hidden from someone who cannot guess it, not from someone who can: "Unauthorized", or a short standard error page, can be confirmed by hashing a guess. That is acceptable for what is kept hash-only here: answers any anonymous client gets from the same address. It is not a way to keep a secret.

### Addresses that may themselves be keys

Some registry addresses carry a secret: a token in the query string, or a long opaque path segment that works as a key. Of the 51,798 endpoints in the scan of 27 November, 2,076 have a query string (5 with a parameter named like a token, key, auth or signature), and 371 have a path segment of 32 or more letters, digits, `-` or `_` (2,447 in all, 469 of those checked that day). The review counted 452 with a broader definition. An answer behind such an address can be specific to whoever holds it, so **every check of an address with a query string, a user name or password, or a path segment of 32 or more such characters is hash-only**: no bundle, only the index's body hashes (`"evidence": "hash-only"`, `"reason": "address"`). The addresses themselves are already public in `endpoints.jsonl`, as the registry lists them; that is a matter for the tracker, outside this design.

### Credential-shaped text in a body

A server can send a credential in its own text: a key pasted into a tool description, an example that is really a live key, or an echo of something it was sent. **Rule: withhold, never redact.** When a body kept as text trips a check below, that check's bundle keeps every exchange's status, content type, size and sha256, drops every `text`, and says `"withheld": "credential-shaped text"`. It is published as a hash-only bundle (open question 5), and the page says the evidence was withheld.

- **Why not redact.** A redacted body is no longer what was received, and every published byte would depend on the redaction code being right, forever. Withholding keeps one rule: every whole `text` in a bundle is exactly what was received.
- **Why not refuse more.** One server's text must never cost anything beyond its own bundle (section 6).

**What trips it** (in `src/evidence.ts`; a false alarm only withholds one bundle, so the list leans towards withholding):

- private-key blocks (`-----BEGIN` … `PRIVATE KEY-----`);
- JSON Web Tokens (three base64url parts, the first decoding to a JSON object with `alg`);
- the published prefixes of common keys: cloud access keys, source-host tokens, chat-platform tokens, live payment keys, AI API keys;
- credentials in a URL: `<scheme>://<user>:<password>@`;
- webhook URLs: Slack (`hooks.slack.com/services/…`) and Discord (`discord.com/api/webhooks/…`, `discordapp.com/api/webhooks/…`);
- pre-signed URL signatures: `X-Amz-Signature=`, `X-Goog-Signature=`, and Azure SAS (`sig=` together with `se=` or `sv=`);
- assignments shaped like a secret: a name containing `api_key`, `apikey`, `secret`, `token`, `password` or `passwd`, then `:` or `=`, then a quoted value of 20 or more characters with high entropy (at least 3.5 bits a character, and at least three character classes). Obvious placeholders (`your_…`, `<…>`, `${…}`, `xxxx…`, `…example…`) do not count;
- **the job's own secrets** (section 6, "Token comparison").

**Linear time.** A hostile server chooses the text these checks read, so no check may backtrack. They are written as plain scans, not as general regular expressions. Each finds a fixed anchor (`-----BEGIN`, `eyJ`, `://`, `hooks.slack.com`, a known key prefix, `=`, `:`) with `indexOf`, then reads forward at most a fixed number of characters (at most 4 KiB for a PEM block, 256 for the rest) with an explicit loop. Each character is examined a bounded number of times, so a 256 KiB body costs a few milliseconds whatever it holds. As a backstop, a body whose checks run past 200 ms is withheld. Tests feed pathological input: 256 KiB of `eyJ.` repeated, of `-----BEGIN` with no end, of `api_key: "` with no closing quote, of `https://a:` repeated, one 256 KiB base64 run, and the same at every alignment. They assert a bound on work done (characters examined), not a wall-clock time.

**Personal data.** Emails, phone numbers, private IP addresses (10/8, 172.16/12, 192.168/16, fc00::/7) and internal-looking host names (`.internal`, `.local`, `.corp`) in a public server's own answers are part of what that server sends every anonymous client, usually a support address or an example. They are **not withheld automatically**: doing so would withhold a large share of bundles over support addresses. The shadow week (section 9) counts how often each appears. Personal data about an identifiable person is grounds for takedown (section 8).

## 3. Privacy, enforced in code

Evidence follows the uploader's rules ([0001](0001-radar-storage-r2.md#privacy)), checked at each layer.

**Where capture runs (the `track` job):**

- Only on the public path (`lookOpen`, and `lookNow` and `lookAgain` when they call it). Never on `lookSignedIn` (`src/track.ts:303`). `listToolsWithFacts` throws if a recorder is passed together with a `bearerToken`, so no future caller can capture a token-bearing exchange by mistake.
- Never for an address on a kept-off site: the tracker never checks one (`src/track.ts:248-262`), and the writer also tests each bundle's `url` with the uploader's `siteVerdict` (`src/radar-layout.ts:112`) and writes nothing for one that is not `public`.
- Never for an endpoint whose id is not 12 hex characters (a `signed-in-<vendor>` id).
- The anonymous check of a registry address belonging to a privately tracked vendor (it answered "sign-in required") is public, like its endpoint record (decision of 26 November 2026): a status, a content type, the challenge's scheme names, and a body hash.

**Where it is checked again (`evidence-check` before signing, `upload` before uploading):** the scan's evidence is dropped, never the scan, if any of these hold:

- a bundle's endpoint is not an endpoint of the scan, is a private record (`isPrivateRecord`), or has an id that is not 12 hex characters;
- a bundle's `url` is not exactly its endpoint record's `url`, or is not `public` by `siteVerdict` (fails closed: an unreadable address counts as not public);
- a bundle exists for an address that must be hash-only (section 2);
- the binding rules below fail.

**Every refusal is structural.** A whole-evidence refusal can be caused only by a writer bug or by tampering, never by what a server sent. Each check is about **our own structure**: the keys of our objects, the sizes, hashes and counts the writer recorded, the urls and ids taken from our endpoint records. **None is a search of a body's text.** An exchange object may have only the keys the writer emits (`request`, `status`, `contentType`, `authSchemes`, `sessionIssued`, `body`), and a body only `bytes`, `sha256`, `text` and `truncated`. A tool description containing the words `Set-Cookie`, or `"withheld"`, or a JSON-looking header, is just text inside `text` and changes nothing. Server content can only change what the writer does with that one bundle (hash-only, withheld, cut, deferred). The one exception, a credential check that fires at `evidence-check` on a kept `text`, runs the same code at the same commit as the writer, so it fires only if the writer skipped a body: that is a writer bug, and the evidence is dropped.

**Binding to the scan.** Each bundle and index line must agree with the scan it belongs to (`endpoints.jsonl` of the same scan, read from the `scan` artifact):

- the index line's `at`, `outcome`, `errorClass`, `status` and `retries` equal the endpoint record's `lastChecked`, `outcome` and `lastCheck`;
- for a new bundle of a check that listed tools: the scanner's own reader (`readRpcReply`, `readTool`, `takeSnapshot`, `printOf`, `listHashOf`), run over the bundle's `tools/list` texts, gives the endpoint record's `listHash`. The one exception is a list held back as flapping (the record's `unstable` equals this check's time and its `listHash` is the saved one): the bundle must then differ, and the line is flagged `unstable`. A bundle with a cut body cannot be recomputed; it is flagged `truncated` and only its other rules apply;
- for a line pointing to an earlier bundle (`"evidence": "same"`): the record's `listHash` and outcome equal the `last` the line carries.

`restore` never puts evidence back (it is not part of the data folder), and the backfill publishes none.

**Tests, named for the build phase:**

| File | Test |
| --- | --- |
| `test/client.test.ts` | "a recorder with a bearer token is refused"; "only Content-Type and the scheme names of WWW-Authenticate are recorded"; "a content type with odd characters is recorded as unreadable"; "an error keeps its code and never its message"; "a redirect's Location is not kept"; "the body's sha256 is of the bytes after content decoding"; "a body with a BOM or invalid UTF-8 is hash-only" |
| `test/evidence.test.ts` (new) | "a look at a server watched with a sign-in writes no evidence"; "an endpoint on a kept-off site writes no evidence"; "an address with a query string or a long opaque segment is hash-only"; "a non-2xx or HTML body keeps only its size and sha256"; "a body over the cap is cut at a code-point boundary, with its full size and sha256"; "each credential shape withholds the bundle"; "a placeholder in an assignment does not"; "a body holding one of the job's secrets, raw, JSON-escaped or base64 at any alignment, is withheld, and nothing about it is logged"; "pathological input to every check stays within its work bound"; "a check past 200 ms withholds the bundle"; "a tool description containing Set-Cookie changes nothing"; "the same answer on two days gives the same bundle bytes"; "an unchanged endpoint points to its last bundle"; "a change, a new outcome or a refresh due writes a new bundle"; "known endpoints are funded before new ones"; "a budget group on shared hosting is its suffix"; "the rolling budget carries over from the previous statement"; "with no readable previous statement, the scan has no evidence"; "a cut attempt keeps what was recorded before the cut"; "a second look after the crawl carries its capture" |
| `test/evidence-check.test.ts` (new) | "drops evidence for a signed-in-<vendor> id"; "drops evidence for an endpoint not in the scan"; "drops evidence whose url differs from its endpoint's"; "drops evidence on a kept-off site, including a trailing-dot host"; "drops evidence with an unreadable url"; "drops a bundle for an address that must be hash-only"; "drops a bundle with a key the writer does not emit"; "drops a bundle over a cap"; "drops a bundle whose tool fingerprints differ from the scan's list"; "drops an index line that disagrees with its endpoint record"; "drops a pointer to a bundle not in the previous signed index"; "drops evidence whose statement names another scan's manifest"; "drops evidence whose budget arithmetic does not follow from the previous statement"; "a flapping list held back binds as unstable" |
| `test/radar-storage.test.ts` | "a scan with evidence publishes scan.json with evidenceRecord and an empty evidence list"; "a scan whose evidence failed publishes without evidenceRecord"; "a failure to put evidence does not stop the scan"; "bundles are stored with Content-Disposition: attachment"; "restore ignores evidenceRecord" |
| `test/workflow.test.ts` | "track hands on evidence with one day's retention and holds no R2 key or id-token"; "evidence-check has no secrets and no id-token"; "sign-evidence downloads only the statement"; "sign, publish-signature and upload do not need evidence to succeed"; "only drop-evidence may delete artifacts"; "the evidence artifact is checked for links" |

As with the uploader, the privacy and binding checks are run over real data before anything is published (section 9), not only over fixtures.

## 4. Format, keys, and how the signature covers them

### Keys

| Key | What |
| --- | --- |
| `evidence/<endpoint-id>/<sha256>.json` | One bundle. `<sha256>` is the sha256 of the file's bytes, so the key proves the content, as for `lists/`. Already reserved by layout 1. |
| `snapshots/<scan-id>/evidence.jsonl.gz` | The scan's evidence index (below). |
| `scans/<scan-id>/evidence.json` | The scan's evidence statement (below). |
| `scans/<scan-id>/evidence.sigstore.json` | Its Sigstore signature. |

All are under prefixes the bucket lock already covers. Layout stays at version 1: the change adds documented files and one optional field, and `latest.json` keeps its shape. Bundles are stored as plain `.json` (open question 3), with `Content-Type: application/json` and **`Content-Disposition: attachment; filename="stackduke-evidence-<endpoint-id>-<first 12 of sha256>.json"`**, set at upload with the other headers (`put`, `src/radar-publish.ts:263-265`). Browsers ignore a link's `download` attribute across origins, so the header is what makes a click download the file instead of showing it. The scratch-bucket check (0001) gains a line confirming R2 keeps `Content-Disposition` on `GET` and `HEAD`. A Cloudflare response-header rule adding `X-Content-Type-Options: nosniff` for `data.stackduke.com` is a setup step for an account admin.

**How a scan points to its evidence.** `scan.json` gains a top-level field, `evidenceRecord`, present only when the scan's evidence passed every check and was uploaded:

```json
"evidenceRecord": { "statement": "scans/2026-12-03T143107Z/evidence.json", "signature": "scans/2026-12-03T143107Z/evidence.sigstore.json", "index": "snapshots/2026-12-03T143107Z/evidence.jsonl.gz", "statementSha256": "…", "written": 2215 }
```

It is **not** listed in `files`, and `scan.json`'s existing `evidence` list **stays empty**. `restore` refuses a `files` entry it has no place for (`src/radar-restore.ts:90-92`) and a non-empty `evidence` list (`:77-78`), and restore becomes the daily start after 0001's phase 2B. A new field it does not read changes nothing for it, or for any other reader of layout 1.

### The evidence statement

Written by the `track` job after `manifest.json`, so it can name it. It holds only hashes, counts and ids: nothing a server wrote.

```json
{
  "evidenceStatement": 1,
  "scan": "2026-12-03T143107Z",
  "manifestSha256": "…",
  "previous": { "scan": "2026-12-02T141950Z", "statementSha256": "…" },
  "index": { "sha256": "…", "bytes": 6512331, "lines": 26104 },
  "bundles": { "new": 2215, "newBytes": 81200311 },
  "budget": { "windowDays": 30, "limitBytes": 4294967296, "usedBefore": 2103344120, "recent": [["2026-11-04T140211Z", 70112003], ["…", 0]] }
}
```

- `manifestSha256` binds the evidence to exactly one scan. The main manifest says nothing about evidence and is signed without it.
- `previous` chains each statement to the one before, so the evidence history is one signed chain.
- `index.bytes` is the index **uncompressed**; stored gzipped, it is about a fifth of that.
- `budget.recent` lists the new bytes of each scan in the last 30 days, so the rolling budget (section 5) can be checked from the statements alone.

### The index

The first line is a header; then one line per endpoint that has ever had evidence or was checked in this scan, sorted by id:

```json
{"evidenceIndex":1,"scan":"2026-12-03T143107Z","client":{"userAgent":"stackduke-mcp-scanner/0.2 (+https://stackduke.com/tracker)","protocolVersion":"2025-06-18"}}
{"id":"0a1b2c3d4e5f","last":{"key":"evidence/0a1b2c3d4e5f/9f2c….json","scan":"2026-12-03T143107Z","listHash":"…","outcome":"L"},"recent":["2026-11-12T150301Z","2026-12-03T143107Z"],"check":{"at":"2026-12-03T14:31:07.120Z","outcome":"L","errorClass":"ok","status":200,"retries":0,"ms":[311,40,520],"evidence":"new"}}
{"id":"3c4d5e6f7a8b","last":{"key":"evidence/3c4d5e6f7a8b/77e1….json","scan":"2026-10-30T…","listHash":"…","outcome":"L"},"recent":[],"check":{"at":"…","outcome":"L","errorClass":"ok","status":200,"retries":0,"ms":[290,38,610],"evidence":"same","bodies":[{"bytes":790,"sha256":"…"},{"bytes":0,"sha256":"e3b0…"},{"bytes":20114,"sha256":"…"}]}}
{"id":"5c6d7e8f9a0b","last":{…},"recent":[…],"check":{…,"evidence":"deferred","reason":"month-budget","bodies":[…]}}
{"id":"6a7b8c9d0e1f","check":{…,"outcome":"L","evidence":"hash-only","reason":"address","bodies":[…]}}
{"id":"7d3e9a0b1c2f","last":{…},"recent":[…]}
{"id":"1f2e3d4c5b6a","last":{…},"recent":[…],"check":{"at":"…","skipped":"host_budget_exceeded"}}
```

- **`last`** is the endpoint's latest full bundle: its key, the scan that wrote it, and the tool fingerprint (`listHash`) and outcome it shows. It is carried forward on every line, checked or not, so the index always says where each endpoint's latest evidence is.
- **`recent`** lists the scans in the last 30 days that wrote a full bundle for the endpoint (for the per-endpoint limit, section 5).
- **`check`**, only when the endpoint was checked (or left) in this scan, gives the scanner's reading: outcome, error class, status, retries, each exchange's `ms`, and `evidence`:
  - `new`: a full bundle was written in this scan; `last` is it.
  - `same`: no new bundle. The tool fingerprints and outcome are the same as `last`, and `bodies` gives this check's own body sizes and hashes, so a vendor can still confirm the exact bytes of that day.
  - `deferred`: a new bundle was due but a budget applied (`reason`: `scan-budget`, `month-budget`, `group-budget` or `endpoint-budget`). `bodies` is given, and `last` stays as it was (it is absent for an endpoint that never had a bundle). A deferred endpoint stays due, and is funded in a later scan.
  - `withheld`: credential-shaped text. `key` names the hash-only bundle, and `bodies` is given.
  - `hash-only`: the address may be a key (section 2). Only `bodies`.
  - `skipped` instead of a reading: the host had used its time, so nothing was asked.
- `flags` may add `unstable` (with `reread` giving the second read's `bodies`) or `truncated`.
- The **`client`** block sits in the header, not in the bundles, so a new scanner version does not change, and re-store, every bundle.

### The chain a reader checks

`evidence.sigstore.json` (Sigstore, made by this repository's Track workflow) → `evidence.json` → its `manifestSha256` is the scan's signed `manifest.json`, and its `index.sha256` is the index → each line's key is a bundle's sha256. No link needs our code: `cosign verify-blob`, `gunzip`, `jq` and `sha256sum` are enough, and [../verify-a-scan.md](../verify-a-scan.md) gets a section showing how. A pointer (`same`) is checked by following `last.scan` to that scan's own signed index.

### From a server page to its bundle for a date

1. Get `latest.json`; take the scan for that date from `scans`.
2. Get its `scans/<scan-id>/scan.json`. No `evidenceRecord` means the scan has no evidence.
3. In the index it names, the endpoint's line gives `last.key` (and, with `check`, that day's reading and body hashes).
4. Download the bundle; its sha256 must be the name in its key.

A site build does steps 1 to 3 ahead of time, so a page carries the link itself (section 7).

## 5. Size, growth and budgets

### Measured from the current data

Read-only from `https://data.stackduke.com`: the scan `2026-11-27T135611Z` and the four before it.

| | Value |
| --- | --- |
| Endpoints | 51,798 |
| Checked in one scan | about 24,000 (24,049 on 27 Nov; 20,000 to 27,000 a day over 8 days) |
| Of those, listed tools | 21,591, with 297,114 tools (mean 13.8, median 6, 99th percentile 124, most 1,960) |
| Tool lists that really changed that day | 1,132, with a **mean of 38.2 tools** (servers that change are larger than the average) |
| First seen that day | 577 (321 listed, mean 21.5 tools) |
| Outcome changed that day (endpoints not new) | 362 |
| Endpoints with more than 4 recorded changes in the last 30 days | 2,112; more than 8: about 930 |
| Checked endpoints on shared hosting (each host its own site, below) | 2,249, of which `workers.dev` 1,243, `vercel.app` 301, `onrender.com` 202, `railway.app` 165 |

The scan keeps no raw answers, so their size is estimated. The full tool definitions kept on the data branch in October (8 servers, 380 tools) average 1,546 bytes a tool as compact JSON (861 to 2,208). The estimate uses **800 to 1,550 bytes a tool**, plus about 15% for the body being kept as an escaped JSON string, plus about 1.5 KB for `initialize`, framing and the exchanges' details. The shadow week (section 9) replaces these estimates with measurements.

The first revision of this record estimated growth from the mean list (13.8 tools). Changing servers average 38 tools, so its low case was too low by about half; the figures below use the measured split.

### Per-endpoint gating

A new full bundle is written for an endpoint only when:

- it has none yet; or
- its tool fingerprints (`listHash`) or its outcome differ from its `last` bundle's; or
- its `last` bundle is more than **90 days** old (a refresh).

Otherwise the index points to `last` (`"evidence": "same"`) and records that day's body hashes. Each endpoint also gets at most **8 full bundles in 30 days** (`recent`); past that, a change is `deferred` (`endpoint-budget`) until the oldest drops out of the window.

### Budgets, so a hostile server cannot bloat the bucket

The scanner already stops reading a reply past 4 MB, a list past 8 MB, 2,000 tools or 50 pages (`src/client.ts:47-51`, `:120`, `:200`). Evidence adds:

| Limit | Value | Past it |
| --- | --- | --- |
| One body's `text` | **256 KiB** (the 99th-percentile list is about 190 KB) | The text is cut at a code-point boundary, marked `truncated`; `bytes` and `sha256` stay those of the whole body. |
| One bundle | 1 MiB | Bodies are cut, longest first, until it fits. |
| One budget group, one scan | 20 MiB of new bundles | Further new bundles from that group are `deferred` (`group-budget`). |
| One scan | 1 GiB of new bundles | `deferred` (`scan-budget`). |
| **Any 30 days, rolling** | **4 GiB** of new bundles | `deferred` (`month-budget`). This is the hard bound on permanent growth: at most about 52 GB of new evidence a year, whatever servers do. |

- **A budget group** is the address's site (`siteOf`), except on shared hosting. `siteOf` (`src/tracker.ts:185-195`) treats each host under a shared-hosting suffix (`workers.dev`, `vercel.app` and 20 others) as its own site, so a per-site limit alone could be multiplied by registering many free hosts. For budgets, every host under one shared suffix is one group (`workers.dev` is one group).
- **Spending order** when a limit binds: (1) known endpoints whose fingerprints or outcome changed, those with the fewest full bundles in `recent` first; (2) known endpoints deferred earlier, or due a refresh; (3) **endpoints with no bundle yet, last**, round-robin across budget groups. A flood of new endpoints can only use what is left once known servers are covered, and an endpoint that changes every day sinks behind those that change rarely.
- **The rolling budget** is worked out from the previous statement's `budget.recent`. If the previous statement cannot be read and verified (section 6), the scan publishes **no evidence**, rather than guess at what is already in the bucket. The main scan is unaffected.

### Growth with these rules

| | Per day | Per month |
| --- | --- | --- |
| First scan with evidence (every listed endpoint) | 0.30 to 0.56 GB, once (inside the 1 GiB scan limit; large groups finish over the next days) | |
| Changed lists: 1,132 × 37 to 70 KB (an upper bound: the 8-in-30-days limit trims the frequent changers) | 41 to 79 MB | |
| New endpoints: 321 listed × 21 to 40 KB, the rest under 1 KB | 7 to 13 MB | |
| Outcome changes: 362, mostly small | 1 to 9 MB | |
| Refreshes: about 240 a day (21,600 ÷ 90) × 14 to 26 KB | 3 to 6 MB | |
| Index (stored gzipped; about 6.5 MB uncompressed) and statement | about 1.3 MB | |
| **Total** | **about 53 to 108 MB** | **about 1.6 to 3.3 GB** |

That sits under the 4 GiB rolling budget, which binds only on abuse or a day of mass change. Writes: about 2,300 objects a day, about 70,000 a month, well inside R2's free million.

Against what is there already: the bucket holds about 1.85 GB and grows about 1.6 GB a month without evidence, so it passes the 10 GB of free storage around late April 2027 regardless. With evidence it passes it around the **end of January 2027**.

| After a year | Bucket | Storage a month (at $0.015 per GB-month above 10 GB) |
| --- | --- | --- |
| Without evidence | about 21 GB | about $0.17 |
| With evidence, as estimated | about 41 to 61 GB | about $0.47 to $0.77 |
| With evidence, at the rolling budget every month | about 73 GB | about $0.95 |

Every published bundle is meant to stay (open question 1). The budgets make that a bounded, chosen amount (at most about 52 GB a year) rather than whatever servers send, and the shadow week shows the real figure before anything is published (open question 2 asks Dom to confirm the numbers).

## 6. Security of the pipeline

0001's rules hold: the job that reads what servers send gets no R2 key and no OIDC token, and only the `upload` job holds the key. Evidence adds three rules: **the main scan never waits on evidence**, **the job holding the OIDC token never reads server text**, and **any evidence failure drops that scan's evidence and nothing else**.

| Job | Holds | Evidence role | If it fails |
| --- | --- | --- | --- |
| `track` (as today) | vendor tokens and `access.json` in its Scan step; the sign-in app key only in its token steps; no R2 key, no `id-token` | Captures, applies sections 2, 3 and 5, writes `tracker-evidence/` (bundles, `evidence.jsonl`, `evidence.json`) beside the data folder: never committed to `data`, outside the manifest's `tree`, never restored. Hands on two artifacts: `evidence` (everything, `retention-days: 1`) and `evidence-statement` (the one statement file). Same link check as `scan`. | A capture or writer error is caught: the scan writes no evidence and goes on as today. |
| `evidence-check` (new) | `contents: read`; no secrets, no `id-token` | Downloads `scan` and `evidence` outside its checkout and runs the checks of section 3: structure, privacy, binding, caps, budget arithmetic against the previous statement, the credential checks again, and that `manifestSha256` is this scan's manifest. Outputs the statement's sha256. | Evidence is dropped for this scan. |
| `drop-evidence` (new) | `actions: write` only; checks nothing out, downloads nothing | Runs when `evidence-check` failed, and deletes the `evidence` artifact through the API, so unchecked bundles do not stay downloadable. | Nothing waits on it; the artifact expires within a day anyway. |
| `sign-evidence` (new) | `contents: read`, `id-token: write` | Downloads **only** `evidence-statement`, checks its sha256 is the one `evidence-check` output, and signs it with `cosign sign-blob`. It parses nothing: the statement is never even read as JSON here. Hands on `evidence-signature`. | Evidence is dropped for this scan. |
| `sign`, `publish-signature` | unchanged | None. They do not need, wait for or read any evidence job. | As today. |
| `upload` | as today | Needs `sign` (as today) and `sign-evidence`, but runs when `sign` succeeded **whatever** `sign-evidence` did. A separate step, "Check the evidence" (`continue-on-error`), downloads `evidence` and `evidence-signature` and verifies the chain: the signature, `manifestSha256`, the index's sha256, every new bundle's sha256, the structural rules, and that every `same` or older key appears as `last` in the **previous scan's signed index**, which it reads through `latest.json` and that scan's `evidenceRecord`. No `HEAD` per bundle. Only if that step succeeded is `--evidence` passed to `publish`. | The scan is published without evidence. |

**Inside `publish`.** Evidence objects (bundles, index, statement, signature) go first, create-only like every key, then `scan.json` (with `evidenceRecord` only if every evidence object landed), then `latest.json`. Any failure in the evidence part, whether a check, a bug or a `PUT` that runs out of retries, is caught and logged. `scan.json` is then written without `evidenceRecord`. Evidence objects already written stay, unreferenced: they are content-addressed and harmless, and the budgets count them. The main scan's own steps are unchanged.

**Token comparison.** Only the `track` job's Scan step holds secrets that a body could echo: the vendor API tokens in its environment, and the access tokens in `$RUNNER_TEMP/sign-ins/access.json`. Refresh tokens and OAuth client secrets are held only by the Renew step, which reads them from the `STACKDUKE_OAUTH_*` secrets (`src/sign-in-store.ts:73` lists them). `sign`, `upload` and the new jobs hold no vendor secrets, so this check can run only in the Scan step:

- The Renew step writes `fingerprints.json` into the sign-ins folder (mode 0600, deleted at the end of the job, as `access.json` is). It holds no secret, only fingerprints of each refresh token, client secret and access token. Each is taken in several forms: raw, JSON-escaped, and standard and URL-safe base64 at each of the three byte alignments (the inner part that does not depend on what precedes it). Each form becomes its length, a rolling hash and an HMAC-SHA256, both keyed with a random per-run key kept in the same file. The Scan step adds its API tokens the same way, in memory.
- The writer runs one rolling-hash pass over each kept body per distinct length (a handful), linear in the body, and confirms any candidate with the HMAC. A hit withholds the bundle and is never logged with detail.
- So the Scan step never receives a refresh token or client secret, and the check stays linear-time.

**Artifacts are public while they exist.** In a public repository, any signed-in GitHub user can download a run's artifacts. The `evidence` artifact holds only what the `track` writer already passed, is kept for one day, and is deleted when `evidence-check` refuses it. The `evidence-statement` and `evidence-signature` artifacts hold no server text.

## 7. The web side (no web work here)

A server page on stackduke-web gets a **"Download evidence (JSON)"** link beside each check it shows. It points at the bundle in that check's `last.key` (a `same` check links to the earlier bundle it matched, and says when that bundle was taken), with the sha256 shown next to it and a link to the verification steps. The build reads the indexes of the scans it shows and writes the links into the page. The browser never fetches or displays a bundle's content: the file downloads, because the bucket serves it with `Content-Disposition: attachment`. A check that was deferred, withheld, hash-only or left for the next run says so in a fixed phrase. Checks before the first scan with evidence say "no evidence: recorded before <date>". A bundle taken down (section 8) shows the withdrawal log's entry instead of a link. The index carries everything those labels need.

## 8. Takedowns, and what stays

Publishing third-party text that is meant to stay needs its rules before the first byte is published. These are **requirements** for the build phase, not options.

**Grounds for taking a bundle down** (and only these):

1. it holds a credential or secret, anyone's, that the checks missed;
2. it holds personal data about an identifiable person, and that person, or the server's operator on their behalf, asks;
3. the law requires it (a court order, say).

A vendor disliking what its server sent is not a ground: that is what the attestation is for. A takedown removes the bundle; the signed index and statement stay, so the record still shows that a bundle with that hash was published and later withdrawn.

**A public withdrawal log**, `docs/evidence-withdrawals.md` in this repository (public, changed only by reviewed pull request): for each bundle taken down, its key, the date, and the ground by number. Never the content, and never who asked. Pages and verifiers treat a 404 on a key in the log as withdrawn, not as tampering.

**A rehearsed procedure.** Today a takedown under `evidence/` means lifting the bucket's lock rule for the whole prefix. The steps go in [0001](0001-radar-storage-r2.md#rollback)'s runbook: an account admin removes the `evidence/` rule, deletes the object, purges its URL from Cloudflare's cache, puts the rule back, and checks that a create-only `PUT` to a locked key answers 409 again. A second person confirms the rule is back. The procedure is rehearsed on the scratch bucket (with a lock rule, as in the pre-flight) before evidence is switched on, and once a year after that. Open question 1 asks whether the indefinite lock is the right default at all.

## 9. Options considered

**Raw full responses (chosen), gated per endpoint.** The bodies exactly as received and hashed, with headers reduced to an allow-list, error and non-JSON bodies hash-only, credential-shaped text withheld, capability addresses hash-only, a new bundle only when an endpoint's tools or outcome change, and budgets. A vendor can match our hashes against their own logs, and a third party can recompute the page's claims from the bundle. A later method version can re-read old answers. The costs are bounded storage and published third-party text, which the takedown rules, the withholding rules and the download-only rule address.

**Raw full responses every scan.** Simpler: no `same` lines, no `last`. But the first revision's estimate ran to 110 to 205 GB a year if answers carry anything that changes on each request. Most of it would be copies of the same tool list, and none of it could be removed. Rejected for per-endpoint gating, which keeps each day's body hashes, so no day loses its checkable fingerprint.

**A normalised extract.** Parse the answers and keep the useful fields, dropping whitespace, framing and unknown fields. Smaller and steadier, but not what was received: the reader is back to trusting our parser, the bytes can no longer be matched against a vendor's logs, a bug in the extractor is published for good, and fields a later method may want (`_meta`, icons) are gone. Rejected.

**Hashes only in public, raw answers kept private.** Tiny, and nothing hostile or secret is ever published. But only someone with their own copy of the answer can check anything, a private store must grow alongside the public one, and requests need a process. Rejected as the default; it is what `same`, `deferred`, `withheld` and `hash-only` checks fall back to.

## 10. Rollout

**Method version 1.2.0**, with a METHOD.md entry in the same pull request. No tool moves to another kind and no change is recorded differently, but a scan now records, signs and publishes a new kind of fact for every check, and readers need one version that says which scans may carry evidence. The entry also adds to the numbering rules that a new recorded fact is a minor version.

**No backfill.** Scans before 1.2.0 have no raw answers: the scanner never kept them for servers with no sign-in, only fingerprints. They cannot be rebuilt, and a re-scan today would be evidence of today. Pages say so plainly.

**Steps:**

1. **This record is approved**, with the open questions answered.
2. **Build**, off by default: capture, the writer, the statement, the four workflow jobs, the `publish` and layout changes, `verify-evidence`, the docs ([../data-layout.md](../data-layout.md), [../verify-a-scan.md](../verify-a-scan.md), METHOD.md, the withdrawal log), the scratch-bucket line for `Content-Disposition`, and the tests of section 3. A repository variable `RADAR_EVIDENCE` takes `off` (the default), `shadow` or `on`. It works under dual-write (0001's phase 2A) and after the switch (2B).
3. **Rehearse the takedown** on the scratch bucket (section 8).
4. **Look at real bundles by hand.** A small command captures bundles for a few named public addresses into a local folder; a person reads about 50, covering every outcome, before anything runs in the workflow.
5. **Shadow week** (`shadow`, about 7 days). The `track` job captures and runs every check, and reports **aggregates only** in the job summary: full, same, deferred, withheld and hash-only counts, bytes, budget use, how often each credential and personal-data shape appeared, and the largest bundles. No bundle leaves the runner, no evidence job runs, and nothing is uploaded. The gating state for the next day comes from a hash-only index handed on as an artifact, which holds no server text.
6. **Decide with the numbers**: confirm or adjust the budgets (open question 2).
7. **On.** Check the first scan's evidence by hand, through the chain in section 4, with `cosign`, `jq` and `sha256sum` alone.
8. **stackduke-web** adds the links (section 7), as its own change.

**Test plan for the build phase:** the tests named in section 3. A run of `track` against local stand-in servers (as `test/radar-track.test.ts` does) answering with every case: several pages, an event stream, 401 with and without a challenge, 5xx, a redirect, HTML, a BOM, invalid UTF-8, a gzip-encoded answer, a timeout mid-list, a body over the cap, each credential shape, a token echo in each form, a capability address, and an endpoint that changes every day. That run is published to a local folder with `publish --to-folder` and checked with `verify-evidence`. Two more checks: `restore` is unaffected, and a deliberately broken evidence step leaves `sign`, `publish-signature` and the main upload green. Then the shadow week's checks over real data, before `on`.

## 11. Open questions for Dom

1. **Should `evidence/` keep an indefinite lock?** The bucket has one today (0001, setup step 7). The options:
   - **Indefinite lock (today).** Nothing under `evidence/` can be deleted or overwritten by a leaked key, a bug or an admin's mistake. But every takedown means lifting the rule for the whole prefix, and published third-party text is permanent.
   - **A finite retention lock** (R2's age-based rule, for example 365 days). Each bundle is protected for its first year, when a claim is most likely to be disputed. After that it can be deleted with the upload token, so a takedown needs no lock lift, but a leaked key could delete old evidence. Deletion would be visible (a 404 on a signed key), never silent tampering.
   - **No lock.** Tampering is already visible through the signed chain: a changed bundle no longer matches its key, and a deleted one is a 404 on a signed key. But availability rests on the token alone.

   **Recommended: a 365-day retention lock on `evidence/` only.** Integrity comes from the signatures, not the lock. The lock's job is availability while claims are live, and for third-party text, being able to delete later matters more than for the scans themselves. `scans/`, `snapshots/` and `lists/` keep their indefinite locks. Nothing is under `evidence/` yet, so changing the rule now costs nothing.
2. **Budgets.** Proposed: at most 4 GiB of new evidence in any 30 days (at most about 52 GB a year), a refresh every 90 days, and at most 8 full bundles per endpoint in 30 days. These are the numbers that bound permanent growth. Confirm them, or set others, before the shadow week; they can be lowered after it.
3. **Plain JSON or gzipped bundles?** Recommended: plain `.json`, so a download opens as it is and `sha256sum` of the file equals its name. The review agrees.
4. **Error and login pages: hash only, or a little text?** Recommended: hash and size only for any non-2xx or non-JSON body. The review agrees.
5. **Withheld bundles: a hash-only bundle, or nothing?** Recommended: the hash-only bundle, so the page can say "withheld" and a vendor can still match the hashes. The review agrees.
