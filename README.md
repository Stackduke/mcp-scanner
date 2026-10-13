# Aethis MCP scanner

A first version, built on 2026-10-13. It answers one question about an MCP server: **what does it let an agent do, and what changed since last time?**

It is a prototype for the observation side of Aethis. It is not connected to the Aethis console or backend, and nothing here enforces anything.

## What it does

- **Lists a server's tools** over the Streamable HTTP transport: the handshake, then `tools/list`. It never calls a tool and sends no credentials.
- **Labels each tool** in the console's vocabulary: Read, Write, Send, Money, Destructive, and "broad" for a free-form target such as SQL or a shell command. A label comes from the server's own annotations when it gives them, and otherwise is a guess from the words in the tool's name, or failing that the first sentence of its description. The report marks every guess and shows the words it rests on. The guess leans one way on purpose: a word that says the tool changes something outranks a word that says it reads.
- **Checks the text a model would read** (names, descriptions, titles and every string in the input and output schemas) for signs of tool poisoning: instructions aimed at the model, invisible characters, pointers at credential stores, requests to send data elsewhere, and a tool whose annotations contradict its name.
- **Compares two snapshots**: tools added, removed and changed; for each changed field, whether it appeared, disappeared or was rewritten; capabilities that widened; rewritten descriptions shown before and after; and new text findings.
- **Reads a project's published definitions at a tag**, for projects that keep them as files, so a release history can be compared without running the server or signing in.

## What it does not do

- It cannot scan a server that wants a sign-in. On 2026-10-13 that was every well-known business server tried: GitHub, Linear, Notion, Stripe, Sentry, Atlassian, Supabase, PayPal, Vercel and Intercom all answered 401.
- It does not run MCP server packages. Scanning a server that ships as an npm or PyPI package would mean running third-party code, which needs a sandbox and a decision.
- The text checks are pattern checks. They find text worth a person's attention. They cannot tell intent, they will flag some honest descriptions, and careful wording gets past them. "Nothing matched" is not "safe".
- A label guessed from a name can be wrong, in either direction. Where no word clearly says what the tool does, no guess is made.
- It refuses a tool list it cannot read to the end (more than 50 pages, or a reply over 4 MB), because a partial list would look like removed tools in the next comparison.
- It does not read a server's `instructions` field, and it reports a server that holds its reply open, or redirects, as unreachable.
- Everything a server sends is printed with control and invisible characters replaced by visible markers, so a server cannot redraw the terminal or forge a line of the report.
- It knows nothing about what a tool does when called, how often it is called, or by whom.

## Use

Node 22.18 or later. No runtime dependencies.

```sh
npm install
npm run scan -- scan https://huggingface.co/mcp
npm run scan -- scan https://huggingface.co/mcp --save
npm run scan -- diff data/snapshots/<a>.json data/snapshots/<b>.json
npm run scan -- history github/github-mcp-server v1.14.0 v2.0.0
npm run check
```

`--save` writes the snapshot under `data/snapshots/<source>/`, which is ignored by git. No credential is ever sent to an MCP server. `history` makes one request to GitHub's API per tag, unauthenticated unless `GITHUB_TOKEN` is set, in which case the token goes to `api.github.com` only.

## What the first look found (2026-10-13)

Numbers from one afternoon. They describe the samples below and nothing wider.

- **How many servers can be scanned without signing in.** The official MCP registry was read up to its first 3,000 entries (it stopped answering after that, so the count of all entries is not known). 2,750 of those list a remote endpoint. Of 60 endpoints sampled at random, one per domain, 22 listed their tools without a sign-in, 30 asked for one, and 8 failed in other ways.
- **What a tool list contains.** Across those 22 servers: 198 tools, a median description of 235 characters, none empty, and 151 of 198 with annotations. So there is enough text to label and to check.
- **How good the name-based guess is.** Measured against servers' own `readOnlyHint` on 353 real tools. On the open sample (156 tools with the hint) the name agreed on 104, disagreed on 5 and gave no guess on 47. Two of the five were in the direction that matters: tools their server says write, whose names read as reading. On GitHub's server (134 with the hint) it agreed on 130, disagreed on none and gave no guess on 4.
- **GitHub's MCP server, v1.14.0 to v2.0.0.** 123 of 131 tool definitions changed, but "changed" needs reading with care: 75 of them only gained an output schema, which none had before. The other 48 also had their input schema rewritten. No description was rewritten. Ten new definition files appeared, each a variant of an existing tool. An earlier note put the figure at 124 of 131; this method gives 123.
- **Text findings on real servers.** None of the poisoning rules fired on the 353 tools. Three tools were marked read-only against their names (for example `create_checkout_link`), and one description on GitHub's server refers the model to another of its own tools, which is ordinary. That is the expected result on ordinary servers, and it means the poisoning rules are so far proven only against written examples in the tests.

## Review

One independent review was run on the first draft. It confirmed that the scanner calls no tool, sends no credential to a server and writes only under `data/snapshots/`. It also found real faults, all fixed before the first commit: tools that change or delete things could be labelled Read, a partial tool list was reported as complete, the comparison could not tell a field that appeared from one that was rewritten, and untrusted text could reach the terminal unescaped. The fixes have tests; they have not had a second review.

## Others doing this

Invariant Labs' `mcp-scan` (now part of Snyk) already scans a developer's local MCP configuration for poisoned descriptions and pins tool definitions by hash to catch later changes. This scanner is not a better version of that. The difference Aethis is aiming at is elsewhere: a hosted, continuous view across an organisation's agents, in plain language, tied to what each agent is allowed to do.

## Layout

- `src/client.ts`: the handshake and the tool list.
- `src/snapshot.ts`, `src/diff.ts`: fingerprints, snapshots and the comparison.
- `src/risk.ts`: capability labels.
- `src/findings.ts`: the text checks.
- `src/sources/github-snapshots.ts`: definitions a repository publishes as files.
- `src/text.ts`: making untrusted text safe to print.
- `src/report.ts`, `src/cli.ts`: the text report and the commands.
- `test/`: 48 tests, none of which touch the network.
