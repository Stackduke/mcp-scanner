import type { CapabilityClass, CapabilityLabel, ToolDefinition } from "./types.ts";

/**
 * Labels what a tool can do, in the vocabulary Stackduke uses.
 *
 * Two sources are used, and the label says which. A server's own annotations
 * (`readOnlyHint`, `destructiveHint`) are taken as given: they are hints the server
 * volunteers, not something this scanner has verified. Without them the label is a guess
 * from the words in the tool's name, and failing that the first sentence of its description.
 *
 * The guess leans one way on purpose: any word that says the tool changes something outranks
 * a word that says it reads. Calling a reader a writer wastes a reviewer's minute; calling a
 * writer a reader hides the thing the review exists for.
 */
type Kind = Exclude<CapabilityClass, "money">;

const verbs: Record<Kind, string[]> = {
  destructive: ["delete", "remove", "drop", "destroy", "purge", "truncate", "wipe", "erase", "revoke", "terminate", "kill", "uninstall", "reset", "clear", "prune", "deprovision", "deactivate", "expunge", "nuke"],
  send: ["send", "email", "mail", "notify", "publish", "broadcast", "invite", "sms", "reply", "tweet", "share", "forward"],
  write: ["create", "update", "edit", "set", "add", "write", "insert", "upsert", "modify", "patch", "put", "upload", "deploy", "run", "execute", "exec", "merge", "push", "commit", "move", "rename", "enable", "disable", "start", "stop", "restart", "assign", "approve", "reject", "close", "reopen", "import", "apply", "trigger", "schedule", "book", "cancel", "archive", "post", "submit", "save", "register", "sync", "mark", "pin", "star", "fork", "lock", "unlock", "attach", "link", "unlink", "transfer", "grant", "rotate", "configure", "install", "restore", "rollback", "comment", "label", "dismiss", "store", "remember", "record", "log", "track", "subscribe", "unsubscribe", "rerun", "retry", "pause", "resume", "release", "request", "manage", "toggle", "change", "replace", "copy", "clone", "duplicate", "provision", "launch", "invoke", "call", "place", "open", "accept", "decline", "complete", "claim", "hide", "unhide", "unresolve", "mute", "unmute", "follow", "unfollow", "block", "unblock", "ban", "flag", "vote", "react", "bookmark", "pay", "buy", "purchase", "refund", "charge", "withdraw", "deposit", "donate", "fund", "checkout", "swap", "trade", "bid", "tip", "redeem", "mint", "burn", "stake", "sign", "authorize", "authorise", "impersonate", "seed", "migrate", "scale", "overwrite", "append", "populate", "initialize", "initialise", "init", "bootstrap", "build", "compile", "format", "rebase", "revert", "tag", "untag", "enqueue", "queue", "dispatch", "emit", "fire", "issue", "void", "settle", "capture", "reverse", "allocate", "reserve", "consume", "ingest", "index", "reindex", "train", "finetune", "evict", "flush", "drain", "detach", "disconnect", "connect", "join", "leave", "kick", "promote", "demote", "elevate", "escalate", "suspend", "activate", "expire", "extend", "renew"],
  read: ["get", "list", "read", "search", "fetch", "find", "query", "lookup", "describe", "show", "view", "check", "retrieve", "count", "export", "download", "inspect", "status", "validate", "analyze", "analyse", "summarize", "summarise", "explain", "compare", "browse", "ask", "watch", "monitor", "preview", "calculate", "estimate", "verify", "test", "ping", "whoami", "info", "detect", "diff", "trace", "explore", "discover", "scan", "audit", "review", "recommend", "suggest", "translate", "extract", "parse", "predict", "score", "rank", "match", "locate", "select", "load", "return", "display", "wait"],
};
// Words that move money, or name money being moved. Words for a thing money is about ("price",
// "balance", "credit", "wallet", "subscription", "billing", "coupon") are left out: beside any verb they
// made `register_price_alert` and `get_balance_and_update_cache` move money, which they do not.
const moneyWords = ["pay", "payment", "refund", "charge", "payout", "invoice", "purchase", "buy", "checkout", "withdraw", "withdrawal", "deposit", "transfer", "fund", "bounty", "order", "swap", "trade", "bid", "tip", "donate", "donation", "funds", "money", "transaction", "settle", "settlement", "mint", "stake", "usdc", "usdt", "cashback"];
// Verbs that only edit a record: beside them, a word naming money is the record, not money moved.
const editVerbs = ["update", "edit", "modify", "set", "rename", "tag", "untag", "label", "hide", "unhide", "archive", "mark", "annotate", "comment", "pin", "star", "flag", "bookmark"];
const testnets = new Set(["testnet", "devnet"]);
const broadWords = ["sql", "shell", "bash", "command", "cmd", "exec", "execute", "eval", "script", "graphql", "raw", "arbitrary", "cypher", "terminal", "powershell"];
const broadProperties = ["sql", "command", "cmd", "script", "cypher", "graphql", "shell", "statement"];

