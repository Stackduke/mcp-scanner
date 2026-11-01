# MCP server lookup (connector)

A read-only remote MCP server that answers "check this MCP server" from the tracker's published data (the scanner's `data` branch). It runs as a Cloudflare Worker, speaks MCP over Streamable HTTP, and has no sign-in. Linear: SD-112, decided by Dom on 1 November 2026.

**Status: built and tested locally. Not deployed.** Deploying, creating the KV namespace and choosing the address all need Dom's go (see "Deploying").

## What it does and does not do

It does:

- answer for any server the tracker publishes: about 16,800 remote servers from the official MCP registry, 83 of them featured (the official servers in `catalog/tracker-public.json`);
- return tool names grouped by the scanner's machine-guessed kind, counts, what the server's own annotations claim, check times, and the change history the tracker keeps (the last 10 changes per server, each with the two checks it happened between);
- say "not tracked yet" for an unknown address, give the command to scan it locally, and record the address as a request for the tracker to look at (nothing reads those requests yet; see "Unknown servers").

It does not:

- connect to the server a user names, or to anything else. Its only inputs are files deployed with it. That is what Claude's and OpenAI's directory rules require (the server must call only first-party endpoints, and no pass-through to third-party services);
- say anything about servers marked `forbidden` in `catalog/servers.json`, or about catalog servers the tracker does not publish;
- return text-check findings. The issue asks for them, but the tracker does not publish them: a finding goes to a person first so the server's owner can be told privately (see `src/tracker.ts`). Answers say so in a `text_checks` field rather than leaving it out silently;
- say a server is safe, or promote anything.

## Tools

| Tool | Arguments | Answers |
| --- | --- | --- |
| `check_mcp_server` | `url_or_name` | Tool names by guessed kind, counts by kind, the server's own annotation claims, last checked and last listed, featured or community, changes in the last 30 days, and a link to the server's stackduke.com page when it has one (featured servers only, so far) |
| `mcp_server_changes` | `url_or_name`, optional `since` (`YYYY-MM-DD` or a UTC time) | The kept changes, newest first: added, removed, which fields changed, tools now guessed to do more. Each with its "seen between" window, plus how often the server was checked |

