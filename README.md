# Stackduke MCP scanner

Lists the tools an MCP server offers, labels what each one lets an agent do, and reports what changed since the last look. It never calls a tool.

It also runs the public **MCP tool-change tracker** at [stackduke.com/tracker](https://stackduke.com/tracker): once a day it reads the [official MCP registry](https://registry.modelcontextprotocol.io), lists the tools of every remote server it can reach, and records what changed. The results are committed to this repository's [`data` branch](../../tree/data), so its history is the history of every change seen.

MIT licensed. TypeScript on Node 22.18 or later, run directly with `node`, with no runtime dependencies.

## Why

A connected MCP server can change what an agent can do without anyone on the agent's side changing anything. A tool that only read yesterday can delete today, and a description, which the model reads as part of its instructions, can be rewritten. This scanner makes those changes visible.

## What it does

- **Lists a server's tools** over the Streamable HTTP transport: the handshake, then `tools/list`. It never calls a tool. It sends no credential to an open server. For a server that needs a sign-in it can send a token, under the rules in [Signed-in servers](#signed-in-servers).
- **Labels each tool**: read, write, send, money, destructive, and "broad" for a free-form target such as SQL or a shell command. A label comes from the server's own annotations when it gives them. Otherwise it is a guess from the words in the tool's name, or failing that from the first sentence of its description, and the report marks the guess and shows the words it rests on.
- **Checks the text a model would read** for signs of tool poisoning: instructions aimed at the model, invisible characters, pointers to credential stores, requests to send data elsewhere, and annotations that contradict a tool's name.
- **Compares two looks**: tools added, removed and changed; for each changed field, whether it appeared, disappeared or was rewritten; and tools now counted as able to do more.
- **Says what a server lets an agent do, in plain words**, for a reader who is not an engineer, and writes a weekly digest of changes. See [docs/reports.md](docs/reports.md).

## What it does not do

- It does not run MCP server packages from npm, PyPI or Docker. Scanning those would mean running third-party code, which needs a sandbox.
- It cannot sign in through a browser. A server that takes only a browser sign-in cannot be scanned.
- The text checks are pattern checks. They find text worth a person's attention; they cannot tell intent, they flag some honest descriptions, and careful wording gets past them. "Nothing matched" does not mean "safe".
- A label guessed from a name can be wrong in either direction. Names are read as English words split at underscores, hyphens and capitals, so `rm_user` or `supprimer_compte` is not understood. Wherever the server's label, the name and the description disagree, the scanner goes with whichever says most.
- A scan sees one moment. A change made and undone between two looks is not seen.
- It refuses a tool list it cannot read to the end (more than 50 pages, or a reply over 4 MB), because a partial list would look like removed tools in the next comparison. It reports a server that redirects or holds its reply open as unreachable.
- Everything a server sends is data, never instructions. In a terminal it is printed with control and invisible characters made visible. In the reports and the tracker, a server's descriptions are never quoted: only tool names appear, as identifiers.

## Use

```sh
npm install
npm run scan -- scan https://huggingface.co/mcp
npm run scan -- scan https://huggingface.co/mcp --save
STACKDUKE_SCAN_GITHUB_TOKEN=$(gh auth token) npm run scan -- signed-in github --save
npm run scan -- diff data/snapshots/<a>.json data/snapshots/<b>.json
npm run scan -- authority data/snapshots/<a>.json [more.json ...]
npm run scan -- digest data/snapshots/<server-folder> [more folders ...] --days=7
npm run scan -- history github/github-mcp-server v1.14.0 v2.0.0
npm run track -- --data=tracker-data --max-checks=200
npm run scan -- discover https://mcp.linear.app/mcp
npm run scan -- catalog
npm run scan -- try-sign-in https://mcp.notion.com/mcp
npm run check
```

`--save` writes a snapshot under `data/snapshots/<source>/`, which git ignores. `history` reads the tool definitions a project publishes as files at two tags, one request to GitHub's API per tag, sending `GITHUB_TOKEN` to `api.github.com` only if it is set.

## The tracker

`track` is one run of the public tracker over a data folder. [`.github/workflows/track.yml`](.github/workflows/track.yml) runs it every day at 04:17 UTC and commits the folder to the `data` branch.

**Which servers.** Every Streamable HTTP endpoint (at most 5 per entry) in the latest version of each registry entry, as long as it is a plain `https` address: no `{placeholders}`, no login in the address, and no bare IP address or private host name. A public name that resolves to a private address is not caught; https and refused redirects are what limit that. The registry is read to the end each run. An endpoint that leaves the registry is looked at for 7 more days, then no longer. A read that stops early removes nothing, and `registry.json` records whether the last attempt succeeded.

**How often, and how politely.**

- Endpoints that listed tools last time are looked at daily. New endpoints come next. Endpoints that asked for a sign-in, failed, or answered in a way the scanner cannot use rest for 4 to 10 days, spread by address.
- At most 48 checks run at once, never two on one host. Checks on one host start at least a second apart, no host gets more than 30 checks in a run, and no site (a domain and its subdomains; on shared hosting such as `workers.dev` or Cloud Run, each host is its own site) more than 150. A run stops starting checks after 55 minutes, and the oldest-checked endpoints go first next time.
- A list with more than 2,000 tools, a tool name over 256 characters, more than 8 MB in all, or a definition the scanner cannot process counts as "not usable" for that server; the run goes on.
- Each request times out after 15 seconds. The scanner identifies itself as `stackduke-mcp-scanner/0.2 (+https://stackduke.com/tracker)`. To have an endpoint left out, open an issue.

**What is kept** (in the `data` branch):

| Path | What |
| --- | --- |
| `endpoints.jsonl` | Every endpoint: registry names, its last 40 checks and their outcomes, its last 10 changes (each naming at most 20 tools per list, with full counts). |
| `lists/` | The latest tool list of each endpoint as fingerprints: each tool's name, what it is counted as doing, and a hash of each field. Rewritten only when something changes. |
| `watched/` | The full definitions from servers scanned with a token, rewritten only when they change. |
| `feed.json` | What the web page reads: coverage, the servers watched with a token, and the latest change on each server that changed in the last 30 days (at most 300, within 1 MB, with the total), with how many checks in those 30 days listed tools. |
| `servers.json` | Every endpoint that listed tools, with its counts and the same 30-day coverage. |
| `lookup.json` | The same endpoints, cut down for a web page to search. |

The `data` branch must exist before the first run; the workflow checks it out.

The feed also adds up what servers say about their own tools: how many are marked read-only, marked destructive, marked as changing things, or carry no such label. Those are the servers' claims, so they can be added up; the scanner's own cautious reading (which counts a tool as able to do the most its name, label or description suggests) is given per server and is not added up, because it overcounts on purpose.

Full definitions are kept only for the servers watched with a token. For the rest, the fingerprints say which tools and which fields changed. For the old wording itself, look at the server.

**How a change is described.** Each change carries two times: the scan that saw it, and the last scan before it that listed tools. The change happened somewhere between them. Failed checks in between are kept, so the page can show which stretches were not watched. A change is a change in what the server sent: the fingerprints cover names and fields, not the scanner's reading of them, so an update to the scanner's rules is not reported as a change to a server. The same rules as the plain-language report apply: each tool is read the more serious way; a count is given only for kinds that have tools, never as 0; nothing says a server is safe or lists what it cannot do; a server's name for itself is not published; and the summary is written by the scanner, with tool names as the only words of the server's in it. Results of the text checks are not published. A finding goes to a person first, so that a vendor can be told privately.

## The catalog

[`catalog/servers.json`](catalog/servers.json) lists the servers Stackduke supports officially: name, address, category (Developer tools, Payments, Data and infrastructure, Work apps), how a customer signs in, when that and the vendor's terms were last checked, and whether the tracker may publish anything about it. A reviewed copy goes into the Stackduke dashboard, for its list of servers to connect. The file is checked when it is loaded, and a mistake in it stops the scanner: an address must be plain https, ids are used once, each token variable is named after its server, and a server is published only once someone has read its terms. Where a vendor's terms forbid publishing about its service, the entry is marked `forbidden`, and no address on that vendor's sites is checked or kept, wherever the registry lists it. Sentry and Intercom are marked so. Other servers kept off only until their terms are read, or until the tracker can sign in to them, are still listed from the registry like any other address.

To add a server, run `npm run scan -- discover <url>`. It asks the server how it signs in, sending no credential, and prints what its `signIn` should be:

- `oauth-metadata-doc`: standard OAuth, and it takes Stackduke's client metadata document as a client ID.
- `oauth-dcr`: standard OAuth with automatic client registration.
- `oauth-app`: standard OAuth, but Stackduke must register an app with the vendor first (GitHub today).
- `api-key`: it wants a login but says nothing about OAuth.

Then add an entry and run `npm run check`. `npm run scan -- catalog` asks every server in the file again and says where an answer no longer matches it.

## Signing in

[`src/oauth.ts`](src/oauth.ts) signs in to an MCP server the standard way, the MCP authorization spec of 2025-11-25, with no code for any one vendor. It reads the server's 401, its description and its sign-in server's description, including the older way some servers still use (Atlassian). It registers with an app made in advance (used only with the exact sign-in server it was made for, so its secret cannot be sent elsewhere), a client metadata document or automatic registration, in that order, and signs in with PKCE (S256 only) and the `resource` parameter. Then it swaps the code for tokens and renews them, keeping the new refresh token each time. Every address must be https, nothing is sent when certificate checking is switched off, no request follows a redirect, replies are read only up to a limit, and an error passes on the server's error code but never its own words.

`npm run scan -- try-sign-in <url>` proves a sign-in works. It prints the vendor's sign-in page, the person approves in any browser and pastes back the address the browser lands on, and the scanner lists the server's tools once with the new token. The tokens are never printed or saved and are dropped at the end. `--scopes="a b"` asks for fewer scopes than the server suggests, such as read-only ones. It uses automatic registration only: Stackduke has no client metadata document published yet, nor an app registered with GitHub, so GitHub stops before the browser. Nothing keeps these tokens yet: that comes with the tracker job for servers that take only a browser sign-in.

## Signed-in servers

Big vendors' servers ask for a sign-in, so the tracker watches them with tokens from accounts made for the purpose, holding nothing of value. The servers it may send a token to are the catalog's published servers with a key, built in [`src/signed-in.ts`](src/signed-in.ts): GitHub, Linear, Stripe (sandbox) and Supabase so far.

- A token is read from an environment variable (`STACKDUKE_SCAN_<VENDOR>_TOKEN`), never from an argument, and is sent only to that vendor's fixed address. `scan <url>` cannot send one. The older name `AETHIS_SCAN_GITHUB_TOKEN` is still read.
- It is sent over https only, not at all if certificate checking is switched off, and redirects are refused. It is never printed, saved or included in an error. If a server sends the token back, nothing from that reply is kept.
- The list that comes back is what that token may see, so one token per server is kept for a series of scans. The full definitions are published under `watched/`, so the account behind a token should hold nothing of its own. The check that a server did not send the token back catches the exact token only.
- `npm run scan -- connect` adds tokens to the tracker in one sitting. For each vendor it says where to make the token and what to make, asks for it at a hidden prompt, checks that the vendor's server lists its tools with it, and stores it as a repository secret with `gh secret set`, passing it on standard input. Run it at a terminal signed in to `gh` with admin rights on the repository.

## Layout

- `src/client.ts`: the handshake and the tool list.
- `src/snapshot.ts`, `src/diff.ts`, `src/files.ts`: fingerprints, snapshots, comparisons, and reading and writing them.
- `src/risk.ts`: capability labels. `src/findings.ts`: the text checks. `src/text.ts`: making untrusted text safe to print.
- `src/authority.ts`, `src/digest.ts`, `src/report.ts`: the plain-language report, the weekly digest and the technical report.
- `src/registry.ts`, `src/tracker.ts`, `src/crawl.ts`, `src/track.ts`: the tracker: reading the registry, planning and recording checks, running them politely, and one run end to end.
- `catalog/servers.json`, `src/catalog.ts`: the servers supported officially, and checking the file.
- `src/oauth.ts`, `src/try-sign-in.ts`: signing in the standard way, and a test sign-in.
- `src/signed-in.ts`, `src/connect.ts`: the servers a token may be sent to, and adding tokens.
- `src/sources/github-snapshots.ts`: definitions a repository publishes as files.
- `src/cli.ts`: the commands. `test/`: the tests, none of which touches the network.
- `docs/`: [the reports](docs/reports.md) and [what the first look found](docs/first-look.md).

## Others doing this

Invariant Labs' `mcp-scan` (now part of Snyk) scans a developer's local MCP configuration for poisoned descriptions and pins tool definitions by hash to catch later changes. This scanner does something similar for remote servers. The tracker's difference is that it watches the whole public registry continuously and in the open.

## Licence

[MIT](LICENSE).
