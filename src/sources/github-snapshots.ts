import { readTool } from "../client.ts";
import { takeSnapshot } from "../snapshot.ts";
import type { Snapshot, ToolDefinition } from "../types.ts";

/**
 * Builds a snapshot from tool definitions a project publishes as files in its repository,
 * at one tag or commit. GitHub's own MCP server keeps one JSON file per tool under
 * `__toolsnaps__`, which makes its history readable without running it or signing in.
 *
 * Only files are read. No code from the repository is downloaded to run or executed.
 */
export interface RepositorySnapshotOptions {
  /** `owner/name`. */
  repository: string;
  /** A tag, branch or commit. */
  ref: string;
  /** Files are taken from any directory with this name. */
  directory?: string;
  fetchImpl?: typeof fetch;
  /** Optional GitHub token, for a higher rate limit on the one listing request. Never logged. */
  token?: string;
}

export async function snapshotFromRepository({ repository, ref, directory = "__toolsnaps__", fetchImpl = fetch, token }: RepositorySnapshotOptions): Promise<Snapshot> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("repository must look like owner/name");
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "aethis-mcp-scanner/0.1 (+https://aethis.io)" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const listing = await fetchImpl(`https://api.github.com/repos/${repository}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!listing.ok) throw new Error(`could not list ${repository} at ${ref}: ${listing.status}`);
  const tree = (await listing.json()) as { tree?: Array<{ path?: string; type?: string }>; truncated?: boolean };
  if (tree.truncated) throw new Error(`the file listing for ${repository} at ${ref} was cut short; the snapshot would be incomplete`);

  const paths = (tree.tree ?? []).filter((entry) => entry.type === "blob" && typeof entry.path === "string" && entry.path.split("/").at(-2) === directory).map((entry) => entry.path as string).sort();
  if (!paths.length) throw new Error(`no files under a "${directory}" directory in ${repository} at ${ref}`);

  const read: Array<{ stem: string; path: string; tool: ToolDefinition }> = [];
  const unreadable: string[] = [];
  // A few at a time: enough to be quick, few enough to be a polite reader.
  for (let index = 0; index < paths.length; index += 8) {
    const batch = await Promise.all(paths.slice(index, index + 8).map(async (path) => {
      const response = await fetchImpl(`https://raw.githubusercontent.com/${repository}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: { "User-Agent": headers["User-Agent"] as string }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return { path, tool: null };
      try { return { path, tool: readTool(JSON.parse(await response.text())) }; } catch { return { path, tool: null }; }
    }));
    for (const { path, tool } of batch) { if (tool) read.push({ stem: (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, ""), path, tool }); else unreadable.push(path); }
  }
  // A partial snapshot would make missing files look like removed tools.
  if (unreadable.length) throw new Error(`${unreadable.length} of ${paths.length} definition files could not be read (first: ${unreadable[0]})`);

  // A project may publish several definitions of one tool, for example one per feature flag.
  // The file named after the tool is its plain definition. Any other file is a variant named
  // after its file, at every tag, so a definition keeps one identity across releases and a
  // change that arrives only in a variant is not hidden.
  const keys = new Set<string>();
  const tools = read.map(({ stem, path, tool }) => {
    let variant = stem === tool.name ? undefined : stem;
    // Two directories can hold a file of the same name; the path tells them apart.
    if (keys.has(`${tool.name}#${variant ?? ""}`)) variant = path.replace(/\.[^./]+$/, "");
    keys.add(`${tool.name}#${variant ?? ""}`);
    return variant ? { ...tool, variant } : tool;
  });
  return takeSnapshot(`github:${repository}@${ref}`, tools);
}
