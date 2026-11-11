import { SHARDS_CACHED } from "./config.ts";
import type { Meta, NameEntry, ServerRecord } from "./shared.ts";

/**
 * Reads the tracker data deployed with the Worker as static assets (built by scripts/build-data.ts).
 * Nothing is fetched from anywhere else. Each lookup reads one small shard, so a request costs a
 * few milliseconds and little memory however large the tracker grows.
 */

/** The static-assets binding: only `fetch` is used. */
export interface AssetFetcher { fetch(request: Request): Promise<Response> }

export class DataUnavailable extends Error {}

interface Cache { meta?: Promise<Meta>; shards: Map<string, Promise<Record<string, unknown>>> }
const caches = new WeakMap<AssetFetcher, Cache>();

function cacheFor(assets: AssetFetcher): Cache {
  let cache = caches.get(assets);
  if (!cache) caches.set(assets, (cache = { shards: new Map() }));
  return cache;
}

async function readAsset(assets: AssetFetcher, path: string): Promise<unknown> {
  // The static-assets binding ignores the host; only the path is used.
  const response = await assets.fetch(new Request(`https://assets.invalid/${path}`));
  if (!response.ok) throw new DataUnavailable(`${path}: ${response.status}`);
  return response.json();
}

export function meta(assets: AssetFetcher): Promise<Meta> {
  const cache = cacheFor(assets);
  cache.meta ??= readAsset(assets, "meta.json").then((value) => {
    const data = value as Meta;
    if (data?.version !== 1 || typeof data.generated_at !== "string" || !Array.isArray(data.forbidden_sites)) throw new DataUnavailable("meta.json: unknown shape");
    return data;
  });
  // A failed read is not kept, so the next call tries again.
  cache.meta.catch(() => { if (caches.get(assets) === cache) delete cache.meta; });
  return cache.meta;
}

function shard(assets: AssetFetcher, folder: "s" | "n", key: string): Promise<Record<string, unknown>> {
  const cache = cacheFor(assets);
  const path = `${folder}/${key}.json`;
  let entry = cache.shards.get(path);
  if (entry) {
    // Most recently used last, so the oldest is dropped first.
    cache.shards.delete(path);
    cache.shards.set(path, entry);
    return entry;
  }
  entry = readAsset(assets, path).then((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DataUnavailable(`${path}: unknown shape`);
    return value as Record<string, unknown>;
  });
  entry.catch(() => cache.shards.delete(path));
  cache.shards.set(path, entry);
  while (cache.shards.size > SHARDS_CACHED) cache.shards.delete(cache.shards.keys().next().value as string);
  return entry;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The tracker's id for an address: the first 12 hex characters of its sha256. */
export const endpointId = async (url: string) => (await sha256Hex(url)).slice(0, 12);

export async function serverById(assets: AssetFetcher, id: string): Promise<ServerRecord | undefined> {
  if (!/^[0-9a-f]{12}$/.test(id)) return undefined;
  const servers = await shard(assets, "s", id.slice(0, 2));
  // Own keys only: a plain object also answers to "constructor", "__proto__" and the like.
  return Object.hasOwn(servers, id) ? (servers[id] as ServerRecord) : undefined;
}

export async function serversByName(assets: AssetFetcher, key: string): Promise<NameEntry | undefined> {
  const names = await shard(assets, "n", (await sha256Hex(key)).slice(0, 2));
  if (!Object.hasOwn(names, key)) return undefined;
  const entry = names[key] as NameEntry;
  return Array.isArray(entry?.ids) && typeof entry.total === "number" ? entry : undefined;
}
