/**
 * Draws the tools for a label-accuracy set from the tracker's data, and lists them fresh.
 *
 *   git archive origin/data lookup.json endpoints.jsonl lists | tar -x -C <folder>
 *   node eval/build-sample.ts --data=<folder> --out=eval/labels-2026-11.jsonl [--seed=20261101] [--per-cell=18]
 *     [--exclude=eval/labels-2026-11.jsonl] [--id-prefix=t]
 *
 * This was run once to make the set; the set itself is what `eval/score.ts` reads, so nobody needs
 * to run this again unless they want a new set. It uses the network: for each server it picks, it
 * makes the scanner's own `listTools` request (initialize, then tools/list), exactly what `scan`
 * does. It never calls a tool and sends no credential.
 *
 * The pool is every server in `lookup.json` that listed its tools without a sign-in on the latest
 * scan date, less the sites the catalog marks forbidden and every server and site in the sets named
 * by `--exclude` (so a holdout shares nothing with the set the rules were tuned on). Each tool
 * listed fresh is put in a cell: the kind the current rules give it, and whether the server's own
 * annotations decided it or the words in the name or description did. "unclear" is one cell.
 *
 * Servers are drawn at random with a fixed seed. The common cells (read, write, unclear), and the
 * counts used to split each kind between annotations and words, take only servers drawn uniformly
 * from the whole pool. The rare cells (destructive, money, send) also take servers drawn from those
 * the tracker counted that kind on, or they would take thousands of servers to fill. The set takes
 * up to `--per-cell` tools at random from each cell, at most one per server in a cell and three per
 * site overall, rarest cells first, so no single server decides a result.
 *
 * Expected labels are left empty, to be written without looking at the scanner's label.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assessTool, type AuthorityKind } from "../src/authority.ts";
import { listTools } from "../src/client.ts";
import { takeSnapshot } from "../src/snapshot.ts";
import { keptOffSites } from "../src/track.ts";
import { siteOf } from "../src/tracker.ts";
import type { SnapshotTool } from "../src/types.ts";
import { cellOf, cells, type Cell, type SetEntry } from "./score.ts";

const option = (name: string, fallback?: string): string => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (found) return found.slice(name.length + 3);
  if (fallback === undefined) throw new Error(`--${name}=... is needed`);
  return fallback;
};
const dataDir = option("data");
const out = option("out");
const seed = Number(option("seed", "20261101"));
const perCell = Number(option("per-cell", "18"));
const maxScans = Number(option("max-scans", "900"));
const idPrefix = option("id-prefix", "t");
const excluded = option("exclude", "").split(",").filter(Boolean).flatMap((path) => readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => (JSON.parse(line) as { server: string }).server));

/** A small seeded generator (mulberry32), so the same seed draws the same servers. */
function random(start: number): () => number {
  let state = start >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const next = random(seed);
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

type LookupRow = [string, string, number, string, number, Partial<Record<AuthorityKind, number>>];
const rows = (JSON.parse(readFileSync(join(dataDir, "lookup.json"), "utf8")) as { rows: LookupRow[] }).rows;
const latest = rows.reduce((max, row) => (row[3] > max ? row[3] : max), "");
const outcomes = new Map<string, string | undefined>();
for (const line of readFileSync(join(dataDir, "endpoints.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const endpoint = JSON.parse(line) as { url: string; outcome?: string };
  outcomes.set(endpoint.url, endpoint.outcome);
}
const forbidden = keptOffSites();
const safeSite = (url: string) => { try { return siteOf(url); } catch { return null; } };
const excludedSites = new Set(excluded.map((url) => safeSite(url) ?? url));
const excludedUrls = new Set(excluded);
const pool = rows.filter((row) => row[3] === latest && outcomes.get(row[1]) === "listed" && row[1].startsWith("https://") && !forbidden.has(safeSite(row[1]) ?? "") && !excludedUrls.has(row[1]) && !excludedSites.has(safeSite(row[1]) ?? row[1]));

// Which kinds the tracker counted on each server, from the saved lists, to reach rare kinds first.
const listedKinds = new Map<string, Set<string>>();
for (const folder of readdirSync(join(dataDir, "lists"))) {
  for (const file of readdirSync(join(dataDir, "lists", folder))) {
    const list = JSON.parse(readFileSync(join(dataDir, "lists", folder, file), "utf8")) as { source: string; tools: Array<{ kind: string }> };
    listedKinds.set(list.source, new Set(list.tools.map((tool) => tool.kind)));
  }
}
const rare: AuthorityKind[] = ["destructive", "money", "send"];
const uniform = shuffle(pool);
const queues = new Map<AuthorityKind, LookupRow[]>(rare.map((kind) => [kind, shuffle(pool.filter((row) => listedKinds.get(row[1])?.has(kind)))]));

interface Found { url: string; site: string; tool: SnapshotTool; cell: Cell }
const bags = new Map<Cell, Found[]>(cells.map((cell) => [cell, []]));
/** Every tool from every server drawn uniformly, by cell: used to split each kind by source. */
const seen = new Map<Cell, number>(cells.map((cell) => [cell, 0]));
const scanned = new Set<string>();
const results = { listed: 0, failed: 0, listedUniformly: 0 };

const kindOfCell = (cell: Cell) => cell.split("/")[0] as AuthorityKind;
const short = () => cells.filter((cell) => new Set((bags.get(cell) ?? []).map((found) => found.url)).size < perCell * 3);

const isRare = (cell: Cell) => rare.includes(kindOfCell(cell));

async function scanOne(row: LookupRow, drawnUniformly: boolean): Promise<void> {
  const url = row[1];
  const result = await listTools(url);
  if (result.outcome !== "listed") { results.failed += 1; return; }
  results.listed += 1;
  if (drawnUniformly) results.listedUniformly += 1;
  const snapshot = takeSnapshot(url, result.tools, result.server);
  const site = safeSite(url) ?? url;
  for (const tool of snapshot.tools) {
    const cell = cellOf(assessTool(tool).tool);
    if (drawnUniformly) seen.set(cell, (seen.get(cell) ?? 0) + 1);
    if (drawnUniformly || isRare(cell)) bags.get(cell)?.push({ url, site, tool, cell });
  }
}

// Uniform draws continue until the common cells are full and at least a third of the scans are uniform,
// so the split between annotations and words rests on enough servers.
const uniformScans = () => [...scanned].filter((url) => uniformlyDrawn.has(url)).length;
const uniformlyDrawn = new Set<string>();
while (scanned.size < maxScans && short().length) {
  const wantedRare = [...new Set(short().filter(isRare).map(kindOfCell))];
  const wantUniform = short().some((cell) => !isRare(cell)) || uniformScans() < scanned.size / 3;
  const batch: Array<{ row: LookupRow; drawnUniformly: boolean }> = [];
  const sources: Array<{ queue: LookupRow[]; drawnUniformly: boolean }> = [
    ...(wantUniform ? [{ queue: uniform, drawnUniformly: true }] : []),
    ...wantedRare.map((kind) => ({ queue: queues.get(kind) ?? [], drawnUniformly: false })),
  ];
  const each = Math.ceil(12 / Math.max(1, sources.length));
  for (const source of sources) {
    let taken = 0;
    while (source.queue.length && taken < each) {
      const row = source.queue.shift() as LookupRow;
      if (scanned.has(row[1])) continue;
      scanned.add(row[1]);
      if (source.drawnUniformly) uniformlyDrawn.add(row[1]);
      batch.push({ row, drawnUniformly: source.drawnUniformly });
      taken += 1;
    }
  }
  if (!batch.length) break;
  await Promise.all(batch.map(({ row, drawnUniformly }) => scanOne(row, drawnUniformly).catch(() => { results.failed += 1; })));
  process.stderr.write(`\rscanned ${scanned.size}, listed ${results.listed}; short: ${short().join(" ") || "none"}   `);
}
process.stderr.write("\n");

const perSite = new Map<string, number>();
const chosen: Found[] = [];
// Rarest first, so the common cells do not use up a site's share before the rare ones get any.
for (const cell of [...cells].sort((a, b) => Number(isRare(b)) - Number(isRare(a)) || (bags.get(a)?.length ?? 0) - (bags.get(b)?.length ?? 0))) {
  const usedServers = new Set<string>();
  // Replies arrive in network order; sorting first makes the draw depend on the seed alone.
  const bag = [...(bags.get(cell) ?? [])].sort((x, y) => `${x.url} ${x.tool.name}`.localeCompare(`${y.url} ${y.tool.name}`));
  for (const found of shuffle(bag)) {
    if (chosen.filter((item) => item.cell === cell).length >= perCell) break;
    if (usedServers.has(found.url) || (perSite.get(found.site) ?? 0) >= 3) continue;
    usedServers.add(found.url);
    perSite.set(found.site, (perSite.get(found.site) ?? 0) + 1);
    chosen.push(found);
  }
}

const takenOn = new Date().toISOString().slice(0, 10);
const inCellOrder = [...chosen].sort((a, b) => cells.indexOf(a.cell) - cells.indexOf(b.cell));
const lines = inCellOrder.map((found, index): SetEntry => ({
  id: `${idPrefix}${String(index + 1).padStart(3, "0")}`,
  server: found.url,
  takenOn,
  tool: { name: found.tool.name, ...(found.tool.title ? { title: found.tool.title } : {}), ...(found.tool.description ? { description: found.tool.description } : {}), ...(found.tool.inputSchema ? { inputSchema: found.tool.inputSchema } : {}), ...(found.tool.annotations ? { annotations: found.tool.annotations } : {}) },
  sampledAs: found.cell,
  expected: [],
  reason: "",
}));
writeFileSync(out, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
const meta = { seed, perCell, dataDate: latest, pool: pool.length, excludedServers: excludedUrls.size, scanned: scanned.size, ...results, toolsSeenByCell: Object.fromEntries(seen), kindCountsInTracker: pool.reduce<Record<string, number>>((sum, row) => { for (const [kind, count] of Object.entries(row[5])) sum[kind] = (sum[kind] ?? 0) + (count ?? 0); return sum; }, {}) };
writeFileSync(out.replace(/\.jsonl$/, ".meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
console.log(`${lines.length} tools written to ${out}`);
console.log(JSON.stringify(meta, null, 2));
