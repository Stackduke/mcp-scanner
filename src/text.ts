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