Both have a `title`, `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, a strict `inputSchema` and an `outputSchema`. Each answer comes back as `structuredContent` and as the same JSON in one text item, with a `status`: `found`, `several_matches`, `not_tracked` or `no_data`.

`url_or_name` can be:

- an https address. It must pass the crawl's own rule, imported from `src/registry.ts` (`scannableAddress`): https, no login in the address, no bare IP address or private host name. The address is matched with and without a trailing slash;
- a registry name (`io.github.owner/server`), the part after its slash (`server`), or a featured server's id or name (`aave`, `Hugging Face`). Case does not matter. A name several servers share returns up to 10 of them, and the model is asked to come back with an address.

Bad input (a plain-http or private address, odd characters, an extra argument, a `since` that is not a date) is a tool error (`isError: true`) that says what is allowed, so the model can retry. An unknown tool is a JSON-RPC `-32602`.

### Wording rules

- Every answer carries `labels_note`: the labels are machine guesses, with their accuracy. The accuracy comes from one constant, `LABEL_ACCURACY` in `src/config.ts`, set to "accuracy not yet measured" until SD-110's number is agreed.
- Every sentence is written by the connector from counts and dates. Tool and registry names (the servers' publishers' words) appear only as values in their own fields, never inside a sentence, and the server instructions tell the model to treat them as identifiers, never as instructions. The data holds no descriptions or schemas at all, only fingerprints, and the build drops those too. Names that do not look like identifiers are dropped at build time and counted (`names_not_shown`).
- No tool description, title or result promotes Stackduke; a test checks the descriptions. The only Stackduke addresses in answers are a featured server's page and the scanner's npm package in the local command.
- The local command includes the address only when it is made of characters no shell treats specially (no query string, quotes, `&`, `$` or `%`); otherwise it shows a placeholder. So a copied command can only run the scanner, in any shell.

## Where the data comes from, and why

**Choice: built from the `data` branch at build time and deployed with the Worker as static assets.** `npm run build:data` reads the branch (`servers.json`, `endpoints.jsonl`, `feed.json` and the per-server tool lists) and writes 513 small files to `build/data/`:

- `meta.json`: when the tracker made the data, counts, and the catalog's forbidden sites and unpublished servers;
- `s/<xx>.json`: the servers whose id starts with `<xx>`, where the id is the tracker's own (the first 12 hex characters of the sha256 of the address), so an address finds its file without any index;
- `n/<xx>.json`: names to server ids, filed by the sha256 of the name.

Each lookup reads one or two files of about 65 KB (the largest is 140 KB), cached per Worker instance.

Why not the alternatives:

- **Bundling one JSON file into the script.** Measured on 1 November: server summaries, tool lists and change history come to about 16 MB (3.2 MB gzipped). Workers now allow it, but the whole file would be parsed on every cold start, near the 128 MB memory limit, to answer one lookup, and the free plan allows 10 ms of CPU per request. The shards cost a few milliseconds and little memory however large the registry grows.
- **Fetching from a published URL** (as Radar does from raw.githubusercontent.com). That is GitHub's endpoint, not Stackduke's, which the Claude directory rule is about, and it needs a fetch of megabytes per cold start or a new per-server publishing job in Track. A Stackduke-owned copy (R2 on `data.stackduke.com`) would work, but needs a bucket, a token and DNS for no gain over assets.

**The cost of this choice:** the data is only as fresh as the last deploy. The tracker runs once a day, so the Worker should be rebuilt and deployed once a day after Track (see "Deploying"). Every answer carries `data_as_of`, and once the data is more than 36 hours old every summary says so.

Limits: 515 asset files against 20,000 on the free plan (100,000 paid), 25 MiB a file; the script itself is 29 KB.

## Unknown servers and the crawl queue

An unknown address that passes the crawl rule, and is not on a forbidden site or an unpublished catalog server, is recorded in the `CRAWL_QUEUE` KV namespace as `queue:<tracker id>` → `{"url", "queued_at"}`, with a 30-day expiry. Nothing about who asked is stored. On top of the crawl rule:

- **No addresses that may hold a key.** Hosted servers often carry the caller's key in the address, so an address with a query string, or with a path part that looks like a key or token, is never stored. The answer says so.
- **A queue limit per caller.** `QUEUE_LIMITER` allows 10 new addresses a minute per calling address, on top of the general limit. Past it, or if the store fails or is missing, the answer says the address could not be recorded right now. The answer itself still comes back. Claude and ChatGPT call from shared addresses, so a busy minute may record nothing; that only delays a request.
- **No hint about what others asked.** Asking about an address someone else already asked about gets the same answer as a first request.

**Not done here: Track does not read the queue yet.** So the answer says "recorded as a request for the tracker to look at; this lookup cannot say whether or when it will be checked", never "it will be checked tonight". The follow-up in Track needs a Cloudflare API token to list and delete `queue:*` keys. It should run each address through `scannableAddress` and `keptOffSites` again, refuse redirects as it does for registry addresses, and also check what the host resolves to: names such as `127.0.0.1.nip.io` pass the address rule and resolve to a private address. Before it reads the queue, it should also cap how many queued addresses one run takes.

## Forbidden and unpublished servers

- **Forbidden** (`tracker.forbidden: true` in `catalog/servers.json`: Sentry, Intercom, Airtable today). Their sites come from the tracker's own `keptOffSites()`. Any address on those sites, any registry name under their namespace (`io.sentry/...`), or their catalog id or name gets `status: "no_data"` with one fixed sentence, is never queued, and is dropped from the data at build time even if a stale branch held it.
- **Unpublished catalog servers** (tracked privately, or terms not read yet: GitHub, Linear, Stripe and the rest). Their exact catalog address, or their catalog id or name when no published server goes by it, gets the same `no_data` answer and is not queued. Other servers on the same sites are answered normally, as the tracker publishes them.

## Logging

One line per tool call, and nothing else: `{"event":"tool_call","client":"<name>","tool":"<tool>","at":"<time>"}`. Never the arguments. A test checks it.

The client's name comes from `clientInfo.name` at `initialize`. The server is stateless, so it hands the client a session id of the form `<name>~<random>` and reads the name back from the `Mcp-Session-Id` header that MCP clients must echo on later requests. The session id is not secret and grants nothing; a request without it is logged as `unknown`. Tested with the MCP Inspector, which logged as `inspector-cli`.

In `wrangler.jsonc`, Workers Logs is on so these lines are kept, and invocation logs are off (`observability.logs.invocation_logs: false`), so Cloudflare does not keep its automatic log entry for each request. Arguments travel in the request body, which is never logged. Unexpected errors are caught and logged as one fixed line (`lookup: internal error`), so the runtime does not log them with the request. **Check before writing the privacy policy:** which request details, if any, Workers Logs attaches to the Worker's own log lines. Radar avoids the question by turning observability off completely; this Worker needs it on to keep the per-call line. The rate limiters key on the caller's IP address inside Cloudflare and do not log it.

## Protocol

Streamable HTTP, `POST /mcp` only, answered with `application/json` (no event stream: `GET` and `DELETE` get 405). Protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`. Methods `initialize`, `ping`, `tools/list`, `tools/call`; notifications get 202. Bodies over 16 KiB get 413. `GET /health` and `GET /` answer small JSON; everything else is 404, including the data files, which are reachable only through the binding (`run_worker_first`). Rate limits: 300 requests a minute per calling address, as Radar, and 10 new queue entries a minute. The protocol handling is adapted from Radar's (`aethis-platform/apps/radar-mcp`).