// Words that act as verbs at the start of a name and are usually nouns elsewhere:
// "log_event" writes a log, "get_job_logs" reads some. None of the destructive words is here.
const nounLike = new Set(["duplicate", "clone", "connect", "pay", "log", "request", "record", "release", "track", "store", "call", "label", "comment", "link", "star", "pin", "fork", "place", "change", "copy", "load", "test", "match", "score", "rank", "review", "trace", "status", "info", "check", "count", "export", "import", "order", "post", "mail", "email", "share", "schedule", "book", "commit", "push", "merge", "run", "query", "search", "view", "show", "diff", "scan", "audit", "tip", "bid", "trade", "swap", "deposit", "transfer", "sync", "save", "lock", "grant", "claim", "start", "stop", "open", "close", "sign", "vote", "block", "follow", "fund", "charge", "refund", "purchase", "watch", "monitor", "preview", "estimate", "select", "reply", "invite", "forward", "broadcast", "publish", "notify", "upload", "download", "install", "restore", "tag", "issue", "queue", "index", "build", "format", "scale", "capture", "reserve", "seed", "credit", "balance", "price", "render"]);
// Noun-like words that open a name as a thing more often than as a verb: before a word that reads, they
// name what is read (`email_check`, `order_validator`). "run", "save", "post", "share" and the like are left
// out: `run_query`, `save_search` and `post_review` act.
const thingsFirst = new Set(["email", "mail", "order", "tip", "comment", "label", "tag", "link", "issue", "record"]);
// Words that, after "email" or "mail" at the start, make it a thing: "Email address verification", `email_security`.
const mailThings = new Set(["address", "addresses", "verification", "validation", "validator", "security", "authentication", "deliverability", "stats", "statistics", "template", "templates", "domain", "domains", "server", "servers", "settings", "header", "headers", "check", "checker", "status", "history", "preview", "list", "lists", "inbox", "thread", "threads"]);
/** "email" or "mail" before a word that makes it a thing. */
export const mailAsThing = (token: string | undefined, next: string | undefined) => token !== undefined && next !== undefined && (token === "email" || token === "mail") && mailThings.has(next);

// Words that, inside a name and before another word, name a kind of thing: `get_deploy_component`.
// First (`deploy_app`) or last (`trigger_deploy`), they act.
const modifiers = new Set(["deploy"]);

const order: CapabilityClass[] = ["read", "write", "send", "money", "destructive"];
const acting: Kind[] = ["destructive", "send", "write"];

