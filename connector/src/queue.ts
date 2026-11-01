import { QUEUE_TTL_SECONDS } from "./config.ts";
import { endpointId } from "./data.ts";

/**
 * Requests for the tracker to look at addresses it has not seen, kept in a KV namespace. One key
 * per address (`queue:<tracker id>`), so asking twice adds nothing. Entries expire after 30 days
 * if nothing takes them; nothing reads them yet (README, "Unknown servers").
 *
 * Only addresses that already passed the crawl's own rule reach here. On top of that:
 * - an address with a query string, or a path part that looks like a key, is never stored: hosted
 *   servers often carry the caller's key there;
 * - queue writes have their own, tighter rate limit per caller;
 * - asking about an address someone else already asked about gets the same answer as a first
 *   request, so the answer does not reveal what others asked.
 * Nothing about who asked is stored: only the address and when it was first asked about.
 */

/** The part of a KV namespace binding this uses. */
export interface QueueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** "withheld": not stored because it may hold a key. "not_queued": no queue, over the limit, or the store failed. */
export type QueueOutcome = "queued" | "withheld" | "not_queued";

export interface QueueOptions {
  store?: QueueStore;
  /** True while this caller may still add to the queue. Without it, there is no limit (unit tests). */
  allowed?: () => Promise<boolean>;
  now: Date;
}

/** A path part long enough, and mixed enough, to be a key or token rather than a word. */
const keyLike = (part: string) => part.length >= 32 || (part.length >= 20 && /[A-Za-z]/.test(part) && /\d/.test(part));

export function mayHoldKey(url: string): boolean {
  const parsed = new URL(url);
  return parsed.search !== "" || parsed.pathname.split("/").some(keyLike);
}

export async function queueAddress(url: string, { store, allowed, now }: QueueOptions): Promise<QueueOutcome> {
  if (mayHoldKey(url)) return "withheld";
  if (!store) return "not_queued";
  try {
    const key = `queue:${await endpointId(url)}`;
    if (await store.get(key)) return "queued";
    if (allowed && !(await allowed())) return "not_queued";
    await store.put(key, JSON.stringify({ url, queued_at: now.toISOString() }), { expirationTtl: QUEUE_TTL_SECONDS });
    return "queued";
  } catch {
    // A full or failing store must not break the answer; it says the address was not recorded.
    return "not_queued";
  }
}
