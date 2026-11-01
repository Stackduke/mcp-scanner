# Changelog

Changes that alter what the scanner prints. Earlier releases are described in their git tags.

## Unreleased

### Labels: fewer false alarms on destructive, money and send (SD-114)

The labelling rules were tuned against a labelled set of 198 tools and then checked on 198 others held out from tuning ([eval/](eval/README.md)). On the held-out tools, the share whose label matches rose from about 68% to about 79%. Of the tools labelled destructive, money or send, the share that are rose from 22% to 43%, 17% to 32% and 38% to 47%. No tool that changes something was labelled read, before or after. Destructive and money catch a little fewer risky tools than before: of 13 destructive, 6 money and 26 send tools, 10, 4 and 20, against 11, 6 and 20 before. A few rules were changed after the held-out set was first scored, each towards counting more as acting; eval/ gives the figures from before that.

What changes in the output:

- **`destructiveHint: true` is weaker evidence.** The MCP spec makes it true by default for any tool not marked read-only, and many servers leave it so. A tool is now labelled destructive on it only when its name, description or an argument also says it destroys or overwrites, when the tool takes free-form input (`execute_sql`, "Run any SQL"), or when nothing else says what the tool does. `sync` marked destructive is now labelled write, with the basis "destructiveHint: true, outweighed by what the tool says it does", and "Worth a person's look" says the server's mark was set aside.
- **A server's `readOnlyHint: true` outweighs a name that only suggests writing, and a description that only suggests writing or moving money.** On the labelled sets, such tools were nearly always a lookup, a ledger or a quote (`company_register_search`, `create_order`, `run_secret_scanning`). The tool stays under "Said to only read", and "Worth a person's look" carries a note: "The server marks this read-only, though its name suggests it can … This report goes with the server." A name that says the tool deletes, sends or itself moves money (`transfer_funds`, `create_checkout_link`, `email_contacts`), or a description that says it deletes or sends or opens by moving money ("Transfers USDC to the given address"), still counts and is still flagged.
- **A description counts for send and money only where it says the tool does it.** Words in a clause on when ("before anybody signs", "after paying"), denied words ("moves no money", "without deleting it"; a denial drops only what it denies, so "Lists users without paging and updates their status" still updates), nouns ("by name or email", "storage and email"), "-ing" and "-ed" forms used as descriptions ("Sending and engagement stats", "Published security scan"), and verbs that are part of a purpose ("to fund escrow and buy queries") no longer raise a label. A money word counts when it is the verb, what the verb acts on ("Submit a settlement", "Broadcasts signed transactions"), or follows "which" or "that" after a verb that acts ("which can incur usage charges"). A word that destroys still counts inside a clause on when ("Does not ask before deleting records"), and a clause that opens the sentence is read as part of it when no comma closes it or when it has a verb of its own ("If stale this tool deletes them", "If the user exists sends them an email, otherwise returns null").
- **Money words.** "price", "balance", "credit", "wallet", "subscription", "billing" and "coupon" no longer make a tool move money: they name what money is about. "usdc", "usdt" and "cashback" now do. A word naming a money record ("transaction", "order") does not make a tool move money beside a verb that only edits the record (`update_transaction`, "Set the order of steps"). Testnet tokens are not money.
- **Names.** A first word that is mainly a thing ("email", "order", "tip") before a reading word names the thing read (`email_check` is read); `run_query`, `save_search` and `post_review` still act. A word for one who reads makes a reader (`tip_calculator`, `order_validator`). A first word in "-ed" describes a thing and no longer counts as acting (`shared_room_plan`); the last word then says what is done (`signed_transaction_broadcast` sends and moves money).

A tool whose only label came from words that no longer count is now "unclear", which the report shows as not known, never as read. In the two sets that is 4 tools, 3 of which only read.

### Eval

`eval/score.ts` also prints where the scanner disagrees by direction: no label, over-warning, under-warning, or another label as serious.
