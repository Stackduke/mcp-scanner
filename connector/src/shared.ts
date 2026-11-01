/**
 * What the build script writes and the Worker reads, and the matching rules both use.
 * Pure: no Node or Workers APIs, so the build (Node) and the Worker share one copy.
 */

export const kinds = ["money", "destructive", "send", "write", "unclear", "read"] as const;
export type Kind = (typeof kinds)[number];

/** Tool names are kept only when they look like identifiers: the characters and length MCP tool names use. */
export const toolNamePattern = /^[A-Za-z0-9_./-]{1,128}$/;
/** Registry names, as the tracker already confines them. */
export const registryNamePattern = /^[A-Za-z0-9_./-]{1,100}$/;

export interface ChangeRecord {
  /** The check that saw the change. */
  at: string;
  /** The last check before it that listed tools. The change happened between the two. */
  since: string;
  added: string[];
  removed: string[];
  changed: Array<{ name: string; fields: string[] }>;
  more_serious: Array<{ name: string; kind: Kind }>;
  counts: { added: number; removed: number; changed: number; more_serious: number };
}

export interface ServerRecord {
  /** The tracker's id: the first 12 hex characters of the sha256 of the address. */
  id: string;
  url: string;
  registry_names: string[];
  /** Set for the official servers the tracker follows by name (catalog/tracker-public.json). */
  featured?: { id: string; name: string; site: string };
  first_seen?: string;
  last_checked?: string;
  last_listed?: string;
  latest_outcome?: string;
  checks_last_30_days?: number;
  listed_last_30_days?: number;
  changes_last_30_days?: number;
  last_change?: string;
  tool_count?: number;
  kind_counts: Partial<Record<Kind, number>>;
  tools_by_kind: Partial<Record<Kind, string[]>>;
  /** What the server says about its own tools in its annotations: its claims, not the scanner's guesses. */
  server_annotations?: { read_only: number; changes: number; destructive: number; none: number };
  /** Newest first. The tracker keeps the last 10. */
  changes: ChangeRecord[];
  names_withheld: number;
}

export interface NameEntry { ids: string[]; total: number }

export interface Meta {
  version: 1;
  /** When the tracker made the data. */
  generated_at: string;
  /** When this build was made from it. */
  built_at: string;
  servers: number;
  featured: number;
  names_withheld: number;
  /** Sites of vendors whose terms forbid publishing about them. Nothing is said about any address on them. */
  forbidden_sites: string[];
  /** Catalog ids and names of those vendors, as name keys. */
  forbidden_names: string[];
  /** Catalog servers the tracker does not publish (tracked privately, or terms not read yet). */
  unpublished_urls: string[];
  unpublished_names: string[];
}

/** The key a name is filed under: lower case, with runs of spaces made one. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** Whether a host is one of the given sites or any name under one. */
export function onSite(host: string, sites: Iterable<string>): boolean {
  const bare = host.toLowerCase();
  for (const site of sites) if (bare === site || bare.endsWith(`.${site}`)) return true;
  return false;
}

/** The host a registry name's namespace points at: "io.sentry/mcp" is under sentry.io. */
export function namespaceHost(name: string): string | null {
  const slash = name.indexOf("/");
  if (slash <= 0) return null;
  const labels = name.slice(0, slash).toLowerCase().split(".");
  return labels.length >= 2 ? labels.reverse().join(".") : null;
}
