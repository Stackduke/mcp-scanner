# Aethis MCP scanner

A first version, built on 2026-10-13. It answers one question about an MCP server: **what does it let an agent do, and what changed since last time?**

It is a prototype for the observation side of Aethis. It is not connected to the Aethis console or backend, and nothing here enforces anything.

## What it does

- **Lists a server's tools** over the Streamable HTTP transport: the handshake, then `tools/list`. It never calls a tool. For an open server it sends no credential. For a server that wants a sign-in it can send a token, under the rules in "Signed-in servers" below.
- **Labels each tool** in the console's vocabulary: Read, Write, Send, Money, Destructive, and "broad" for a free-form target such as SQL or a shell command. A label comes from the server's own annotations when it gives them, and otherwise is a guess from the words in the tool's name, or failing that the first sentence of its description. The report marks every guess and shows the words it rests on. The guess leans one way on purpose: a word that says the tool changes something outranks a word that says it reads.
- **Checks the text a model would read** (names, descriptions, titles and every string in the input and output schemas) for signs of tool poisoning: instructions aimed at the model, invisible characters, pointers at credential stores, requests to send data elsewhere, and a tool whose annotations contradict its name.
- **Compares two snapshots**: tools added, removed and changed; for each changed field, whether it appeared, disappeared or was rewritten; capabilities that widened; rewritten descriptions shown before and after; and new text findings.
- **Says what a server lets an agent do, in plain words**, for a reader who is not an engineer. See "The plain-language report" below.
- **Reads a project's published definitions at a tag**, for projects that keep them as files, so a release history can be compared without running the server or signing in.

## What it does not do

