import { nameSuggests } from "./risk.ts";
import { base64Runs, dottedWords, hiddenCharacters, identifierWords, printable, readsAsText, tagText } from "./text.ts";
import type { Finding, FindingSeverity, ToolDefinition } from "./types.ts";

/**
 * Looks through the text a tool hands to a model for signs of "tool poisoning": instructions
 * written for the model and not for the person, characters a person cannot see, pointers at
 * secrets, or attempts to steer how other tools are used.
 *
 * Every rule here is a pattern check. It finds text worth a person's attention; it cannot
 * tell intent, it will flag some honest descriptions, and a careful attacker can word around
 * it. A clean result means "nothing matched", not "safe".
 */
interface TextRule {
  rule: string; severity: FindingSeverity; reason: string; pattern: RegExp;
  /** Used instead of `pattern` on a name split into words, where honest flags are common ("do_not_notify_user"). */
  inNames?: RegExp;
}

// Patterns run on text whose whitespace has been collapsed to single spaces, so a line break
// in the middle of a phrase does not hide it.
const textRules: TextRule[] = [
  { rule: "instruction-override", severity: "high", reason: "Tells the model to disregard its other instructions.", pattern: /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|other|all|any|system)\b[^.]{0,20}\b(instructions?|rules?|prompts?|guidelines?|constraints?)\b/i, inNames: /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier|other|all|any|system)\b.{0,20}\b(instructions?|rules?|prompts?|guidelines?|constraints?)\b/i },
  { rule: "concealment", severity: "high", reason: "Tells the model to keep something from the person it is working for.", pattern: /\b(do not|don't|never|without)\b[^.]{0,25}\b(tell|telling|inform|informing|mention|mentioning|reveal|revealing|notify|notifying|show|showing|alert|alerting|disclose|disclosing|ask|asking)\b[^.]{0,25}\b(the )?(user|human|person|operator)\b(?!['’]s)/i, inNames: /\b(do not|dont|never|without)\b.{0,25}\b(tell|telling|mention|mentioning|reveal|revealing|disclose|disclosing|inform|informing)\b.{0,25}\b(user|human|person|operator)\b/i },
  { rule: "hidden-instruction-block", severity: "high", reason: "Contains a tag commonly used to smuggle instructions to a model.", pattern: /<\/?\s*(important|system|secret|instructions?|hidden|admin|priority|override)\s*>/i },
  { rule: "credential-store", severity: "high", reason: "Points at a place on a person's machine where credentials are kept.", pattern: /(~\/\.ssh|\bid_rsa\b|\bid_ed25519\b|~\/\.aws|\/etc\/(passwd|shadow)|\.npmrc\b|\.netrc\b|\bmcp\.json\b|~\/\.cursor|~\/\.config\/)/i },
  { rule: "send-elsewhere", severity: "high", reason: "Asks for data to be sent to an address or URL named in the text.", pattern: /\b(forward|bcc|transmit|exfiltrate|upload|send|post|email|include)\b[^.]{0,40}\b(data|contents?|text|output|results?|files?|conversation|history|context|credentials?|keys?|tokens?|secrets?|copy|everything|transcript)\b[^.]{0,40}\b(to|at)\b (https?:\/\/\S+|[\w.+-]+@[\w-]+\.[a-z]{2,})/i },
  { rule: "mentions-secrets", severity: "low", reason: "Mentions a secrets file or a private key. Often honest, for example a tool that loads its own configuration.", pattern: /((^|[\s"'`(/])\.env\b|\bprivate key\b|\bkeychain\b)/i },
  { rule: "model-directive", severity: "medium", reason: "Gives the model a standing order instead of describing what the tool does.", pattern: /\b(you|the (assistant|model|agent|ai)) (must|should|shall|need to|have to) (always|never|first|immediately)\b/i },
  { rule: "refers-to-other-tools", severity: "low", reason: "Tells the model how to use another tool. That is ordinary guidance inside one server, and worth a look if the tool it names belongs to a different one.", pattern: /\b(when(ever)?|before|after|instead of)\b[^.]{0,30}\b(using|calling|invoking|use|call|invoke)\b[^.]{0,30}\b(any other|another|other|the)\b[^.]{0,30}\b(tools?|servers?)\b/i },
];

// "Asks for secrets" reads three parts: a verb that moves something, a secret that belongs to
// someone else or to whoever has one ("the user's API key", "any credentials"), and either a
// place in the tool call to put it or a source only the model can see. All three together are
// rare in honest text, which says "your API key" and names a header or the environment.
const secret = String.raw`(?:api[ _-]?keys?|access[ _-]?tokens?|auth(?:entication|orization)?[ _-]?tokens?|bearer[ _-]?tokens?|refresh[ _-]?tokens?|oauth[ _-]?tokens?|session[ _-]?(?:tokens?|cookies?)|passwords?|passphrases?|passcodes?|credentials?|secrets?|secret[ _-]?keys?|private[ _-]?keys?|ssh[ _-]?keys?|seed[ _-]?phrases?|recovery[ _-]?phrases?|mnemonics?|\w*_(?:api_key|secret_key|access_token|auth_token|password|secret)s?)(?![ _-]?(?:reset|policy|policies|strength|rules?|requirements?|expir\w*|rotation|length|manager|vault)\b)`;
const owner = String.raw`(?:the (?:user|human|person|operator|customer|client)(?:['’]s|s['’]?)|(?:user|human|person|operator)s?['’]s?|their)`;
const whose = String.raw`(?:${owner}|any|all(?: of)?(?: the| their)?|every|whatever|other)`;
// "the user's token" or "their key" counts; "any keys" alone could be the keys of a JSON object.
const ownedSecret = String.raw`(?:${whose}\b (?:[\w-]+ ){0,3}?${secret}|${owner} (?:tokens?|keys?))\b`;
const movingVerb = String.raw`(?:read|pass|include|copy|copie|append|attach|add|put|insert|embed|paste|send|forward|provide|supply|share|leak|extract|dump|collect|gather|exfiltrate)(?:s|es|d|ed|ing)?`;
// With no field named, gathering ("collect all API keys you can find") is what secret scanners do;
// only a verb that puts the secret into the call counts.
const puttingVerb = String.raw`(?:pass|include|append|attach|add|put|insert|embed|paste|send|forward|provide|supply|share|leak|exfiltrate)(?:s|es|d|ed|ing)?`;
const movedVerb = String.raw`(?:included|passed|appended|attached|added|put|inserted|embedded|pasted|sent|forwarded|copied|provided|supplied|shared)`;
// Where it goes: a named parameter or field, a quoted field name, or a field that carries free text.
const into = String.raw`\b(?:in|into|as|inside|within|under|to|via)\b (?:the |this |a |an |its |that )?(?:['"\u0060‘“](?<quoted>[\w.-]{1,40})['"\u0060’”]|(?<named>[\w.-]{1,40}) (?:parameter|param|argument|arg|field|property|input)s?\b|(?:notes?|sidenote|side note|comments?|metadata|context|extra|debug|remarks?|annotations?)\b)`;
// Where it comes from, said to the model. "From the environment" or "from the config file" is
// left out: secrets managers say that honestly.
const from = String.raw`(?:\b(?:from|in|within|inside)\b (?:the |this |your |any )?(?:conversation|chat|context window|system prompt|other tools?|other servers?|other mcp servers?)\b|\byou can (?:find|see)\b|\bavailable to you\b)`;
// Negated when a negation sits up to four words before the verb in the same clause: "never
// include", "do not under any circumstances pass". Not when those words are "forget", "fail",
// "hesitate" or "miss": "do not forget to include" asks for it.
const notNegated = String.raw`(?<!(?:\b(?:not|never|nor|avoid\w*)|n['’]t)(?:\s+(?!(?:forget|fail|hesitate|miss)\w*\b)[\w'’,-]+){0,4}\s+)`;
const secretRequests = [
  new RegExp(String.raw`${notNegated}\b${movingVerb}\b[^.]{0,40}?\b${ownedSecret}[^.]{0,60}?${into}`, "gi"),
  new RegExp(String.raw`\b${ownedSecret}[^.]{0,30}?\b(?:must|should|needs? to|has to|have to|is to|are to|will) be ${movedVerb}\b[^.]{0,30}?${into}`, "gi"),
  new RegExp(String.raw`${notNegated}\b${puttingVerb}\b[^.]{0,40}?\b${ownedSecret}[^.]{0,60}?${from}`, "gi"),
];
const intoAnywhere = new RegExp(into, "gi");
// A parameter named for the secret is the honest place for it ("the user's token in the token
// field"). A field with a secret's word anywhere in its name counts; one named for the account
// ("user", "login", "header") counts only when that is its whole name, so "user_notes" does not.
const secretFieldWords = new Set(["key", "keys", "apikey", "token", "tokens", "secret", "secrets", "password", "passwords", "passwd", "pwd", "passphrase", "passcode", "pin", "otp", "credential", "credentials", "creds", "auth", "authorization", "authentication", "bearer", "cookie", "cookies"]);
const accountFieldNames = new Set(["user", "username", "login", "pass", "header", "headers"]);
function namedForSecret(field: string): boolean {
  const words = dottedWords(identifierWords(field)).toLowerCase().split(" ");
  return words.some((word) => secretFieldWords.has(word)) || (words.length === 1 && accountFieldNames.has(words[0] ?? ""));
}
const fieldOf = (match: RegExpExecArray) => match.groups?.quoted ?? match.groups?.named;

function asksForSecret(flat: string): RegExpExecArray | null {
  for (const [index, pattern] of secretRequests.entries()) {
    for (const match of flat.matchAll(pattern)) {
      const field = fieldOf(match);
      if (field && namedForSecret(field)) continue;
      // Taken from somewhere the model can see, but put in a field named for it: honest.
      if (index === 2) {
        const sentence = flat.slice(match.index, (flat.indexOf(".", match.index + match[0].length) + 1 || flat.length + 1) - 1);
        if ([...sentence.matchAll(intoAnywhere)].some((place) => { const named = fieldOf(place); return named !== undefined && namedForSecret(named); })) continue;
      }
      return match;
    }
  }
  return null;
}
const secretRule = { rule: "asks-for-secrets", severity: "high" as FindingSeverity, reason: "Asks for someone's password, key or token to be read or passed along, for example in a tool's input." };

// Base64 that decodes to words is text hidden from the person reading: high when what it says
// trips another check, medium when it only reads as text (it may be an honest example). A run
// that does not decode to words (a hash, an id, an image) is only worth a look when very long.
const longEncoded = /\b[A-Za-z0-9+/]{160,}={0,2}/;
const tripsACheck = (text: string) => asksForSecret(text) !== null || textRules.some(({ severity, pattern }) => severity !== "low" && pattern.test(text));

function encodedFinding(where: string, flat: string): Finding | null {
  let readable: Finding | null = null;
  for (const { run, decoded } of base64Runs(flat)) {
    if (decoded === null || !readsAsText(decoded)) continue;
    const excerpt = `${printable(run, 40)} decodes to: ${printable(decoded, 150)}`;
    if (tripsACheck(decoded.replace(/\s+/g, " "))) return { rule: "encoded-content", severity: "high", where, reason: "Contains base64 that decodes to text the other checks flag, such as an instruction to the model.", excerpt };
    readable ??= { rule: "encoded-content", severity: "medium", where, reason: "Contains base64 that decodes to readable text, which a person cannot read without decoding it.", excerpt };
  }
  if (readable) return readable;
  const long = longEncoded.exec(flat);
  return long ? { rule: "encoded-content", severity: "medium", where, reason: "Contains a long run of encoded text a person cannot read.", excerpt: excerptAround(flat, long.index, long[0].length) } : null;
}

const actWords: Record<string, string> = { write: "change things", send: "send things to other people", money: "move money", destructive: "delete or destroy things" };
const longDescription = 4_000;
const deepestSchema = 40;

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + length + 50);
  return `${start > 0 ? "…" : ""}${printable(text.slice(start, end), 200)}${end < text.length ? "…" : ""}`.replace(/……$/, "…");
}

/** Every piece of free text a model would read for this tool, with where it sits. */
export function modelFacingText(tool: ToolDefinition): Array<{ where: string; text: string; isName?: true }> {
  const out: Array<{ where: string; text: string; isName?: true }> = [{ where: "name", text: tool.name, isName: true }];
  if (tool.title) out.push({ where: "title", text: tool.title });
  if (tool.description) out.push({ where: "description", text: tool.description });
  const annotationTitle = tool.annotations?.title;
  if (typeof annotationTitle === "string") out.push({ where: "annotations.title", text: annotationTitle });

  // Any string under a schema can reach the model: descriptions, titles, defaults, enum values,
  // examples. Property names are text too.
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > deepestSchema) return;
    if (typeof node === "string") { out.push({ where: path, text: node }); return; }
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1)); return; }
    for (const [key, value] of Object.entries(node)) {
      const here = `${path}.${key}`;
      if (key === "properties" && typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const name of Object.keys(value)) out.push({ where: `${here}.${name} (name)`, text: name, isName: true });
      }
      // Keywords whose string values are structure, not prose.
      if (typeof value === "string" && (key === "type" || key === "format" || key === "$ref" || key === "$schema" || key === "pattern")) continue;
      if (key === "required" && Array.isArray(value)) continue;
      walk(value, here, depth + 1);
    }
  };
  walk(tool.inputSchema, "inputSchema", 0);
  walk(tool.outputSchema, "outputSchema", 0);
  return out;
}

