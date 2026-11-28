import { scannableAddress } from "../../src/registry.ts";
import { MATCHES_SHOWN } from "./config.ts";
import { endpointId, meta, serverById, serversByName } from "./data.ts";
import type { AssetFetcher } from "./data.ts";
import { nameKey, namespaceHost, onSite } from "./shared.ts";
import type { Meta, ServerRecord } from "./shared.ts";

/** What a `url_or_name` turned out to be. */
export type Resolution =
  | { kind: "found"; server: ServerRecord; meta: Meta }
  | { kind: "several"; servers: ServerRecord[]; total: number; meta: Meta }
  /** A server the catalog says nothing about: forbidden by its terms, or not published. */
  | { kind: "no_data"; meta: Meta }
  /** A public https address the tracker has not looked at. It may be queued. */
  | { kind: "unknown_address"; url: string; meta: Meta }
  | { kind: "unknown_name"; meta: Meta }
  | { kind: "bad_input"; message: string };

const looksLikeAddress = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const plainName = /^[A-Za-z0-9 ._/-]{1,200}$/;

/**
 * Finds what the caller means. Forbidden servers are checked first, so nothing about them is
 * looked up at all. Addresses must pass the crawl's own rule (`scannableAddress`: https, no login
 * in the address, no bare IP address or private host name).
 */
export async function resolve(assets: AssetFetcher, input: string): Promise<Resolution> {
  const query = input.trim();
  if (!query || query.length > 500 || /[\u0000-\u001f\u007f]/.test(query)) {
    return { kind: "bad_input", message: "url_or_name must be 1 to 500 printable characters: the server's https address or its name in the official MCP registry." };
  }

  if (looksLikeAddress.test(query)) {
    const url = scannableAddress(query);
    if (!url) {
      return {
        kind: "bad_input",
        message: "The tracker only checks public https addresses, with no user name or password in them and no bare IP address or private host name (such as localhost). For a local or private server, run the scanner on your own machine: npx @stackduke/mcp-scanner check <address>",
      };
    }
    const data = await meta(assets);
    if (onSite(new URL(url).hostname, data.forbidden_sites)) return { kind: "no_data", meta: data };
    for (const candidate of variants(url)) {
      const server = await serverById(assets, await endpointId(candidate));
      if (server && server.url === candidate) return { kind: "found", server, meta: data };
    }
    if (variants(url).some((candidate) => data.unpublished_urls.includes(candidate))) return { kind: "no_data", meta: data };
    return { kind: "unknown_address", url, meta: data };
  }

  if (!plainName.test(query)) {
    return { kind: "bad_input", message: "A name may use letters, digits, spaces and . _ / - only. Give the server's name in the official MCP registry (such as io.github.owner/server) or its https address." };
  }
  const data = await meta(assets);
  const key = nameKey(query);
  const host = namespaceHost(key);
  if (data.forbidden_names.includes(key) || (host !== null && onSite(host, data.forbidden_sites))) return { kind: "no_data", meta: data };
  const entry = await serversByName(assets, key);
  if (entry && entry.ids.length) {
    const servers = (await Promise.all(entry.ids.slice(0, MATCHES_SHOWN).map((id) => serverById(assets, id)))).filter((server): server is ServerRecord => server !== undefined);
    if (servers.length === 1 && entry.total === 1) return { kind: "found", server: servers[0] as ServerRecord, meta: data };
    if (servers.length) return { kind: "several", servers, total: entry.total, meta: data };
  }
  if (data.unpublished_names.includes(key)) return { kind: "no_data", meta: data };
  return { kind: "unknown_name", meta: data };
}

/** The address as given, and with its trailing slash added or taken off: the registry lists both kinds. */
function variants(url: string): string[] {
  const parsed = new URL(url);
  if (parsed.search) return [url];
  if (parsed.pathname === "/") return [url];
  return [url, url.endsWith("/") ? url.slice(0, -1) : `${url}/`];
}