- It cannot sign in through a browser. On 2026-10-13 every well-known business server tried (GitHub, Linear, Notion, Stripe, Sentry, Atlassian, Supabase, PayPal, Vercel and Intercom) answered 401 without a credential. A server that accepts a token can be scanned once it is added to `src/signed-in.ts`; so far that is GitHub only, first run with a real login on 2026-10-13. A server that only accepts a browser sign-in, as Notion's does, cannot be scanned.
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
AETHIS_SCAN_GITHUB_TOKEN=$(gh auth token) node src/cli.ts signed-in github --save
npm run scan -- diff data/snapshots/<a>.json data/snapshots/<b>.json
npm run scan -- authority data/snapshots/<a>.json [more.json ...]
npm run scan -- history github/github-mcp-server v1.14.0 v2.0.0
npm run check
```

`--save` writes the snapshot under `data/snapshots/<source>/`, which is ignored by git. `scan` sends no credential. `history` makes one request to GitHub's API per tag, unauthenticated unless `GITHUB_TOKEN` is set, in which case the token goes to `api.github.com` only.

## The plain-language report

Added on 2026-10-13. `authority` takes one or more saved snapshots and says what an agent connected to those servers can do: what it can read, change, send, spend and do irreversibly, most serious first, then what a misled or taken-over agent could do through the server, then how far to trust the report.

It is built on one requirement: it must never reassure wrongly. Two rules follow.

**It reads every tool the more serious way.**

- Where the server's label, a tool's name and its description disagree, the report goes with whichever says most, and lists the tool under "Worth a person's look" with the reason. A tool named `delete_account` that its server marks read-only is counted as destructive.
- A description, which the server writes, counts as evidence that a tool acts and never that it is harmless. A tool whose only sign of being harmless is its description is listed as unknown.
- A tool nobody can label is unknown and treated as able to change things. So is a tool whose name has unusual characters, or one of nine serious words such as "delete" run together with other letters, even when the server marks it read-only.
- A tool the server marks read-only whose name has no word the report understands (`paybill`, `supprimer_compte`) stays in the read list, because nothing contradicts the server, but it is starred and listed first, with a line saying it is there on the server's word alone.
- A change is called reversible only when a server that plainly says the tool writes also says it is not destructive, the report did not overrule that server on the same tool, and the tool neither sends nor moves money.

**It never says what a server cannot do.** A missing label proves nothing, so the report lists what it found and stops. Tools that only read are listed by name under "Said to only read", as the server's or the name's claim, with a line saying nobody has tested it.

Other points:

- A tool is listed under the most serious thing it does and counted under everything it does. Tools whose label was overruled come first in every list, and each has its own line under "Worth a person's look" however many lesser notes there are. Lists are cut only past 500 entries, and say so.
- The section on what a misled or taken-over agent could do always includes handing the server's operator anything the agent knows, because what goes into any tool, even one that only reads, is sent to the server.
- Every sentence is written by the scanner, and no model is involved. A server's descriptions and titles are never quoted. Tool names appear only as identifiers, underscores kept, cut to the characters tool names normally have and never in a form a terminal turns into a link. An earlier draft turned names into words ("kinds of thing: pull request, file"); that let a server put a sentence of its own into the report, so it was removed. The report is headed by the address that was scanned; the name a server gives itself appears once, in quotes, and not at all if it carries a word of reassurance such as "safe", "verified" or "official".
- "Moves money" and "sends" are never the server's own statement, because the protocol gives it no way to make one. They are read off names and descriptions, and the report says so.
- With several snapshots it opens with what an agent connected to all of them can do. That is the nearest this prototype gets to a per-agent report: it knows servers, not agents.
- It describes what a server offers. It knows nothing of a policy, of the account behind the connection, or of what a tool does when called, and says so.

Limits:

- Names are read as English words split at underscores, hyphens and capitals. `rm_user`, `supprimer_compte` or `sendmoney` are not understood. A word that is usually a thing ("commit", "refund", "release") counts as an action only at the start of a name, so `get_refund_transfer` reads as a reader. The report prints this limit, and lists the "only reads" tools by name so that a person can catch what the word lists miss.
- A server chooses its tool names. One that names a tool `verified_safe_by_aethis` gets that name printed, as an identifier, with a note that it carries a word of reassurance.
- Reading the more serious way costs false alarms. On the live GitHub snapshot `run_secret_scanning` is listed as changing things because of the word "run", against the server's read-only mark. On 244 real tools (the live GitHub list and the 22 open servers; those 22 lists were not saved in this repository, so this figure cannot be re-run from it), a description added an action to 7, and at least two of those were wrong.
- `capture_authorization` and `void_authorization` are not read as money: "capture" and "void" were dropped as money words because they also made `capture_screenshot` and `void_envelope` look like payments.
- Where a server says a change is not destructive, the report gives no undo warning for that tool and says that this rests on the server's word.
- Free-form input is spotted by a short list of words ("sql", "command", "script"). A tool taking `code` or `expression` is not caught.
- A live scan keeps only the first definition when a server lists one name twice (`src/snapshot.ts`). The report keeps repeats when it reads a file, so this gap is in scanning, not in reporting.
- Tried on the live GitHub snapshot and the 22 open servers from the first look, nowhere else.

Review: three independent reviews, the third on a stronger model because the first two kept finding problems. The first found five ways the draft could understate a server and one way a server's name could write into it. The second found those fixes incomplete, including a sentence listing what a server could not do; that sentence is gone. The third judged that the labelling rules now hold for names and descriptions the word lists understand, and found four things to fix before anyone outside the team reads a report: the "kinds of thing" line as a channel for a server's own words, link-like tool names, the missing warning that every tool hands its input to the server's operator, and two list limits that contradicted this README. All four are fixed, each with a test. Those last fixes have not been reviewed.

## Signed-in servers

Added on 2026-10-13, after the first commit.

- A token is read from an environment variable, never from an argument. Do not type the token itself on the command line: the shell would record the whole line in its history. Fill the variable from a command, as in the example above, where the history keeps only the text `$(gh auth token)`, or from `read -rs`. Other processes of the same user, and root, can still read a running process's environment.
- Each server has a fixed address in `src/signed-in.ts`, and `scanSignedIn` there is the only place a token is paired with an address. `scan <url>` cannot send one.
- The token is sent over https only, not at all if certificate checking is switched off, and redirects are refused. It is never printed, never written to a snapshot and never included in an error. If a server sends the token back in its reply, nothing from that reply is printed or saved.
- The list that comes back is what that token is allowed to see. Some servers hide tools a token may not use, so two tokens can produce two different lists, and comparing their snapshots would show tools "added" or "removed" that the server never changed. Keep one token per server for a series of snapshots.
- A token kept anywhere for scheduled scans should belong to an account that holds nothing of value. Storing tokens is not built: the scanner reads one from its environment and keeps it nowhere.

### First signed-in scan (GitHub, 2026-10-13)

One scan of `https://api.githubcopilot.com/mcp/` with an ordinary `gh` login. It describes that one look.