export function findInTool(tool: ToolDefinition): Finding[] {
  const findings: Finding[] = [];

  for (const { where, text, isName } of modelFacingText(tool)) {
    const hidden = hiddenCharacters(text);
    if (hidden.length) {
      const spelled = tagText(text);
      findings.push(spelled
        ? { rule: "invisible-characters", severity: "high", where, reason: `Contains ${hidden.length} character${hidden.length === 1 ? "" : "s"} that cannot be seen on screen, some of them Unicode tag characters that spell out hidden text.`, excerpt: `hidden text spells: ${printable(spelled, 150)}` }
        : { rule: "invisible-characters", severity: "high", where, reason: `Contains ${hidden.length} character${hidden.length === 1 ? "" : "s"} that cannot be seen on screen.`, excerpt: excerptAround(text, hidden[0] ?? 0, 1) });
    }
    const flat = text.replace(/\s+/g, " ");
    // A name can hide a phrase as one identifier: ignore_previous_instructions, doNotTellUser.
    // The high and medium rules also read names split into words; the excerpt stays the name.
    const words = isName ? identifierWords(flat) : flat;
    const splitForms = isName ? [...new Set([words, dottedWords(words)])].filter((form) => form !== flat) : [];
    const check = (rule: string, severity: FindingSeverity, reason: string, find: (form: string) => RegExpExecArray | null, findInName = find) => {
      const match = find(flat);
      if (match) { findings.push({ rule, severity, where, reason, excerpt: excerptAround(flat, match.index, match[0].length) }); return; }
      if (severity === "low") return;
      if (splitForms.some((form) => findInName(form))) findings.push({ rule, severity, where, reason: `${reason} Found once the name was split into words.`, excerpt: excerptAround(flat, 0, flat.length) });
    };
    for (const { rule, severity, reason, pattern, inNames } of textRules) check(rule, severity, reason, (form) => pattern.exec(form), (form) => (inNames ?? pattern).exec(form));
    check(secretRule.rule, secretRule.severity, secretRule.reason, asksForSecret);
    const encoded = encodedFinding(where, flat);
    if (encoded) findings.push(encoded);
    if (where === "description" && text.length > longDescription) {
      findings.push({ rule: "very-long-description", severity: "low", where, reason: `The description is ${text.length.toLocaleString("en")} characters long, which is far more than describing a tool needs.`, excerpt: excerptAround(flat, 0, 120) });
    }
  }

  // A server's own claims about a tool, against a name that says otherwise.
  const suggested = nameSuggests(tool);
  const acts = suggested.filter((kind) => kind !== "read");
  if (tool.annotations?.readOnlyHint === true && acts.length) {
    findings.push({ rule: "annotation-mismatch", severity: "medium", where: "annotations.readOnlyHint", reason: `The server marks this tool read-only, but its name suggests it can ${acts.map((kind) => actWords[kind]).join(" and ")}.`, excerpt: printable(tool.name, 120) });
  } else if (tool.annotations?.destructiveHint === false && suggested.includes("destructive")) {
    findings.push({ rule: "annotation-mismatch", severity: "medium", where: "annotations.destructiveHint", reason: "The server marks this tool as not destructive, but its name suggests it deletes or removes something.", excerpt: printable(tool.name, 120) });
  }

  return findings;
}