/** Splits `createIssue`, `create_issue`, `issues.create` and `create-issue` into the same words. */
export function words(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** A word and its simplest base forms, so "creates", "created" and "creating" match "create". */
function forms(word: string): string[] {
  const out = [word];
  if (word.length < 5) return word.endsWith("s") && word.length > 3 ? [...out, word.slice(0, -1)] : out;
  if (word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("es")) out.push(word.slice(0, -2), word.slice(0, -1));
  else if (word.endsWith("s")) out.push(word.slice(0, -1));
  if (word.endsWith("ing")) out.push(word.slice(0, -3), `${word.slice(0, -3)}e`);
  if (word.endsWith("ed")) out.push(word.slice(0, -2), word.slice(0, -1));
  return out;
}

const isIn = (token: string, list: readonly string[] | Set<string>) => forms(token).some((form) => (list instanceof Set ? list.has(form) : list.includes(form)));
const kindOf = (token: string): Kind | null => {
  for (const kind of ["destructive", "send", "write", "read"] as const) if (isIn(token, verbs[kind])) return kind;
  return null;
};

/** "updates", "invites": a plural form of a word that writes or sends, as opposed to the word itself. */
const pluralOfActing = (token: string) => {
  const kind = kindOf(token);
  return token.endsWith("s") && (kind === "write" || kind === "send") && !verbs[kind].includes(token);
};
/** A verb that reads and is hardly ever a noun: "get", "list", "fetch", not "search" or "check". */
const plainRead = (token: string | undefined) => token !== undefined && kindOf(token) === "read" && !isIn(token, nounLike);

/** "calculator", "validator", "checker", "parser": one who reads, named after the verb. */
const readsAsAgent = (token: string) => (token.endsWith("ator") && kindOf(`${token.slice(0, -2)}e`) === "read")
  || (token.length > 5 && token.endsWith("er") && [token.slice(0, -2), token.slice(0, -1)].some((base) => verbs.read.includes(base)));

/** What kind of action a single word names, if it names one. */
export const actionKind = (token: string): CapabilityClass | null => kindOf(token);
/** Words that are verbs at the start of a name and usually nouns elsewhere: "issue", "request", "comment". */
export const isNounLike = (token: string): boolean => isIn(token, nounLike);
/** A word that moves money or names money moved: "pay", "transfer", "funds". */
export const movesMoney = (token: string): boolean => isIn(token, moneyWords);

function propertyNames(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const properties = (schema as { properties?: unknown }).properties;
  return typeof properties === "object" && properties !== null ? Object.keys(properties).map((name) => name.toLowerCase()) : [];
}

/**
 * Reads what a run of words says the tool does.
 *
 * A word counts as a verb when it can hardly be anything else (`review_comment_delete`), or
 * when it follows "and" or "or" (`search_and_delete`). Words that are usually nouns ("logs",
 * "requests", "issue") and participles ("connected") are passed over. The first word is the
 * exception: if nothing else in the name is a verb, a noun-like first word is read as one
 * (`log_event`, `search_code`), and if something else is, it is not (`issue_read`).
 * If any counted word acts, the label is what acts; "read" is the answer only when nothing does.
 */
function fromWords(tokens: string[], { inName = true, moneyFrom = tokens }: { inName?: boolean; moneyFrom?: string[] } = {}): { classes: CapabilityClass[]; basis: string[] } {
  const found = new Map<Kind, string>();
  const actedOn: string[] = [];
  const note = (token: string) => { const kind = kindOf(token); if (kind && kind !== "read") actedOn.push(token); if (kind && !found.has(kind)) found.set(kind, token); };
  // A name that opens with a plain read verb names what it reads after it, so a plural there is a
  // thing: `get_status_updates` reads updates. A singular still acts (`find_user_send_message`), as
  // does the word straight after the verb (`read_writes`), a destructive word, or one joined with
  // "and" or "or". "deploy" names a kind of thing between a verb and another word (`get_deploy_component`).
  const readsAThing = inName && plainRead(tokens[0]);
  tokens.forEach((token, index) => {
    const afterConjunction = tokens[index - 1] === "and" || tokens[index - 1] === "or";
    const participle = index > 0 && !afterConjunction && token.length > 4 && token.endsWith("ed");
    const partOfThing = !afterConjunction && ((readsAThing && index > 1 && pluralOfActing(token))
      || (inName && index < tokens.length - 1 && modifiers.has(token) && tokens.slice(0, index).some((word) => kindOf(word) !== null)));
    if (afterConjunction || (!participle && !partOfThing && !isIn(token, nounLike))) note(token);
  });
  // Nothing clear anywhere: let a noun-like first word speak, unless it is a plural ("issues", "logs").
  // A description's first word is in a verb's place, so there "Runs" and "Lists" speak too.
  // In a name, a first word that is mainly a thing, before a word that reads, names the thing read
  // (`email_check`), and a first word in "-ed" describes a thing (`shared_room_plan`, `published_posts`).
  const first = tokens[0];
  const laterRead = inName && first !== undefined && isIn(first, thingsFirst) ? tokens.slice(1).find((token) => kindOf(token) === "read" || readsAsAgent(token)) : undefined;
  const describing = inName && first !== undefined && tokens.length > 1 && first.length > 4 && first.endsWith("ed");
  const last = tokens.at(-1);
  if (!found.size && laterRead) found.set("read", laterRead);
  else if (!found.size && first && !describing && !(inName && first.endsWith("s") && !nounLike.has(first) && isIn(first, nounLike))) note(first);
  // After a describing first word, a last word that acts says what is done to the thing: `signed_transaction_broadcast`.
  else if (!found.size && describing && last !== undefined && !last.endsWith("s")) note(last);
  if (!found.size) return { classes: [], basis: [] };

  const actingFound = acting.filter((kind) => found.has(kind));
  const classes = new Set<CapabilityClass>(actingFound.length ? actingFound : ["read"]);
  // Deleting is the stronger statement; "write" beside it adds nothing.
  if (classes.has("destructive")) classes.delete("write");
  const basis = (actingFound.length ? actingFound : (["read"] as Kind[])).map((kind) => `"${found.get(kind)}"`);

  // A money word counts only beside something that acts. "list_payments" reads; "create_refund" moves money.
  // A word that names money, not a way of moving it ("transaction", "order"), needs a verb that does more
  // than edit the record: `void_transaction` moves money, `update_transaction` does not. Testnet tokens are not money.
  const editsOnly = actedOn.length > 0 && actedOn.every((token) => isIn(token, editVerbs));
  const money = moneyFrom.filter((token) => isIn(token, moneyWords) && !(editsOnly && kindOf(token) === null));
  if (money.length && actingFound.length && !tokens.some((token) => testnets.has(token)) && !moneyFrom.some((token) => testnets.has(token))) { classes.add("money"); basis.push(...money.map((word) => `"${word}"`)); }
  return { classes: order.filter((item) => classes.has(item)), basis: [...new Set(basis)] };
}

/** What the name alone suggests, for comparing against what a server's annotations claim. */
export function nameSuggests(tool: ToolDefinition): CapabilityClass[] {
  return fromWords(words(tool.name)).classes;
}

// Words that deny what follows them in a clause: "does not create", "nothing is charged", "moves no money".
const negators = new Set(["no", "not", "never", "nothing", "none", "without", "nor", "neither", "cannot", "dont", "doesnt", "isnt", "wont"]);

// "no more than 100", "no-longer-needed": "no" there limits or describes, it does not deny.
const notDenied = new Set(["more", "longer", "less", "fewer", "later", "earlier"]);
// Words passed over between a denial and the verb it denies: "nothing is charged", "cannot be undone".
const auxiliaries = new Set(["is", "are", "be", "been", "was", "were", "will", "ever", "even", "get", "gets", "being"]);

/**
 * The first sentence of a description, as words, with "," for each comma, semicolon or colon: where the
 * verb usually is. A denial drops the verb it denies and nothing else, so "Reads only, nothing is launched
 * and no money moves" and "moves no money" say nothing about acting, while "Lists users without paging and
 * updates their status" still updates. "no" and "without" deny the word straight after them ("no undo",
 * "without deleting it") and, after "no", a verb that follows that word ("no money moves") unless it
 * destroys or sends ("No-confirm delete"). The other denials deny the next word past "is", "be" and the
 * like ("does not create", "nothing is charged"). "no" or "nothing" after a verb denies that verb too.
 */
function openingWords(tool: ToolDefinition): string[] {
  const tokens: string[] = [];
  for (const part of ((tool.description ?? "").split(/[.\n]/)[0] ?? "").split(/[,;:]/)) {
    if (tokens.length) tokens.push(",");
    const partWords = words(part.replace(/n't\b/gi, " not"));
    const kept: string[] = [];
    for (let at = 0; at < partWords.length; at += 1) {
      const word = partWords[at] as string;
      if (!negators.has(word) || (word === "no" && notDenied.has(partWords[at + 1] as string))) { kept.push(word); continue; }
      if ((word === "no" || word === "nothing" || word === "none") && kept.length && kindOf(kept.at(-1) as string) !== null) kept.pop();
      // "does not" goes with the verb it denies: "Does not require approval and transfers funds" transfers funds.
      if (word === "not" && ["does", "do", "did"].includes(kept.at(-1) as string)) kept.pop();
      let next = at + 1;
      while (next < partWords.length && auxiliaries.has(partWords[next] as string)) next += 1;
      if (word === "no" && next + 1 < partWords.length) {
        let after = next + 1;
        while (after < partWords.length && auxiliaries.has(partWords[after] as string)) after += 1;
        const kind = kindOf(partWords[after] ?? "");
        if (kind !== null && kind !== "destructive" && kind !== "send") next = after;
      }
      at = next;
    }
    tokens.push(...kept);
  }
  return tokens.slice(0, 32);
}

// Words a description may open with before its verb: "Use this to delete", "This tool sends", "Allows you to create".
const leadIn = new Set(["use", "used", "this", "tool", "it", "to", "you", "can", "will", "may", "allows", "allow", "lets", "let", "helps", "help", "the", "a", "an", "agent", "function", "endpoint", "please", "we", "here"]);
const joiners = new Set(["and", "or", "then", "also"]);
const objectStarts = new Set(["a", "an", "the", "it", "them", "its", "their", "this", "that", "these", "those", "every", "each", "all", "any", "one", "new", "to", "on", "in", "into", "from", "for", "with", "back", "out", "up"]);
/** "recursively", "optionally": skipped before a verb. "apply" and "reply" are verbs, so a known verb is never skipped. */
const adverb = (token: string) => token.endsWith("ly") && kindOf(token) === null;

const joined = (token: string | undefined) => token === "," || (token !== undefined && joiners.has(token));
// Words after which a destructive verb is said of the tool, whatever opened the sentence: "to delete it", "that removes", "can drop".
const clauseMarkers = new Set(["to", "that", "which", "who", "can", "will", "may", "might", "could", "would"]);
/** "published", "compiling": a past or ongoing form, which describes rather than says what is done. */
const pastOrOngoing = (token: string) => (token.length > 4 && token.endsWith("ed")) || (token.length > 5 && token.endsWith("ing"));

/**
 * The words of a description's opening sentence to read for what the tool does, and the money words
 * that count with them.
 *
 * A clause opened by "before", "after", "if", "when" and the like says when, not what, and is dropped
 * up to the next comma: "Work out where a payment must go, before anybody signs or sends anything",
 * "Join a match after paying the fee".
 *
 * When the sentence opens with a verb, after a lead-in such as "Use this to", that verb is what the
 * tool does and the rest mostly describes the thing it acts on: "metadata and published version
 * history", "by compiling it", "the URL where users can configure it", "a user by name or email".
 * Past it, a verb counts only when joined on ("and deletes it", ", then update it"), an "-ing" form
 * that destroys or sends with its object ("by sending a sample event"), or a destructive word after
 * "to", "that", "can" and the like ("to purge them"). If the opening verb acts, a destructive word
 * counts anywhere ("Executes any API call including DELETE"). A verb that writes after "to" does not
 * ("Fetch the template to create a page"), nor one joined to a verb passed over ("to fund escrow and
 * buy queries"). A word joined on must be a plain verb: not one usually a noun with no object after
 * it ("and issue and scope histories"), nor an "-ed" or "-ing" form ("and linked assets").
 *
 * A sentence that does not open with a verb is read whole ("A tool that deletes files", "Tool for
 * deleting files"), but there a word that is usually a noun counts only before its object ("to email
 * the team", not "storage and email on run402"), an "-ing" form only first or after "for", "by" or
 * "while", and before its object ("for sending messages", not "Sending and engagement stats" or "for
 * email sending"),
 * and an "-ed" form not at all. A destructive word counts in any form.
 *
 * Money counts where a money word is itself a verb that counts ("Buy a phone number"), is what one acts
 * on ("Submit a settlement", "Claim real USDC"), or follows "which" or "that" after an opening verb
 * that acts ("Creates a branch, which can incur usage charges"). Elsewhere it is a thing described:
 * "Calls off an escrow before payment", "on-chain ledger of test transactions".
 */
// "Call this only after", "Call `inspect_actions` first": a word on when to call the tool, not what it does.
const callTimes = new Set(["this", "it", "only", "when", "after", "before", "first"]);
// Words that open a clause saying when or whether, not what: "before anybody signs", "after paying".
const subordinators = new Set(["before", "after", "once", "until", "unless", "if", "when", "whenever", "whether"]);
// Words that end the thing a verb acts on: "Submit a settlement for review", "Claim USDC on Arc".
const objectEnds = new Set([",", "before", "after", "once", "until", "unless", "if", "when", "and", "or", "then", "also", "that", "which", "for", "to", "from", "with", "by", "on", "in", "at", "of", "into", "via", "using", "through", "per", "about", "over"]);
const determiners = new Set(["a", "an", "the", "it", "them", "its", "their", "this", "that", "these", "those", "every", "each", "all", "any", "one", "new", "your", "our", "my"]);
const beforeDoing = new Set(["for", "by", "while"]);
const compared = new Set(["vs", "versus"]);

function statedWords(all: string[], name: string[] = []): { stated: string[]; money: string[]; openingMoney: string[] } {
  let start = 0;
  const callsItself = (at: number) => all[at] === "call" && (callTimes.has(all[at + 1] as string) || (name.length > 0 && name.every((word, offset) => all[at + 1 + offset] === word)));
  while (start < all.length && (leadIn.has(all[start] as string) || adverb(all[start] as string) || callsItself(start))) start += 1;
  // A clause on when is dropped up to the comma that closes it. One that opens the sentence with no comma
  // after it, or with a verb of its own, runs into the main clause ("If stale this tool deletes them"), so
  // nothing is dropped there.
  // A word that destroys is never dropped this way: "Does not ask before deleting records" still deletes.
  const rest = all.slice(start);
  const tokens: string[] = [];
  let saysWhen = false;
  rest.forEach((token, at) => {
    if (token === ",") saysWhen = false;
    else if (subordinators.has(token)) {
      // A clause that opens the sentence runs to its comma only if it has no verb of its own before the
      // comma: "If stale, deletes them" drops "If stale"; "If the user exists sends them an email, otherwise
      // returns null" keeps it all. A past or ongoing form there is not such a verb ("After paying the fee, joins").
      const leading = rest.slice(0, at).every((word) => word === ",");
      const comma = rest.indexOf(",", at);
      const ownVerb = comma > at && rest.slice(at + 1, comma).some((word) => kindOf(word) !== null && !pastOrOngoing(word));
      saysWhen = !leading || (comma > at && !ownVerb);
    }
    if (!saysWhen || kindOf(token) === "destructive") tokens.push(token);
  });
  let index = 0;
  while (index < tokens.length && (tokens[index] === "," || adverb(tokens[index] as string))) index += 1;
  const firstAt = index;

  const money: string[] = [];
  const noteMoney = (token: string) => { if (isIn(token, moneyWords)) money.push(token); };
  /** What the verb at `at` acts on: the words after it, up to a preposition, a joiner or another verb. */
  const objectOf = (at: number) => {
    for (let next = at + 1; next < Math.min(tokens.length, at + 6); next += 1) {
      const token = tokens[next] as string;
      if (objectEnds.has(token)) break;
      // "self-funded test transactions": a past or ongoing form describes the thing, it is not money moved.
      // "Broadcasts signed transactions": such a form before the thing is passed over.
      if (isIn(token, moneyWords) && !pastOrOngoing(token)) money.push(token);
      else if (kindOf(token) !== null && !pastOrOngoing(token)) break;
    }
  };

  const stated: string[] = [];
  const openingAt: number[] = [];
  for (; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (joined(token)) { if (stated.length && stated.at(-1) !== "and") stated.push("and"); continue; }
    if (adverb(token) && stated.length) continue;
    // "Published security scan", "Sending and engagement stats": a past or ongoing form describes a thing.
    // "Buy vs rent vs API cost": a word set against another is a thing compared.
    if (kindOf(token) === null || pastOrOngoing(token) || compared.has(tokens[index + 1] as string)) break;
    // "Email address verification": "email" before a word that makes it a thing is that thing.
    if (!stated.length && mailAsThing(token, tokens[index + 1])) break;
    // "List release notes", "List deploy components": past the first verb, a word that is usually
    // a thing, or names a kind of one, is that, unless it is joined on ("Search or run").
    if (stated.length && stated.at(-1) !== "and" && (isIn(token, nounLike) || modifiers.has(token))) break;
    stated.push(token);
    openingAt.push(index);
  }
  const opening = stated.filter((token) => token !== "and");

  if (!opening.length) {
    const out: string[] = [];
    tokens.forEach((token, at) => {
      if (token === ",") return;
      const kind = kindOf(token);
      if (kind === null || kind === "read") { out.push(token); return; }
      const next = tokens[at + 1];
      if (compared.has(next as string) || compared.has(tokens[at - 1] as string)) return;
      const counts = kind === "destructive" || (pastOrOngoing(token)
        ? token.endsWith("ing") && (at === firstAt || beforeDoing.has(tokens[at - 1] as string)) && next !== undefined && !objectEnds.has(next) && (kindOf(next) === null || isIn(next, nounLike))
        : !isIn(token, nounLike) || determiners.has(next as string) || clauseMarkers.has(tokens[at - 1] as string));
      if (!counts) return;
      out.push("and", token);
      noteMoney(token);
      objectOf(at);
    });
    return { stated: out, money, openingMoney: [] };
  }

  for (const at of openingAt) { noteMoney(tokens[at] as string); objectOf(at); }
  const readOpening = opening.every((token) => kindOf(token) === "read");
  // Money moved by the verbs the sentence opens with: "Pays the invoice", "Transfers USDC to an address".
  const openingMoney = readOpening ? [] : [...money];
  while (stated.at(-1) === "and") stated.pop();
  let passedOver = false;
  let consequence = false;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === ",") { passedOver = false; consequence = false; continue; }
    if (!readOpening && (token === "which" || token === "that")) consequence = true;
    if (consequence) noteMoney(token);
    const kind = kindOf(token);
    if (kind === null || kind === "read") continue;
    let before = index - 1;
    while (before >= 0 && adverb(tokens[before] as string)) before -= 1;
    const previous = tokens[before];
    const joinedOn = joined(previous) && !passedOver;
    const count = () => { stated.push("and", token); noteMoney(token); objectOf(index); };
    if (kind === "destructive" && !readOpening) { count(); continue; }
    // "Lists files, deleting those older", "by sending a sample event": an "-ing" form that
    // destroys or sends, with its object after it, is what the tool does too.
    if (pastOrOngoing(token)) {
      if (token.endsWith("ing") && (kind === "destructive" || kind === "send") && (joinedOn || previous === "by" || previous === "while") && objectStarts.has(tokens[index + 1] as string)) count();
      continue;
    }
    if (!joinedOn && !(kind === "destructive" && previous !== undefined && clauseMarkers.has(previous))) {
      // A verb passed over ("to fund escrow") takes what is joined to it along ("and buy queries"); a word
      // that is usually a thing ("the record") does not.
      if (!isIn(token, nounLike) || clauseMarkers.has(previous as string)) passedOver = true;
      continue;
    }
    // A word that is usually a thing counts as a verb when what follows is its object: "and publish
    // a new version", "and share with the team", but not "and issue and scope histories".
    if (isIn(token, nounLike) && !objectStarts.has(tokens[index + 1] as string)) continue;
    count();
  }
  return { stated, money, openingMoney };
}

/** What a description says the tool does. */
function fromDescription(tool: ToolDefinition): { classes: CapabilityClass[]; basis: string[] } {
  const { stated, money } = statedWords(openingWords(tool), words(tool.name));
  return fromWords(stated, { inName: false, moneyFrom: money });
}

/**
 * Whether the description opens with a verb that moves money: "Pays the invoice", "Charges the card".
 * Money named later in the sentence ("Lists every grant, spend and refund") is not this.
 */
export function descriptionOpensMovingMoney(tool: ToolDefinition): boolean {
  return statedWords(openingWords(tool), words(tool.name)).openingMoney.length > 0 && descriptionSuggests(tool).includes("money");
}

/** What the opening of the description suggests. The server writes it, so it is evidence of action and never of harmlessness. */
export function descriptionSuggests(tool: ToolDefinition): CapabilityClass[] {
  return fromDescription(tool).classes;
}

export function labelTool(tool: ToolDefinition): CapabilityLabel {
  const nameTokens = words(tool.name);
  const annotations = tool.annotations ?? {};
  const broadBasis = [...nameTokens.filter((token) => broadWords.includes(token)).map((word) => `"${word}"`), ...propertyNames(tool.inputSchema).filter((name) => broadProperties.includes(name)).map((name) => `parameter "${name}"`)];
  const withBroad = (label: CapabilityLabel): CapabilityLabel => (broadBasis.length ? { ...label, broad: true, basis: [...label.basis, ...broadBasis] } : label);

  if (annotations.readOnlyHint === true) {
    return withBroad({ classes: ["read"], source: "mcp_annotation", basis: ["readOnlyHint: true"] });
  }

  if (annotations.readOnlyHint === false || typeof annotations.destructiveHint === "boolean") {
    const named = fromWords(nameTokens);
    const classes = new Set<CapabilityClass>(named.classes.filter((kind) => kind !== "read"));
    const basis = [`readOnlyHint: ${String(annotations.readOnlyHint ?? "not set")}`];
    // The MCP spec makes destructiveHint true unless a server says otherwise, and many servers leave it so.
    // It counts when nothing else speaks, or beside a word that destroys; a name or description that says
    // the tool does something else (`verify_emails`, `restore_version`, `send_message`) outweighs it.
    if (annotations.destructiveHint === true) {
      const described = descriptionSuggests(tool);
      // An argument named for destroying ("delete", "purge") is the tool saying so too: `commit_deploy` with `delete`.
      const argumentDestroys = propertyNames(tool.inputSchema).some((name) => words(name).some((word) => kindOf(word) === "destructive"));
      // A free-form tool (`execute_sql`, "Run any SQL") can destroy whatever its input says, so there the hint stands.
      const broadlyDescribed = openingWords(tool).some((word) => broadWords.includes(word));
      // Overwriting is a destructive update in the spec's sense: "Writes a file, overwriting any existing content".
      // "Replace" is not: on the labelled set it was nearly always an edit ("Replace the text of one line").
      const overwrites = [...nameTokens, ...openingWords(tool)].some((word) => isIn(word, ["overwrite"]));
      const destroys = named.classes.includes("destructive") || described.includes("destructive") || argumentDestroys || broadBasis.length > 0 || broadlyDescribed || overwrites;
      const saysOtherwise = named.classes.length > 0 || described.length > 0;
      if (destroys || !saysOtherwise) { classes.add("destructive"); basis.push("destructiveHint: true"); }
      else basis.push("destructiveHint: true, outweighed by what the tool says it does");
    }
    // The server says the tool does not destroy. The label follows it; a name that says
    // otherwise is raised as a finding, not silently overruled.
    if (annotations.destructiveHint === false) { classes.delete("destructive"); basis.push("destructiveHint: false"); }
    if (classes.has("destructive")) classes.delete("write");
    else if (!classes.has("send") || !classes.size) classes.add("write");
    if (named.classes.some((kind) => kind !== "read")) basis.push(...named.basis);
    return withBroad({ classes: order.filter((kind) => classes.has(kind)), source: "mcp_annotation", basis: [...new Set(basis)] });
  }

  const byName = fromWords(nameTokens);
  if (byName.classes.length) return withBroad({ ...byName, source: "heuristic" });

  // Nothing in the name: try the first sentence of the description, where the verb usually is.
  const byDescription = fromDescription(tool);
  if (byDescription.classes.length) return withBroad({ ...byDescription, source: "heuristic", basis: byDescription.basis.map((word) => `${word} in the description`) });

  return withBroad({ classes: [], source: "unclassified", basis: [] });
}
