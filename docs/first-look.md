# What the first look found (October 2026)

Notes from the first days of the scanner, kept because the numbers are referred to elsewhere. They describe the samples named and nothing wider.

## First signed-in scan (GitHub, 2026-10-13)

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

## Reviews of the first version

One independent review was run on the first draft. It confirmed that the scanner calls no tool, sends no credential to a server and writes only under `data/snapshots/`. It also found real faults, all fixed before the first commit: tools that change or delete things could be labelled Read, a partial tool list was reported as complete, the comparison could not tell a field that appeared from one that was rewritten, and untrusted text could reach the terminal unescaped. The fixes have tests; they have not had a second review. That review was of the version that sent no credential at all. Signed-in scanning was added afterwards and had its own review, of token handling only: it found no way for the token to reach another host or the screen, and its points (an example that put the token in the shell history, no test that redirects are refused, no test of the command) are fixed.

