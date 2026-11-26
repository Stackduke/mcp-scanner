import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { planScan } from "../src/radar-layout.ts";
import { folderStore, publish, scanInputFromFolder } from "../src/radar-publish.ts";
import { hostBudgetMinutes, track } from "../src/track.ts";

/**
 * The uploader against what the real tracker writes: its manifest, .gitattributes, hosts.json and lists, over two
 * days. Servers are answered in this process; nothing leaves it.
 */
const temporary: string[] = [];
after(async () => { for (const folder of temporary) await rm(folder, { recursive: true, force: true }); });
const made = async (prefix: string) => { const dir = await mkdtemp(path.join(tmpdir(), prefix)); temporary.push(dir); return dir; };

const start = Date.parse("2026-11-20T04:17:00.000Z"), day = 24 * 3_600_000, minute = 60_000;
const urls = ["https://busy.example.com/a", "https://busy.example.com/b", "https://calm.example.com/mcp"];

async function trackOnce(dataDir: string, at: number) {
  let clock = at;
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://registry.modelcontextprotocol.io/")) return Response.json({ servers: urls.map((address, index) => ({ server: { name: `com.example/server-${index}`, remotes: [{ type: "streamable-http", url: address }] } })), metadata: {} });
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    // The busy host uses up its time on its first server, so the run counts it in hosts.json.
    if (body.method === "initialize") {
      if (url.includes("busy")) clock += (hostBudgetMinutes + 1) * minute;
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "Demo" } } });
    }
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "get_page", annotations: { readOnlyHint: true } }] } });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  await track({ dataDir, readRegistry: true, maxChecks: 50, perHost: 30, perSite: 50, concurrency: 1, hostGapMs: 0, budgetMinutes: 120, publicServers: [], environment: {}, fetchImpl, now: () => new Date(clock) });
}

test("a folder the tracker wrote publishes as it is, day after day, with hosts.json and without .gitattributes", async () => {
  const dataDir = await made("radar-track-");
  // The data branch's README is in the folder, though no scan writes it.
  await writeFile(path.join(dataDir, "README.md"), "Radar's data.\n");
  const out = await made("radar-track-out-");
  const ids: string[] = [];
  for (const at of [start, start + day]) {
    await trackOnce(dataDir, at);
    const manifest = JSON.parse(await readFile(path.join(dataDir, "manifest.json"), "utf8")) as { files: Array<{ path: string }> };
    if (at === start) {
      assert.ok(manifest.files.some((file) => file.path === ".gitattributes"), "the first run writes .gitattributes, and its manifest lists it");
      assert.ok(manifest.files.some((file) => file.path === "hosts.json"));
    }
    const plan = planScan(await scanInputFromFolder(dataDir));
    ids.push(plan.id);
    await publish(plan, folderStore(out), { now: () => new Date(at + day / 2) });
    const hosts = await readFile(path.join(out, "snapshots", plan.id, "hosts.json"), "utf8");
    assert.equal(hosts, await readFile(path.join(dataDir, "hosts.json"), "utf8"));
    assert.ok(JSON.parse(hosts).hosts["busy.example.com"].overBudgetRuns >= 1);
    assert.ok(plan.objects.every((object) => !/gitattributes|README/.test(object.key)));
    // Every list in the folder is in the bundle, the ones this run did not rewrite included.
    const bundle = gunzipSync(await readFile(path.join(out, "snapshots", plan.id, "lists.jsonl.gz"))).toString("utf8").trim().split("\n");
    assert.equal(bundle.length, plan.record.lists.current);
    assert.ok(plan.record.lists.current >= 2);
  }
  const pointer = JSON.parse(await readFile(path.join(out, "latest.json"), "utf8"));
  assert.deepEqual(pointer.scans, [...ids].reverse());
  // The second day's lists were unchanged, so it wrote no list versions: the first day's are the history.
  const second = JSON.parse(await readFile(path.join(out, "scans", ids[1] as string, "scan.json"), "utf8"));
  assert.deepEqual(second.lists.written, []);
});
