# The plain-language report and the weekly digest

Both are written by the scanner from saved snapshots. No model is involved, and a server's descriptions are never quoted.

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
- A server chooses its tool names. One that names a tool `verified_safe_by_stackduke` gets that name printed, as an identifier, with a note that it carries a word of reassurance.
- Reading the more serious way costs false alarms. On the live GitHub snapshot `run_secret_scanning` is listed as changing things because of the word "run", against the server's read-only mark. On 244 real tools (the live GitHub list and the 22 open servers; those 22 lists were not saved in this repository, so this figure cannot be re-run from it), a description added an action to 7, and at least two of those were wrong.
- `capture_authorization` and `void_authorization` are not read as money: "capture" and "void" were dropped as money words because they also made `capture_screenshot` and `void_envelope` look like payments.
- Where a server says a change is not destructive, the report gives no undo warning for that tool and says that this rests on the server's word.
- Free-form input is spotted by a short list of words ("sql", "command", "script"). A tool taking `code` or `expression` is not caught.
- A live scan keeps only the first definition when a server lists one name twice (`src/snapshot.ts`). The report keeps repeats when it reads a file, so this gap is in scanning, not in reporting.
- Tried on the live GitHub snapshot and the 22 open servers from the first look, nowhere else.

Review: three independent reviews, the third on a stronger model because the first two kept finding problems. The first found five ways the draft could understate a server and one way a server's name could write into it. The second found those fixes incomplete, including a sentence listing what a server could not do; that sentence is gone. The third judged that the labelling rules now hold for names and descriptions the word lists understand, and found four things to fix before anyone outside the team reads a report: the "kinds of thing" line as a channel for a server's own words, link-like tool names, the missing warning that every tool hands its input to the server's operator, and two list limits that contradicted this README. All four are fixed, each with a test. Those last fixes have not been reviewed.

## The weekly digest

Added on 2026-10-13. `digest` takes folders of saved scans and writes the period's changes as an email's subject and plain text. The command sends nothing. It is not sent on a schedule.

It is built on one requirement: it must never make a period look quieter than the saved scans show.

- **Every scan in the period is read**, not only the first and last. Whatever was true of a tool at any scan is reported, even if it has gone by the latest one: what it could do at its most, free-form input, a spell as an unknown tool, a server withdrawing "can be undone", rewritten wording, changed labels, and every new reason to look at it. This holds for tools that were changed, added, removed, or that came and went. A tool poisoned on Wednesday and tidied up on Friday is reported as having been able to do more, with the reason marked "seen during the period and gone by the latest scan".
- The series starts from the last scan before the period, when there is one, so a change at its edge is not missed.
- **A period that was not properly watched is never called quiet.** A server with fewer than two scans to compare, a long stretch without a scan, or a saved scan that could not be read is "not fully covered", in the subject and beside the server, with the stretch named. A long stretch is 36 hours, or half the period when that is shorter. A folder that gives no scans for the period is in the subject too. "No difference" is said only of the scans that were read, and says which.
- Nothing is said to have stayed the same unless the tool was listed at every scan and counted as doing the same thing at each.
- Changes are sorted by what a reader needs first: tools that could do more than at the start, tools that came and went, tools changed and put back, tools added (each with what it is counted as doing), tools removed, rewritten wording, changed labels, tools counted as doing less, and changes to inputs or outputs only. A tool that becomes unknown counts as doing more. Wording or labels changed and then put back count as needing a look.
- Within each list the tools that most need a look come first. Planted text and overruled labels are never cut from "worth a person's look". Other lists are cut past 500 entries, and the least important one (inputs or outputs only) past 12, each saying how many were left out.
- A new reason to look is told apart by where it was found, so a second planted instruction in a tool that already had one is new. A tool that was already worth a look before the period is named, not explained again.
- A rewritten description is reported as a fact and never shown. If the new wording trips a text check, or its first sentence says the tool now acts, that is raised in the scanner's own words.
- It follows the plain-language report's rules: each tool is read the more serious way at every scan, nothing says a server is safe, and a server's words appear only as tool-name identifiers. In the digest, dots in names and in server addresses are written "[.]" and "@" is written "[at]", so a mail reader does not make them links.
- With `--until` the period is whole days in UTC ending with that day. Flags are read strictly: a misspelt one is refused, not ignored.

Limits:

- A scan sees one moment. A change made and undone between two scans is not seen, however often scans run.
- Only the first sentence of a description is read for what a tool does. A rewrite whose second sentence says "then deletes it" is reported as rewritten wording. The digest prints this limit.
- A new parameter, or a changed note on one, is reported under "inputs or outputs". The notes are checked for planted instructions and not for what they imply the tool does.
- Low-severity wording notes are not carried into the digest.
- Scans made with different logins look like changes.
- "Needs a look" in the subject is decided by fixed rules, not by judgement.
- A tool that came and went is described by the most serious state it was in, plus anything more it could do in another; the order of its states is not given.
- Two scans with the same timestamp are taken in file-name order. Servers are told apart by their shown address in lower case, cut at 80 characters. Every saved scan in a folder is read each time, with no limit on how many.
- A tool name made of ordinary characters is printed as it is, so a server can still choose a name that reads like a phrase. Names carrying a word of reassurance are flagged.
- The subject says "weekly" whatever `--days` is.

Tried on the two live GitHub scans (reported as not fully covered: they are four minutes apart) and on the two published GitHub releases relabelled as scans five days apart, nowhere else.

Review: two independent reviews. The first found six ways the first draft could understate a week, the main one being that a change made mid-week was invisible whenever the two ends differed; the digest was rewritten around reading every scan. The second confirmed those six closed for the cases named and found the same pattern surviving wherever something was still judged from the two ends only (reversibility, wording, labels, added and removed tools), plus concerns compared by their sentence and not their place, a gap rule that did not scale to a short period, folders that gave nothing leaving the subject quiet, and two sentences that could be false. Each is fixed with a test. That second round of fixes has not been reviewed.

