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
  read: ["get", "list", "read", "search", "fetch", "find", "query", "lookup", "describe", "show", "view", "check", "retrieve", "count", "export", "download", "inspect", "status", "validate", "analyze", "analyse", "summarize", "summarise", "explain", "compare", "browse", "ask", "watch", "monitor", "preview", "calculate", "estimate", "verify", "test", "ping", "whoami", "info", "detect", "diff", "trace", "explore", "discover", "scan", "audit", "review", "recommend", "suggest", "translate", "extract", "parse", "predict", "score", "rank", "match", "locate", "select", "load", "return", "display"],
};
const moneyWords = ["pay", "payment", "refund", "charge", "payout", "invoice", "purchase", "buy", "checkout", "withdraw", "withdrawal", "deposit", "transfer", "fund", "bounty", "billing", "subscription", "order", "price", "wallet", "swap", "trade", "bid", "tip", "donate", "donation", "credit", "coupon", "balance", "funds", "money", "transaction", "settle", "settlement", "mint", "stake"];
const broadWords = ["sql", "shell", "bash", "command", "cmd", "exec", "execute", "eval", "script", "graphql", "raw", "arbitrary", "cypher", "terminal", "powershell"];
const broadProperties = ["sql", "command", "cmd", "script", "cypher", "graphql", "shell", "statement"];

// Words that act as verbs at the start of a name and are usually nouns elsewhere:
// "log_event" writes a log, "get_job_logs" reads some. None of the destructive words is here.
const nounLike = new Set(["duplicate", "clone", "connect", "pay", "log", "request", "record", "release", "track", "store", "call", "label", "comment", "link", "star", "pin", "fork", "place", "change", "copy", "load", "test", "match", "score", "rank", "review", "trace", "status", "info", "check", "count", "export", "import", "order", "post", "mail", "email", "share", "schedule", "book", "commit", "push", "merge", "run", "query", "search", "view", "show", "diff", "scan", "audit", "tip", "bid", "trade", "swap", "deposit", "transfer", "sync", "save", "lock", "grant", "claim", "start", "stop", "open", "close", "sign", "vote", "block", "follow", "fund", "charge", "refund", "purchase", "watch", "monitor", "preview", "estimate", "select", "reply", "invite", "forward", "broadcast", "publish", "notify", "upload", "download", "install", "restore", "tag", "issue", "queue", "index", "build", "format", "scale", "capture", "reserve", "seed", "credit", "balance", "price", "render"]);

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

/** What kind of action a single word names, if it names one. */
export const actionKind = (token: string): CapabilityClass | null => kindOf(token);
/** Words that are verbs at the start of a name and usually nouns elsewhere: "issue", "request", "comment". */
export const isNounLike = (token: string): boolean => isIn(token, nounLike);

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
function fromWords(tokens: string[]): { classes: CapabilityClass[]; basis: string[] } {
  const found = new Map<Kind, string>();
  const note = (token: string) => { const kind = kindOf(token); if (kind && !found.has(kind)) found.set(kind, token); };
  tokens.forEach((token, index) => {
    const afterConjunction = tokens[index - 1] === "and" || tokens[index - 1] === "or";
    const participle = index > 0 && !afterConjunction && token.length > 4 && token.endsWith("ed");
    if (afterConjunction || (!participle && !isIn(token, nounLike))) note(token);
  });
  // Nothing clear anywhere: let a noun-like first word speak, unless it is a plural ("issues", "logs").
  const first = tokens[0];
  if (!found.size && first && !(first.endsWith("s") && !nounLike.has(first) && isIn(first, nounLike))) note(first);
  if (!found.size) return { classes: [], basis: [] };

  const actingFound = acting.filter((kind) => found.has(kind));
  const classes = new Set<CapabilityClass>(actingFound.length ? actingFound : ["read"]);
  // Deleting is the stronger statement; "write" beside it adds nothing.
  if (classes.has("destructive")) classes.delete("write");
  const basis = (actingFound.length ? actingFound : (["read"] as Kind[])).map((kind) => `"${found.get(kind)}"`);

  // A money word counts only beside something that acts. "list_payments" reads; "create_refund" moves money.
  const money = tokens.filter((token) => isIn(token, moneyWords));
  if (money.length && actingFound.length) { classes.add("money"); basis.push(...money.map((word) => `"${word}"`)); }
  return { classes: order.filter((item) => classes.has(item)), basis: [...new Set(basis)] };
}

/** What the name alone suggests, for comparing against what a server's annotations claim. */
export function nameSuggests(tool: ToolDefinition): CapabilityClass[] {
  return fromWords(words(tool.name)).classes;
}

/** The first sentence of a description, as words: where the verb usually is. */
const openingWords = (tool: ToolDefinition) => words((tool.description ?? "").split(/[.\n]/)[0] ?? "").slice(0, 24);
/** What the opening of the description suggests. The server writes it, so it is evidence of action and never of harmlessness. */
export function descriptionSuggests(tool: ToolDefinition): CapabilityClass[] {
  return fromWords(openingWords(tool)).classes;
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
    if (annotations.destructiveHint === true) { classes.add("destructive"); basis.push("destructiveHint: true"); }
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
  const byDescription = fromWords(openingWords(tool));
  if (byDescription.classes.length) return withBroad({ ...byDescription, source: "heuristic", basis: byDescription.basis.map((word) => `${word} in the description`) });

  return withBroad({ classes: [], source: "unclassified", basis: [] });
}