- The server listed 46 tools, all with annotations: 28 read-only, 17 that write, and one marked destructive (`delete_file`).
- The definition files published at v2.0.0 hold 131 tool names. 45 of the 46 live tools are among them; one live tool, `run_secret_scanning`, is not. Why 86 published names were not listed is not established: the hosted server may offer only some groups of tools unless asked for more, or may hide tools from this login.
- The live definitions match neither published release. Of the 45 shared tools, one is identical to its v2.0.0 file: 38 lack the output schema the file has, and 24 have a different input schema. Against v1.14.0, 7 are identical and 38 have a different input schema. Titles, descriptions and annotations are the same in every case. What differs inside the input schemas has not been looked at.
- So a project's published files are not a reliable record of what its hosted server tells a client. Tracking what is served needs a look at the live server.
- Text checks: nothing but one annotation mismatch (`run_secret_scanning` is marked read-only while its name says it runs something) and one low note.

## What the first look found (2026-10-13)

Numbers from one afternoon. They describe the samples below and nothing wider.

- **How many servers can be scanned without signing in.** The official MCP registry was read up to its first 3,000 entries (it stopped answering after that, so the count of all entries is not known). 2,750 of those list a remote endpoint. Of 60 endpoints sampled at random, one per domain, 22 listed their tools without a sign-in, 30 asked for one, and 8 failed in other ways.
- **What a tool list contains.** Across those 22 servers: 198 tools, a median description of 235 characters, none empty, and 151 of 198 with annotations. So there is enough text to label and to check.
- **How good the name-based guess is.** Measured against servers' own `readOnlyHint` on 353 real tools. On the open sample (156 tools with the hint) the name agreed on 104, disagreed on 5 and gave no guess on 47. Two of the five were in the direction that matters: tools their server says write, whose names read as reading. On GitHub's server (134 with the hint) it agreed on 130, disagreed on none and gave no guess on 4.
- **GitHub's MCP server, v1.14.0 to v2.0.0.** 123 of 131 tool definitions changed, but "changed" needs reading with care: 75 of them only gained an output schema, which none had before. The other 48 also had their input schema rewritten. No description was rewritten. Ten new definition files appeared, each a variant of an existing tool. An earlier note put the figure at 124 of 131; this method gives 123.
- **Text findings on real servers.** None of the poisoning rules fired on the 353 tools. Three tools were marked read-only against their names (for example `create_checkout_link`), and one description on GitHub's server refers the model to another of its own tools, which is ordinary. That is the expected result on ordinary servers, and it means the poisoning rules are so far proven only against written examples in the tests.

## Review

One independent review was run on the first draft. It confirmed that the scanner calls no tool, sends no credential to a server and writes only under `data/snapshots/`. It also found real faults, all fixed before the first commit: tools that change or delete things could be labelled Read, a partial tool list was reported as complete, the comparison could not tell a field that appeared from one that was rewritten, and untrusted text could reach the terminal unescaped. The fixes have tests; they have not had a second review. That review was of the version that sent no credential at all. Signed-in scanning was added afterwards and had its own review, of token handling only: it found no way for the token to reach another host or the screen, and its points (an example that put the token in the shell history, no test that redirects are refused, no test of the command) are fixed.

## Others doing this

Invariant Labs' `mcp-scan` (now part of Snyk) already scans a developer's local MCP configuration for poisoned descriptions and pins tool definitions by hash to catch later changes. This scanner is not a better version of that. The difference Aethis is aiming at is elsewhere: a hosted, continuous view across an organisation's agents, in plain language, tied to what each agent is allowed to do.

## Layout

- `src/client.ts`: the handshake and the tool list.
- `src/snapshot.ts`, `src/diff.ts`: fingerprints, snapshots and the comparison.
- `src/risk.ts`: capability labels.
- `src/authority.ts`: the plain-language report.
- `src/findings.ts`: the text checks.
- `src/sources/github-snapshots.ts`: definitions a repository publishes as files.
- `src/signed-in.ts`: the servers a token may be sent to, the check a token must pass, and the one function that sends it.
- `src/text.ts`: making untrusted text safe to print.
- `src/report.ts`, `src/cli.ts`: the text report and the commands.
- `ops/`: a daily scan for one machine: the script, its systemd timer and an installer to run yourself. It uses the `gh` login on that machine and logs one line of counts a day.
- `test/`: 85 tests. None touches the network; one starts the command itself, in cases that stop before any request.
