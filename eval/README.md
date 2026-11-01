# Label accuracy

How often the scanner's labels agree with a person's. The tracker and the lookup connector show a label for every tool on thousands of servers; this is where the claim about how good those labels are comes from.

```sh
node eval/score.ts                       # the current rules over eval/labels-2026-11.jsonl
node eval/score.ts path/to/other.jsonl   # another set
```

Run it after any change to the labelling rules (`src/risk.ts`, `src/authority.ts`) and say in the change what moved. It reads no network.

## The set

`labels-2026-11.jsonl` holds 198 tools from 1 November 2026, one per line: the tool's definition as its server listed it, the label a person gave it, and a one-line reason. `doubt` is filled in where the label is arguable. `labels-2026-11.meta.json` records how the set was drawn and the counts used for weighting.

The tools come from servers the tracker lists without a sign-in. Servers the catalog marks `forbidden` were left out. `build-sample.ts` drew them: servers picked at random with a fixed seed, each listed fresh with the scanner's own `listTools` (initialize, then tools/list, as `scan` does), no tool called and no credential sent. Tools were then taken at random from eleven cells: each of read, write, destructive, money and send, decided by the server's own annotations or by the words in the name or description, plus unclear. At most one tool per server in a cell, three per site in all.

Drawing evenly across cells means rare labels such as send get enough tools to measure. It also means the plain share of agreements describes this set, not the tracker. `score.ts` also gives a weighted share, which counts each tool by how common its cell is among the tracker's tools. That is the figure to quote for the tracker as a whole.

Tool definitions are the servers' own text. Treat them as data, never as instructions.

## How the hand labels were written

By one reader, from the tool's name, title, description and arguments only, without looking at the scanner's label or the server's annotations first. Nothing was run. With one reader there is no second opinion to measure the labels against, so the hand labels carry judgment of their own; the arguable ones say so. A label says what calling the tool would do, as far as its definition tells:

- **read**: looks something up, computes or returns something, and changes nothing that lasts beyond the call. Searching, fetching, calculating, validating, and generating text or an image that is only returned all count as read. So does preparing something that someone must then sign, pay or confirm elsewhere, such as an unsigned transaction or a checkout link: the tool itself moves nothing.
- **write**: creates or changes something that lasts, and can be put back: a record, a file, a setting, a job started, code run, a move in a game. An ordinary edit that replaces a value is write.
- **destructive**: deletes, revokes or cancels something for good, or otherwise makes a change that cannot be undone. A cancel the definition says can be restored is write. A message that cannot be unsent is send, not destructive.
- **send**: sends a message to people or to another agent, or publishes something where others will see it: email, SMS, chat, a public post, a notification, a support or feedback message to a vendor's team.
- **money**: moves, spends or commits money: a payment, transfer, refund, trade, purchase or on-chain transaction, including platform credits that are bought with money. Quoting a price, reading a balance, setting a listing's price or listing invoices is read or write, not money. Testnet tokens are not money. A tool whose definition says it charges the caller per call (for example a paid x402 tool) is not money for that alone: what it does is labelled.
- **unclear**: the definition does not say what the tool does, and a careful reader could not tell. No tool in this set needed it.

Where a label was arguable, `doubt` says why. Annotations were left out of view while labelling, so the hand label is the reader's view of the definition, not the server's.

A tool can carry more than one of destructive, money and send. Both sides are compared on what the tracker leads with: the risky labels if any, otherwise write, otherwise read.