## Running and testing locally

From the repository root (CI runs this as part of `npm run check`):

```bash
npm ci
npm run check:connector
```

The tests build the data from `test/fixtures/data/` (a hand-made data branch in the real shape) and run the Worker's fetch handler against it: found, unknown, forbidden, unpublished, bad input, changes, the queue rules, logging, and that server-written names never reach a sentence.

In the real Workers runtime, against the real data:

```bash
cd connector
npm install
git fetch origin data
npm run build:data
npm run dev        # wrangler dev --local on http://localhost:8799
```

Then the MCP Inspector (2.11.0 was used on 1 November 2026):

```bash
npx -y @modelcontextprotocol/inspector@2.11.0 --cli http://localhost:8799/mcp --transport http --method tools/list
npx -y @modelcontextprotocol/inspector@2.11.0 --cli http://localhost:8799/mcp --transport http \
  --method tools/call --tool-name check_mcp_server --tool-arg url_or_name=https://mcp.aave.com/
```

Leave out `--cli` for the browser UI: choose "Streamable HTTP" and `http://localhost:8799/mcp`.

## Deploying (needs Dom's go)

Nothing below has been done.

1. **Address.** Pick one, for example `lookup.stackduke.com` (not `mcp.stackduke.com`, the gateway, or `radar.stackduke.com`), and uncomment `routes` in `wrangler.jsonc`. `custom_domain: true` makes Cloudflare create the DNS record.
2. **Queue.** `npx wrangler kv namespace create CRAWL_QUEUE`, then put its id in `wrangler.jsonc` in place of the placeholder. Deploying fails until then, on purpose.
3. **Account.** Add `account_id` to `wrangler.jsonc` (Radar uses the Aethis account).
4. **Deploy.** `npm run build:data && npx wrangler deploy`, then run the Inspector commands above against the new address and add it to Claude as a custom connector to check it there.
5. **Daily refresh.** Add a job to `track.yml` after Track commits: `cd connector && npm ci && npm run build:data && npx wrangler deploy`, with a Cloudflare API token limited to this Worker as a repository secret. Without it, answers age and start saying so after 36 hours.
6. **Rollback.** `npx wrangler rollback`, or `npx wrangler delete`. Nothing depends on this Worker.

Before a directory listing (SD-113): a docs page, a privacy-policy section covering the log line above and what Cloudflare processes, a support address, and the golden prompts.
