/**
 * Everything a server sends is untrusted, including the names of its tools. Before any of it
 * is printed, characters that could redraw the terminal, start a new line or hide text are
 * replaced by a visible marker, so a server cannot forge lines in a report.
 */
// Zero-width and bidirectional controls, soft hyphen, fillers that render as nothing, and the
// Unicode tag and variation-selector-supplement blocks.
const hiddenAlways = /[​‎‏‪-‮⁠-⁤⁦-⁩﻿­᠎؜ᅟᅠㅤﾠ⠀]|\uDB40[\uDC00-\uDDEF]/g;
// Joiners are ordinary inside emoji sequences and several scripts. Between two plain ASCII
// characters they have no honest use.
const joinerBetweenAscii = /(?<=[\x20-\x7E])[‌‍]+(?=[\x20-\x7E])/g;
// C0 controls, DEL and C1 controls. Tab, newline and carriage return are handled as whitespace.
const controls = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

const marker = (char: string) => `⟦U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟧`;

/** Where each invisible character sits in a text. */
export function hiddenCharacters(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(hiddenAlways)) found.push(match.index);
  for (const match of text.matchAll(joinerBetweenAscii)) for (let offset = 0; offset < match[0].length; offset += 1) found.push(match.index + offset);
  return found.sort((a, b) => a - b);
}

/** A single line that is safe to print: nothing invisible, no control characters, no line breaks. */
export function printable(text: string, maxLength = 200): string {
  const cleaned = text
    .replace(hiddenAlways, marker)
    .replace(joinerBetweenAscii, (run) => [...run].map(marker).join(""))
    .replace(controls, marker)
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/**
 * An identifier as spaced words: snake_case, kebab-case and camelCase are split, so a phrase
 * hidden in a name can be read like any other. Dots are kept; `dottedWords` splits those too.
 */
export function identifierWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const dottedWords = (words: string) => words.replace(/\.+/g, " ").replace(/\s+/g, " ").trim();

// The printable ASCII range written in Unicode tag characters (U+E0020 to U+E007E). They show as
// nothing, but a model can read them as letters.
const tagCharacters = /\uDB40[\uDC20-\uDC7E]/g;

/** What a text's Unicode tag characters spell, in ASCII, or "" when it has none. */
export function tagText(text: string): string {
  return [...text.matchAll(tagCharacters)].map((match) => String.fromCharCode((match[0].codePointAt(0) ?? 0) - 0xe0000)).join("");
}

// A run that could be base64, in the standard or the URL-safe alphabet.
const base64Run = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{60,}={0,2}/g;
const utf8 = new TextDecoder("utf-8");

/**
 * Decodes a base64 run as UTF-8. Bytes that are not UTF-8 become U+FFFD, so one bad byte does not
 * hide the rest. Returns null when the run mixes the two alphabets and cannot be base64.
 */
export function decodeBase64(run: string): string | null {
  let body = run.replace(/=+$/, "");
  if (/[+/]/.test(body) && /[_-]/.test(body)) return null;
  body = body.replace(/-/g, "+").replace(/_/g, "/");
  body = body.slice(0, body.length - (body.length % 4 === 1 ? 1 : 0));
  try {
    const binary = atob(body + "=".repeat((4 - (body.length % 4)) % 4));
    return utf8.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * Whether decoded text reads as words a person or model would read: almost all printable,
 * mostly letters and spaces, several words. Binary data, and JSON made mostly of ids and
 * numbers (as in the middle part of a JWT), does not.
 */
export function readsAsText(decoded: string): boolean {
  const chars = [...decoded];
  if (chars.length < 20) return false;
  const printableShare = chars.filter((char) => char !== "\uFFFD" && /[\p{L}\p{N}\p{P}\p{S}\p{Zs}\t\n\r]/u.test(char)).length / chars.length;
  const wordShare = chars.filter((char) => /[\p{L}\s]/u.test(char)).length / chars.length;
  const words = decoded.split(/\s+/).filter((word) => /\p{L}{2,}/u.test(word)).length;
  return printableShare >= 0.95 && wordShare >= 0.7 && words >= 4;
}

/** Each base64-like run of 60 or more characters in a text, with its decoded text when there is any. */
export function base64Runs(text: string): Array<{ index: number; run: string; decoded: string | null }> {
  return [...text.matchAll(base64Run)].map((match) => ({ index: match.index, run: match[0], decoded: decodeBase64(match[0]) }));
}
