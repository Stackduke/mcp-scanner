import { nameSuggests } from "./risk.ts";
import { hiddenCharacters, printable } from "./text.ts";
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
interface TextRule { rule: string; severity: FindingSeverity; reason: string; pattern: RegExp }

// Patterns run on text whose whitespace has been collapsed to single spaces, so a line break
// in the middle of a phrase does not hide it.
const textRules: TextRule[] = [
  { rule: "instruction-override", severity: "high", reason: "Tells the model to disregard its other instructions.", pattern: /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|other|all|any|system)\b[^.]{0,20}\b(instructions?|rules?|prompts?|guidelines?|constraints?)\b/i },
  { rule: "concealment", severity: "high", reason: "Tells the model to keep something from the person it is working for.", pattern: /\b(do not|don't|never|without)\b[^.]{0,25}\b(tell|telling|inform|informing|mention|mentioning|reveal|revealing|notify|notifying|show|showing|alert|alerting|disclose|disclosing|ask|asking)\b[^.]{0,25}\b(the )?(user|human|person|operator)\b(?!['’]s)/i },
  { rule: "hidden-instruction-block", severity: "high", reason: "Contains a tag commonly used to smuggle instructions to a model.", pattern: /<\/?\s*(important|system|secret|instructions?|hidden|admin|priority|override)\s*>/i },
  { rule: "credential-store", severity: "high", reason: "Points at a place on a person's machine where credentials are kept.", pattern: /(~\/\.ssh|\bid_rsa\b|\bid_ed25519\b|~\/\.aws|\/etc\/(passwd|shadow)|\.npmrc\b|\.netrc\b|\bmcp\.json\b|~\/\.cursor|~\/\.config\/)/i },
  { rule: "send-elsewhere", severity: "high", reason: "Asks for data to be sent to an address or URL named in the text.", pattern: /\b(forward|bcc|transmit|exfiltrate|upload|send|post|email|include)\b[^.]{0,40}\b(data|contents?|text|output|results?|files?|conversation|history|context|credentials?|keys?|tokens?|secrets?|copy|everything|transcript)\b[^.]{0,40}\b(to|at)\b (https?:\/\/\S+|[\w.+-]+@[\w-]+\.[a-z]{2,})/i },
  { rule: "mentions-secrets", severity: "low", reason: "Mentions a secrets file or a private key. Often honest, for example a tool that loads its own configuration.", pattern: /((^|[\s"'`(/])\.env\b|\bprivate key\b|\bkeychain\b)/i },
  { rule: "model-directive", severity: "medium", reason: "Gives the model a standing order instead of describing what the tool does.", pattern: /\b(you|the (assistant|model|agent|ai)) (must|should|shall|need to|have to) (always|never|first|immediately)\b/i },
  { rule: "refers-to-other-tools", severity: "low", reason: "Tells the model how to use another tool. That is ordinary guidance inside one server, and worth a look if the tool it names belongs to a different one.", pattern: /\b(when(ever)?|before|after|instead of)\b[^.]{0,30}\b(using|calling|invoking|use|call|invoke)\b[^.]{0,30}\b(any other|another|other|the)\b[^.]{0,30}\b(tools?|servers?)\b/i },
  { rule: "encoded-content", severity: "medium", reason: "Contains a long run of encoded text a person cannot read.", pattern: /\b[A-Za-z0-9+/]{160,}={0,2}/ },
];

const longDescription = 4_000;
const deepestSchema = 40;

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + length + 50);
  return `${start > 0 ? "…" : ""}${printable(text.slice(start, end), 200)}${end < text.length ? "…" : ""}`.replace(/……$/, "…");
}

/** Every piece of free text a model would read for this tool, with where it sits. */
export function modelFacingText(tool: ToolDefinition): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [{ where: "name", text: tool.name }];
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
        for (const name of Object.keys(value)) out.push({ where: `${here}.${name} (name)`, text: name });
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

  for (const { where, text } of modelFacingText(tool)) {
    const hidden = hiddenCharacters(text);
    if (hidden.length) {
      findings.push({ rule: "invisible-characters", severity: "high", where, reason: `Contains ${hidden.length} character${hidden.length === 1 ? "" : "s"} that cannot be seen on screen.`, excerpt: excerptAround(text, hidden[0] ?? 0, 1) });
    }
    const flat = text.replace(/\s+/g, " ");
    for (const { rule, severity, reason, pattern } of textRules) {
      const match = pattern.exec(flat);
      if (match) findings.push({ rule, severity, where, reason, excerpt: excerptAround(flat, match.index, match[0].length) });
    }
    if (where === "description" && text.length > longDescription) {
      findings.push({ rule: "very-long-description", severity: "low", where, reason: `The description is ${text.length.toLocaleString("en")} characters long, which is far more than describing a tool needs.`, excerpt: excerptAround(flat, 0, 120) });
    }
  }

  // A server's own claims about a tool, against a name that says otherwise.
  const suggested = nameSuggests(tool);
  const acts = suggested.filter((kind) => kind !== "read");
  if (tool.annotations?.readOnlyHint === true && acts.length) {
    findings.push({ rule: "annotation-mismatch", severity: "medium", where: "annotations.readOnlyHint", reason: `The server marks this tool read-only, but its name suggests it can ${acts.join(", ")}.`, excerpt: printable(tool.name, 120) });
  } else if (tool.annotations?.destructiveHint === false && suggested.includes("destructive")) {
    findings.push({ rule: "annotation-mismatch", severity: "medium", where: "annotations.destructiveHint", reason: "The server marks this tool as not destructive, but its name suggests it deletes or removes something.", excerpt: printable(tool.name, 120) });
  }

  return findings;
}
