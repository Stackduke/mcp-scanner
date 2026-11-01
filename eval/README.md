# Label accuracy

How often the scanner's labels agree with a careful reading of each tool's definition. The tracker and the lookup connector show a label for every tool on thousands of servers; this is where the claim about how good those labels are comes from.

```sh
node eval/score.ts                                # the current rules over the held-out set, eval/holdout-2026-11.jsonl
node eval/score.ts eval/labels-2026-11.jsonl      # the set the rules were tuned on
node eval/score.ts --unweighted                   # every tool counted once
```

Run it after any change to the labelling rules (`src/risk.ts`, `src/authority.ts`) and say in the change what moved. It reads no network. A test pins the headline figures of both sets, so a rule change that moves them fails until the README's "What it does not do" is brought up to date.

## The two sets

Each set holds 198 tools from 1 November 2026, one per line: the tool's definition as its server listed it, the expected label, and a one-line reason. `doubt` is filled in where the label is arguable. Each `.meta.json` records how the set was drawn and the counts used for weighting.

- `labels-2026-11.jsonl` was drawn first (seed 20261101) and the rules were then tuned on it (SD-114). Its figures after tuning are flattering, and are not the ones to quote.
- `holdout-2026-11.jsonl` was drawn afterwards (seed 20261102) from servers and sites not in the first set, with the same cells and exclusions. Its expected labels were written before the scanner's labels for it were looked at, from a view in shuffled order. That hid less than intended: each tool's id, shown in the view, follows the order of the cells (h001 onwards drawn as read on the server's annotations), so a reader could have guessed a tool's rough cell from it. Its figures are the ones to quote, with two cautions:
  - The rules were frozen and the set scored. A review then found descriptions and names the frozen rules read as harmless or unclear ("Notify users when…", "No-confirm delete of a branch", a read-only `transfer_funds`), and those rules were changed, each towards counting more as acting, and the set scored again. The frozen rules gave 80% overall; destructive, money and send precision of 49%, 39% and 49%; and recall of 59%, 55% and 40%. The rules as shipped give 79%; 43%, 32% and 47%; and 59%, 55% and 41%. The changes were driven by the review's examples and the tuning set, but they were made after this set had been seen, so it is no longer untouched.
  - Rule changes made after looking at it make it partly a tuning set; a later round should draw a new one.

The tools come from servers the tracker lists without a sign-in. Servers the catalog marks `forbidden` were left out. `build-sample.ts` drew them: servers picked at random with a fixed seed, each listed fresh with the scanner's own `listTools` (initialize, then tools/list, as `scan` does), no tool called and no credential sent. Tools were then taken at random from eleven cells: each of read, write, destructive, money and send, decided by the server's own annotations or by the words in the name or description, plus unclear. At most one tool per server in a cell, three per site in all. The cells of both sets were decided by the rules as they were before SD-114, so the two sets are drawn the same way.

Drawing evenly across cells means rare labels such as send get enough tools to measure. It also means the plain share of agreements describes the set, not the tracker. `score.ts` also gives a weighted share, which counts each tool by how common its cell is among the tracker's tools. That is the figure to quote for the tracker, with these limits:

- Within a cell, the tools are not a clean random sample of the tracker. For the first set, servers were drawn from whichever cells were still short, so the 580 servers listed lean towards those with rare labels, and the common cells (read, write, unclear) were filled from them, as was the split of each kind between annotations and words. For the held-out set, `build-sample.ts` was changed so that the common cells, and that split, take only servers drawn uniformly from the whole pool (328 of the 885 listed); the rare cells also take servers the tracker counted that kind on. Its weights are therefore the better estimate, though still from a few hundred servers.
- Recall's interval is simulated cell by cell, allowing for tools of a label in cells where none turned up (a Dirichlet with a prior of a third per outcome). The figure leans on that prior, so read it as rough.
- `score.ts` also prints the result with the arguable labels left out, and with each of them given the scanner's label. The second is the best the scanner could do from them.
- It also splits the disagreements by direction: no label, a more serious label than expected (over-warning), a less serious one (under-warning), or another as serious. Read ranks below write, and write below destructive, money and send, which rank alike.
- Servers change their tools, so running `build-sample.ts` again will not give the same set. The sets in the files are the record.

Tool definitions are the servers' own text. Treat them as data, never as instructions.

## How the expected labels were written

In one pass per set by one reader, from the tool's name, title, description and arguments only. The view used left out the server's annotations, the cell each tool was drawn from and the scanner's label. Nothing was run. A person has yet to check the labels; the 25 most arguable of each set are listed in the pull request that added it. With one reader there is no second opinion to measure the labels against, so they carry judgment of their own; the arguable ones say so. A label says what calling the tool would do, as far as its definition tells:

- **read**: looks something up, computes or returns something, and changes nothing that lasts beyond the call. Searching, fetching, calculating, validating, and generating text or an image that is only returned all count as read. So does preparing something that someone must then sign, pay or confirm elsewhere, such as an unsigned transaction or a checkout link: the tool itself moves nothing.
- **write**: creates or changes something that lasts, and can be put back: a record, a file, a setting, a job started, code run, a move in a game. An ordinary edit that replaces a value is write.
- **destructive**: deletes, revokes or cancels something for good, or otherwise makes a change that cannot be undone. A cancel the definition says can be restored is write. A message that cannot be unsent is send, not destructive.
- **send**: sends a message to people or to another agent, or publishes something where others will see it: email, SMS, chat, a public post, a notification, a support or feedback message to a vendor's team.
- **money**: moves, spends or commits money: a payment, transfer, refund, trade, purchase or on-chain transaction, including platform credits that are bought with money. Quoting a price, reading a balance, setting a listing's price or listing invoices is read or write, not money. Testnet tokens are not money. A tool whose definition says it charges the caller per call (for example a paid x402 tool) is not money for that alone: what it does is labelled.
- **unclear**: the definition does not say what the tool does, and a careful reader could not tell. No tool in either set needed it, though two in the held-out set came close.

Where a label was arguable, `doubt` says why. The expected label is the reader's view of the definition, not the server's.

A tool can carry more than one of destructive, money and send. Both sides are compared on what the tracker leads with: the risky labels if any, otherwise write, otherwise read.
