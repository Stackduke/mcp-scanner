/**
 * The remote servers listed in the official MCP registry.
 *
 * Only the latest version of each entry is read, and only its Streamable HTTP endpoints are kept.
 * An endpoint is kept when it is a plain https address a scanner could reach without filling
 * anything in: no {placeholders}, no login in the address, no address on a private network.
 * Everything the registry returns was written by whoever published the entry, and is data.
 */
export const registryAddress = "https://registry.modelcontextprotocol.io/v0.1/servers";

export interface RegistryEntry {
  /** The entry's name, such as "app.linear/linear". Namespaced by the registry, chosen by the publisher. */
  name: string;
  version: string;
  status: string;
  urls: string[];
}

export interface RegistryRead {
  entries: RegistryEntry[];
  /** False when the registry stopped answering before the last page: what is missing is not known to be gone. */
  complete: boolean;
  pages: number;
}

export interface RegistryOptions {
  fetchImpl?: typeof fetch;
  base?: string;
  /** Stop after this many pages, so a registry that never ends cannot hold the run open. */
  maxPages?: number;
  /** A pause between pages, to keep the load on the registry light. */
  pauseMs?: number;
  userAgent?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A host no public scan has reason to visit: a bare address, this machine, or a name only a private network knows. */
function privateHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^[\d.]+$/.test(bare) || bare.includes(":")) return true;
  return bare === "localhost" || /\.(localhost|local|internal|lan|home|arpa)$/.test(bare) || !bare.includes(".");
}

/** The address as it will be scanned, or null when it is not one this scanner visits. */
export function scannableAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500 || /[{}\s]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || privateHost(url.hostname)) return null;
  return url.href;
}

/** One registry item, kept only when it has the shape the registry documents. */
export function readEntry(item: unknown): RegistryEntry | null {
  const server = isRecord(item) && isRecord(item.server) ? item.server : null;
  if (!server || typeof server.name !== "string" || !server.name || server.name.length > 200) return null;
  const meta = isRecord(item) && isRecord(item._meta) ? item._meta["io.modelcontextprotocol.registry/official"] : undefined;
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const urls = [...new Set(remotes.flatMap((remote) => (isRecord(remote) && remote.type === "streamable-http" ? [scannableAddress(remote.url)] : [])).filter((url): url is string => url !== null))];
  return {
    name: server.name,
    version: typeof server.version === "string" ? server.version.slice(0, 100) : "",
    status: isRecord(meta) && typeof meta.status === "string" ? meta.status.slice(0, 40) : "",
    urls,
  };
}

export async function readRegistry({ fetchImpl = fetch, base = registryAddress, maxPages = 2_000, pauseMs = 150, userAgent }: RegistryOptions = {}): Promise<RegistryRead> {
  const entries: RegistryEntry[] = [];
  let cursor: string | undefined, pages = 0;
  while (pages < maxPages) {
    const url = new URL(base);
    url.searchParams.set("limit", "100");
    url.searchParams.set("version", "latest");
    if (cursor) url.searchParams.set("cursor", cursor);
    let body: unknown;
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json", ...(userAgent ? { "User-Agent": userAgent } : {}) }, signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!response.ok) break;
      body = await response.json();
    } catch { break; }
    pages += 1;
    if (!isRecord(body) || !Array.isArray(body.servers)) break;
    for (const item of body.servers) { const entry = readEntry(item); if (entry) entries.push(entry); }
    const next = isRecord(body.metadata) && typeof body.metadata.nextCursor === "string" ? body.metadata.nextCursor : "";
    if (!next || next === cursor) return { entries, complete: true, pages };
    cursor = next;
    if (pauseMs) await pause(pauseMs);
  }
  return { entries, complete: false, pages };
}
