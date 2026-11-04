import { confined } from "./authority.ts";

/**
 * Reads the list of MCP servers an agent is set up to use, from the config file the agent's
 * client keeps: `mcpServers` (Claude Desktop, Claude Code's `.mcp.json`, Cursor, Windsurf, Cline)
 * or `servers` (VS Code's `mcp.json`).
 *
 * Only what is needed to reach each server is kept. Headers are dropped: `reach` sends no
 * credential. A local program's environment is kept, because the program may need it to start,
 * and is only ever handed to that program, never printed or written anywhere.
 */
export type AgentServer =
  | { name: string; kind: "remote"; url: string }
  | { name: string; kind: "local"; command: string[]; env: Record<string, string> }
  /** In the config, but not something this command can look at, or switched off there. */
  | { name: string; kind: "skipped"; why: "switched-off" | "bad-entry"; detail: string };

export interface AgentConfig { label: string; servers: AgentServer[] }

/** Far more than any agent is set up with. */
const mostServers = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const serverName = (name: string) => confined(name, /[^A-Za-z0-9_.-]+/g, 40) || "(no name)";

/** A loopback address, where plain http is allowed: a server running on this machine. */
const isLoopback = (host: string) => host === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]";

/** Whether `reach` may ask this address for its tools: https, or http on this machine, with no user name or password in it. */
export function usableAddress(text: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try { url = new URL(text); } catch { return { ok: false, reason: "not a web address" }; }
  if (url.username || url.password) return { ok: false, reason: "the address has a user name or password in it, and reach sends no credential" };
  if (!(url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname)))) return { ok: false, reason: "only https:// addresses are read, and http:// only on this machine" };
  return { ok: true, url };
}

/** Path parts after which the next part is taken to be a key, whatever it looks like. */
const keyWords = new Set(["s", "k", "key", "keys", "token", "tokens", "secret", "secrets", "apikey", "api-key", "api_key", "auth", "access", "session"]);

/**
 * Whether a path part reads like a word someone chose ("mcp", "v1", "github-mcp-server") rather
 * than a generated key. Random keys are long runs with no separator, or mix case and digits.
 * When unsure the part is hidden: a hidden word costs a little clarity, a shown key costs a leak.
 */
function looksLikeWord(part: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,30}$/.test(part)) return false;
  if (part.replace(/[^0-9]/g, "").length >= 6) return false;
  if (part.length > 24 || (part.length > 16 && !/[-_.]/.test(part))) return false;
  if (part.length >= 8 && /[0-9]/.test(part) && /[a-z]/.test(part) && /[A-Z]/.test(part)) return false;
  return true;
}

/**
 * The address as reports show and store it: scheme, host and path, with no query, fragment or
 * login, and any path part that looks like a key replaced by "…". Some servers put a key in the
 * path or the query, and a report must never carry one.
 */
export function addressOf(url: URL): string {
  let afterKeyWord = false;
  const parts = url.pathname.split("/").map((part) => {
    if (!part) return part;
    let decoded = part;
    try { decoded = decodeURIComponent(part); } catch { /* keep as given */ }
    const keep = !afterKeyWord && looksLikeWord(decoded);
    afterKeyWord = keyWords.has(decoded.toLowerCase());
    return keep ? decoded : "…";
  });
  const pathname = parts.join("/").replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

export function readAgentConfig(text: string, label: string): { ok: true; config: AgentConfig } | { ok: false; reason: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: "it is not JSON" }; }
  if (!isRecord(parsed)) return { ok: false, reason: "it is not a JSON object" };
  const listed = isRecord(parsed.mcpServers) ? parsed.mcpServers : isRecord(parsed.servers) ? parsed.servers : null;
  if (!listed) return { ok: false, reason: "it has no \"mcpServers\" or \"servers\" list" };
  const entries = Object.entries(listed);
  if (entries.length > mostServers) return { ok: false, reason: `it lists more than ${mostServers} servers` };

  const servers: AgentServer[] = entries.map(([rawName, entry]): AgentServer => {
    const name = serverName(rawName);
    if (!isRecord(entry)) return { name, kind: "skipped", why: "bad-entry", detail: "the entry is not an object" };
    if (entry.disabled === true || entry.enabled === false) return { name, kind: "skipped", why: "switched-off", detail: "switched off in the config" };
    const address = typeof entry.url === "string" ? entry.url : typeof entry.serverUrl === "string" ? entry.serverUrl : null;
    if (address !== null && entry.type !== "stdio") {
      const usable = usableAddress(address);
      return usable.ok ? { name, kind: "remote", url: usable.url.href } : { name, kind: "skipped", why: "bad-entry", detail: usable.reason };
    }
    if (typeof entry.command === "string" && entry.command.trim()) {
      const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
      const env = isRecord(entry.env) ? Object.fromEntries(Object.entries(entry.env).filter((pair): pair is [string, string] => typeof pair[1] === "string")) : {};
      return { name, kind: "local", command: [entry.command, ...args], env };
    }
    return { name, kind: "skipped", why: "bad-entry", detail: "the entry has no url and no command" };
  });
  return { ok: true, config: { label, servers } };
}
