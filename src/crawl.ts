/**
 * Runs many checks politely: a fixed number at once, never two at once on the same host, a pause
 * between two checks on one host, and no new check once the time is up. A check that has started
 * is left to finish; its own timeout bounds it.
 */
export interface CrawlOptions {
  concurrency: number;
  /** The least time between the start of two checks on one host. */
  hostGapMs: number;
  /** No check starts after this moment (milliseconds since the epoch). */
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** `check` must not throw: a check that fails says so in its result. */
export async function crawl<T extends { url: string }, R>(items: T[], check: (item: T) => Promise<R>, options: CrawlOptions): Promise<{ done: Array<{ item: T; result: R }>; notStarted: T[] }> {
  const { concurrency, hostGapMs, deadline, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
  const queues = new Map<string, T[]>();
  for (const item of items) {
    const host = new URL(item.url).hostname;
    const queue = queues.get(host);
    if (queue) queue.push(item);
    else queues.set(host, [item]);
  }
  // Hosts take turns, so one host with many endpoints cannot fill every slot. A host leaves the turn when its queue is empty.
  const hosts = [...queues.keys()];
  const busy = new Set<string>(), lastStart = new Map<string, number>();
  const done: Array<{ item: T; result: R }> = [];
  let next = 0;

  function take(): { host: string; item: T } | null {
    for (let tried = 0; tried < hosts.length; tried += 1) {
      const at = (next + tried) % hosts.length;
      const host = hosts[at] as string;
      if (busy.has(host)) continue;
      const queue = queues.get(host) as T[];
      const item = queue.shift() as T;
      if (!queue.length) hosts.splice(at, 1);
      next = hosts.length ? (queue.length ? at + 1 : at) % hosts.length : 0;
      return { host, item };
    }
    return null;
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (now() >= deadline) return;
      const taken = take();
      if (!taken) {
        if (!hosts.length) return;
        await sleep(50);
        continue;
      }
      const { host, item } = taken;
      busy.add(host);
      const wait = (lastStart.get(host) ?? -Infinity) + hostGapMs - now();
      if (wait > 0) await sleep(wait);
      lastStart.set(host, now());
      try { done.push({ item, result: await check(item) }); } finally { busy.delete(host); }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return { done, notStarted: [...queues.values()].flat() };
}
