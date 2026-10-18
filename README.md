# Stackduke MCP scanner

Lists the tools an MCP server offers, labels what each one lets an agent do, and reports what changed since the last look. It never calls a tool.

It also runs the public **MCP tool-change tracker** at [stackduke.com/tracker](https://stackduke.com/tracker): once a day it reads the [official MCP registry](https://registry.modelcontextprotocol.io), lists the tools of every remote server it can reach, and records what changed. The results are committed to this repository's [`data` branch](../../tree/data), so its history is the history of every change seen.

MIT licensed. TypeScript on Node 22.18 or later, run directly with `node`, with no runtime dependencies.

## Why

A connected MCP server can change what an agent can do without anyone on the agent's side changing anything. A tool that only read yesterday can delete today, and a description, which the model reads as part of its instructions, can be rewritten. This scanner makes those changes visible.

## What it does

- **Lists a server's tools** over the Streamable HTTP transport, or over standard input and output for a server that runs as a local program: the handshake, then `tools/list`. It never calls a tool. It sends no credential to an open server. For a server that needs a sign-in it can send a token, under the rules in [Signed-in servers](#signed-in-servers).
- **Labels each tool**: read, write, send, money, destructive, and "broad" for a free-form target such as SQL or a shell command. A label comes from the server's own annotations when it gives them. Otherwise it is a guess from the words in the tool's name, or failing that from the first sentence of its description, and the report marks the guess and shows the words it rests on.
- **Checks the text a model would read** for signs of tool poisoning: instructions aimed at the model, invisible characters, pointers to credential stores, requests to send data elsewhere, and annotations that contradict a tool's name.
- **Compares two looks**: tools added, removed and changed; for each changed field, whether it appeared, disappeared or was rewritten; and tools now counted as able to do more.
- **Says what a server lets an agent do, in plain words**, for a reader who is not an engineer, and writes a weekly digest of changes. See [docs/reports.md](docs/reports.md).
- **Checks a server before it ships**: in a repository's own CI, its tools are compared with an approved list kept beside its code, `stackduke.lock.json`, and the pull request fails until a person approves a change. See [Pre-deploy check](#pre-deploy-check).

## What it does not do

- The tracker and `scan` do not run MCP server packages from npm, PyPI or Docker. Scanning those would mean running third-party code, which needs a sandbox. `check` starts a local program only when given its command, in the pipeline of the person who chose it.
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
npm run scan -- check --lockfile=examples/sample-server/stackduke.lock.json -- node examples/sample-server/server.ts
npm run check
```

`npm run check` runs this repository's typecheck and tests. The pre-deploy check is the `check` command, `npm run scan -- check`.

`--save` writes a snapshot under `data/snapshots/<source>/`, which git ignores. `history` reads the tool definitions a project publishes as files at two tags, one request to GitHub's API per tag, sending `GITHUB_TOKEN` to `api.github.com` only if it is set.

## Pre-deploy check

Added on 2026-10-17. `check` works like a lockfile for an MCP server's tools. The approved tool list is kept in the server's repository as `stackduke.lock.json`, and the check runs in that repository's own CI (GitHub Actions or GitLab), on its own runners. Nothing is sent to Stackduke.

A pull request that changes what the server offers then shows the change twice: as a failed check with a summary of what changed, and, once approved, as a diff of the lockfile that reviewers read like any other code.

### What fails the check

The check exits with code 1 when:

- a tool was added, removed or changed and the lockfile was not updated. "Changed" covers the six fields the scanner reads: name, title, description, input schema, output schema and annotations. `_meta` and `icons` are not compared. A renamed tool counts as one removed and one added;
- a tool name is listed more than once, since only the first definition could be compared;
- a tool's text trips a high or medium text check, the same checks the scanner uses everywhere (instructions aimed at the model, invisible characters, pointers to credential stores, requests to send data elsewhere, annotations that contradict the name, and so on). Low findings are listed as notes and never fail it;
- a tool counted as able to change things, or one whose name says nothing the scanner understands, carries no risk annotation: neither `readOnlyHint` nor `destructiveHint`. Either one is enough, because without `destructiveHint` the protocol already says to assume a tool may destroy. A tool counted as only reading needs neither.

There is no lockfile yet, the server cannot be listed, or the arguments are wrong: those fail too, with exit code 1, 4 (3 when the server asks for a sign-in) and 2.

### Approving a change

After a person has reviewed the change, run the same check with `--update` and commit the lockfile it writes:

```sh
npx @stackduke/mcp-scanner check --update -- node dist/server.js
```

`--update` writes nothing while a finding nobody has accepted is present, so approving a tool change does not also approve, in passing, a description that tells the model to ignore its instructions. A finding that a person has checked and judged a false alarm is approved with `--update --accept-findings`. It is recorded under that tool's `accepted` in the lockfile, as `rule@where`, where reviewers see it in the diff, and it counts only while that tool's definition stays exactly the same.

The lockfile is written to be read in a diff: tools sorted by name, each tool's fields in a fixed order, keys inside schemas sorted, one field to a line, and no timestamp, so the same tools always give the same bytes. It is read strictly: a field the scanner does not know, at the top or in a tool, a repeated tool or a wrong version stops the check instead of being skipped. See [`examples/sample-server/stackduke.lock.json`](examples/sample-server/stackduke.lock.json).

### Running it

```sh
# A server that runs as a local program, speaking MCP over standard input and output:
npx @stackduke/mcp-scanner check -- node dist/server.js
npx @stackduke/mcp-scanner check --command="node dist/server.js --stdio"

# A server at a web address: https, or http on this machine for one started earlier in the job:
npx @stackduke/mcp-scanner check http://localhost:3000/mcp

# Options:
#   --lockfile=stackduke.lock.json   where the approved list is
#   --summary=check.md               also write the Markdown summary to a file
#   --timeout=60                     seconds to wait for each reply (default 60 for a program, 15 for an address)
#   --update [--accept-findings]     approve the current tools, see above
```

Everything after `--` is the program and its arguments, passed as they are. `--command` takes the same as one line, split the way a shell splits plain words and quotes, with no variables, globs, pipes or redirection; it is what the GitHub Action uses.

The package is [`@stackduke/mcp-scanner`](https://www.npmjs.com/package/@stackduke/mcp-scanner) on npm, and installs a command named `stackduke-mcp-scanner`. It needs Node 22.18 or later. It can also run from a copy of this repository: `git clone --depth 1 https://github.com/Stackduke/mcp-scanner`, then `node mcp-scanner/src/cli.ts check ...`. The npm package is built to JavaScript with `npm run build` (run by `npm pack` and `npm publish`), because Node does not run TypeScript from inside `node_modules`.

The summary is Markdown, written to standard output and, with `--summary`, to a file: what changed, what failed, and how to approve. Lists stop at 30 rows and the whole summary at 60,000 characters, so it fits in a comment; the lockfile's diff has everything. The `--update` example in the summary names the command as `stackduke-mcp-scanner`, not `npx`, so a reader who copies it runs the copy they already use rather than whatever an npm name resolves to. It follows the plain-language report's rules. Every sentence is the scanner's, tool names appear only as identifiers in code spans, a server's descriptions are never quoted, and a server is named only by its host or as "the local program given". The command is never shown or stored, since its arguments may hold a secret. When a program fails to start, the end of its error output is printed in the job log, each line marked `program stderr |`, and kept out of the summary.

### GitHub Actions

This repository is also a GitHub Action ([`action.yml`](action.yml)). It runs the check, writes the summary to the job summary, and fails the job when the check fails:

```yaml
name: MCP tools
on: pull_request

permissions:
  contents: read
  pull-requests: write # only for comment: "true"

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false # keeps the job's token off the disk the server's program can read
      - run: npm ci && npm run build
      - uses: Stackduke/mcp-scanner@v0 # or a release such as @v0.3.0, or a commit
        with:
          command: node dist/server.js
          comment: "true"
```

Inputs: `url` or `command` (one of them), `lockfile` (default `stackduke.lock.json`), `working-directory`, `timeout`, `comment` (default `"false"`) and `github-token` (default: the job's own token). The output `result` is `passed`, `failed` or `error`.

- `@v0` follows the latest 0.x release; `@v0.3.0` stays fixed.
- The action runs the scanner from its own copy with Node 22.18 or later, and sets up Node 22 only when the runner has nothing recent enough.
- With `comment: "true"` it posts the summary on the pull request and updates that one comment on later runs, one comment for each lockfile. The default token is enough, given `pull-requests: write`. On a pull request from a fork that token can only read, so the comment fails; the job summary is still written and the check still decides the job.
- The token is in the environment of the comment step only. The scanner also starts the server's program without GitHub's workflow command files (`GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY`), so it cannot set variables or a PATH for the later step that holds the token, and without the runner's own tokens, `GITHUB_TOKEN` and `GH_TOKEN` (and in GitLab, `CI_JOB_TOKEN` and the registry and deploy passwords). This narrows what the program can reach; it is not a sandbox. The program runs as the same user on the same machine, as the build step before it did.
- Do not run the check on `pull_request_target` to get comments on pull requests from forks. That event gives a pull request's code a token that can write, and this action runs that code.
- [`.github/workflows/action-test.yml`](.github/workflows/action-test.yml) runs the action against the sample server, once where it must pass and once where it must fail.

### GitLab CI

```yaml
mcp-tools:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - npm ci && npm run build
    - npx --yes @stackduke/mcp-scanner@0.3 check --summary=mcp-tools.md -- node dist/server.js
    # Or from a copy of the repository:
    # - git clone --depth 1 https://github.com/Stackduke/mcp-scanner /tmp/mcp-scanner
    # - node /tmp/mcp-scanner/src/cli.ts check --summary=mcp-tools.md -- node dist/server.js
  artifacts:
    when: always
    paths: [mcp-tools.md]
```

The job fails when the check does, and blocks the merge request when the project requires pipelines to pass. The summary is kept as an artifact; posting it as a merge-request note is not built.

### Try it on the sample server

[`examples/sample-server/server.ts`](examples/sample-server/server.ts) is a small MCP server that runs as a local program and offers three note-taking tools. `SAMPLE_SERVER_VARIANT=changed` rewrites a description and adds a tool with no risk annotation; `SAMPLE_SERVER_VARIANT=poisoned` plants an instruction in a description.

```sh
npm run scan -- check --lockfile=examples/sample-server/stackduke.lock.json -- node examples/sample-server/server.ts
SAMPLE_SERVER_VARIANT=changed npm run scan -- check --lockfile=examples/sample-server/stackduke.lock.json -- node examples/sample-server/server.ts
```

The first passes. The second fails, naming the new tool, the rewritten description and the missing annotation.

### Limits

- `check` runs the program it is given, with the environment of the job less the CI files and tokens listed above, as any build step does. Give it only a server you would run anyway.
- It makes changes visible to reviewers; it does not stop someone who means harm. The author of a pull request controls the server's code, so they can make it list whatever they like during the check, and they can edit the lockfile in the same pull request. Both show in the diff, which is what the check is for.
- It sends no credential. A server at an address that asks for a sign-in stops the check with exit code 3. A local program gets whatever the job's environment holds, as it would anywhere else.
- It sees the tools a server lists at start-up with the configuration the job gives it. Tools that a server adds later, or only for some accounts or settings, are not seen.
- The text checks are pattern checks, and a label guessed from a name can be wrong. A pass means nothing changed and nothing matched, not that the server is safe.
- One lockfile holds one server. A repository with several runs the check once for each, with `--lockfile`.
- If the job is cancelled while the server's program runs, the program is left to the runner to stop.
- The optional upload of results to the Stackduke dashboard is not part of this.

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

**The private notice.** After each scan, `notice` runs the text checks on the servers watched with a token and sends what is new since the last run to Stackduke's own endpoint, which tells Stackduke's maintainer alone. New means a tool, rule and place not flagged in the copy of `watched/` taken before the scan; low findings are left out, as in `review`, and at most 50 go per vendor, with a count of the rest. What it sends: the vendor's id, the scan's time, and for each finding the tool's name and the place, both cut to identifier characters, with the rule, its severity and the scanner's own reason. What it does not send: any excerpt, description or other text the server wrote. The run's log is public, so the request is made on every run, empty or not, and the step prints only fixed lines (nothing on success, one line if it was not delivered or is not set up) and never fails the run. The address and token are the `STACKDUKE_NOTICE_URL` and `STACKDUKE_NOTICE_TOKEN` secrets, handed to that step only; the token goes over https only, never through a redirect, and is never printed.

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

`npm run scan -- try-sign-in <url>` proves a sign-in works. It prints the vendor's sign-in page, the person approves in any browser and pastes back the address the browser lands on, and the scanner lists the server's tools once with the new token. The tokens are never printed or saved and are dropped at the end. `--scopes="a b"` asks for fewer scopes than the server suggests, such as read-only ones. It uses automatic registration only: Stackduke has no client metadata document published yet, nor an app registered with GitHub, so GitHub stops before the browser. To keep a sign-in for the tracker, use `connect-oauth`, below.

## Signed-in servers

Big vendors' servers ask for a sign-in, so the tracker watches them with tokens from accounts made for the purpose, holding nothing of value. The servers it may send a token to are the catalog's published servers, built in [`src/signed-in.ts`](src/signed-in.ts): GitHub, Linear, Stripe (sandbox) and Supabase with a key, and Zapier, Contentful, Grafana and CircleCI with a browser sign-in.

- A token is read from an environment variable (`STACKDUKE_SCAN_<VENDOR>_TOKEN`), never from an argument, and is sent only to that vendor's fixed address. `scan <url>` cannot send one. The older name `AETHIS_SCAN_GITHUB_TOKEN` is still read.
- It is sent over https only, not at all if certificate checking is switched off, and redirects are refused. It is never printed, saved or included in an error. If a server sends the token back, nothing from that reply is kept.
- The list that comes back is what that token may see, so one token per server is kept for a series of scans. The full definitions are published under `watched/`, so the account behind a token should hold nothing of its own. The check that a server did not send the token back catches the exact token only.
- `npm run scan -- connect` adds tokens to the tracker in one sitting. For each vendor it says where to make the token and what to make, asks for it at a hidden prompt, checks that the vendor's server lists its tools with it, and stores it as a repository secret with `gh secret set`, passing it on standard input. Run it at a terminal signed in to `gh` with admin rights on the repository.

### Browser sign-ins

Most vendors' servers take only a browser sign-in (OAuth), and their tokens run out and change. The tracker keeps one for Airtable, Dropbox, Zapier, Contentful, Grafana and CircleCI, each with a dedicated account, `tracker+<vendor>@stackduke.com`. Zapier, Contentful, Grafana and CircleCI are published. Airtable and Dropbox are not: they are signed in and renewed every day, so each is ready the day it is cleared, and until then nothing they list is kept.

- `npm run scan -- connect-oauth <vendor>` signs in once (not while a Track run is under way, which could write back the sign-in it renewed over the new one), on any machine with `gh` signed in with admin rights on the repository. The client registers itself under the name "Stackduke tracker" and asks for the scopes in the catalog: read-only ones where the server offers them. A person approves in a browser and pastes back the address it lands on. The server must still name the sign-in server written in the catalog, or nothing is sent. The new sign-in is tested by listing the server's tools, then stored as one repository secret, `STACKDUKE_OAUTH_<VENDOR>`: the client, its tokens, and the address tokens are renewed at. It reaches `gh` on standard input and is never printed or written to a file.
- Each day, before the scan, the Track run renews every stored sign-in at the token address saved with it, never one the server names that day. Most vendors give a new refresh token each time and stop taking the old one, so the renewed sign-in is written back to its secret straight away, before anything uses it, with up to three tries. If one cannot be saved, the run renews no more that day, since the cause is likely the key or GitHub and each further renewal would lose another sign-in. The run's own token cannot write secrets, so the key for that comes from a GitHub App that may set this repository's secrets and do nothing else. It is made for that one step, and revoked when the job ends. Without the app, nothing is renewed, and a sign-in is used only until its access token runs out.
- The run's log is public, and GitHub hides a secret as a whole, not the tokens inside it, so each token and client secret is hidden on its own before anything could print it. The renewed access tokens reach the later steps in a folder outside the checkout that only the runner's user can read, deleted when the job ends.
- A separate step, holding no GitHub key, checks that each server answers with its renewed token, and keeps only whether it did. The scan step is handed the access tokens of published servers only.
- When a sign-in is lost (the vendor will not renew it, a renewed one could not be saved, the server refuses it, or it sent the token back), the server's check is recorded as missed, so the tracker shows it as not read, and the run opens an issue, "Sign-in needs renewing: <vendor>", with the command to sign in again. The issue closes itself after the next good read. A sign-in server that is down for a day is a missed check and no more, unless the access token has run out too. If the sign-in steps do not finish at all, one issue says so. If an issue cannot be opened, the run fails, so someone sees that nobody was told.

To set up the app once: in the Stackduke organisation's settings, make a GitHub App with no webhook and one repository permission, Secrets: read and write. Install it on `Stackduke/mcp-scanner` only. Put its client ID in the repository variable `STACKDUKE_SIGN_IN_APP_CLIENT_ID` and a private key in the secret `STACKDUKE_SIGN_IN_APP_KEY`.

To add a vendor: it must sign in with automatic registration (`oauth-dcr`). Give its catalog entry `access` of kind `oauth`, with its sign-in secret, issuer and read-only scopes, add its secret to the renew step in `.github/workflows/track.yml` (a test checks they match), and run `connect-oauth`. To publish it once its terms are read, set `publish: true` and `termsCheckedOn`.

## Layout

- `src/client.ts`, `src/stdio.ts`: the handshake and the tool list, over HTTP and over a local program's standard input and output.
- `src/check.ts`, `src/lockfile.ts`, `action.yml`: the pre-deploy check, its lockfile and its GitHub Action. `examples/sample-server/`: a small server to try it on.
- `src/snapshot.ts`, `src/diff.ts`, `src/files.ts`: fingerprints, snapshots, comparisons, and reading and writing them.
- `src/risk.ts`: capability labels. `src/findings.ts`: the text checks. `src/text.ts`: making untrusted text safe to print.
- `src/authority.ts`, `src/digest.ts`, `src/report.ts`: the plain-language report, the weekly digest and the technical report.
- `src/registry.ts`, `src/tracker.ts`, `src/crawl.ts`, `src/track.ts`: the tracker: reading the registry, planning and recording checks, running them politely, and one run end to end.
- `catalog/servers.json`, `src/catalog.ts`: the servers supported officially, and checking the file.
- `src/oauth.ts`, `src/try-sign-in.ts`: signing in the standard way, and a test sign-in.
- `src/signed-in.ts`, `src/connect.ts`: the servers a token may be sent to, and adding tokens.
- `src/connect-oauth.ts`, `src/sign-in-store.ts`, `src/renew.ts`, `src/sign-in-io.ts`: keeping browser sign-ins: adding one, how it is stored, and the daily run's renew, check and issue steps.
- `src/sources/github-snapshots.ts`: definitions a repository publishes as files.
- `src/cli.ts`: the commands. `test/`: the tests. None reaches another machine: the check's tests start the sample server as a program, and one serves it on 127.0.0.1.
- `docs/`: [the reports](docs/reports.md) and [what the first look found](docs/first-look.md).

## Others doing this

Invariant Labs' `mcp-scan` (now part of Snyk) scans a developer's local MCP configuration for poisoned descriptions and pins tool definitions by hash to catch later changes. This scanner does something similar for remote servers. The tracker's difference is that it watches the whole public registry continuously and in the open.

## Licence

[MIT](LICENSE).
