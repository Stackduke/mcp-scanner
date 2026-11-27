import { nextPointer, planned, pointerKey, pointerObject, readPointer, scanIdOf, scanKey } from "./radar-layout.ts";
import { WeakEtagError, encodeKey, s3Store } from "./radar-publish.ts";
import type { Credentials } from "./radar-publish.ts";

/**
 * The once-only check of what the uploader relies on R2 to do, against a scratch bucket with its own token,
 * before the first upload to `radar` (docs/decisions/0001-radar-storage-r2.md, "Before the first upload"). It
 * drives the uploader's own store (s3Store), and looks at what R2 answered each request:
 * 1. a new object keeps its Content-Type, Cache-Control and x-amz-meta-source-sha256;
 * 2. a create-only PUT (If-None-Match: *) to a key already there is refused (412, or 409 under a bucket lock)
 *    and leaves the object as it was;
 * 3. latest.json is replaced with If-Match only while its ETag is current (a stale one answers 412), and
 *    If-None-Match: * is refused once it exists.
 * It writes a few small objects under a scan id of the time it runs, and latest.json. Nothing is deleted.
 */
export interface PreflightOptions {
  endpoint: string;
  bucket: string;
  credentials: Credentials;
  /** The scratch bucket has a lock rule on scans/, so a create-only PUT to a key there must answer 409. */
  expectLock?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const immutableCache = "public, max-age=31536000, immutable";

export async function preflight({ endpoint, bucket, credentials, expectLock = false, fetchImpl = fetch, now = () => new Date() }: PreflightOptions): Promise<{ ok: boolean; lines: string[] }> {
  if (bucket === "radar") throw new Error("The pre-flight check writes test objects, so it never runs against the bucket radar. Use a scratch bucket.");
  const seen: Array<{ method: string; url: string; status: number; headers: Headers }> = [];
  const recording: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    seen.push({ method: init?.method ?? "GET", url: String(input), status: response.status, headers: response.headers });
    return response;
  };
  /** What R2 last answered to that method on that key. */
  const answer = (method: string, key: string) => [...seen].reverse().find((each) => each.method === method && each.url.endsWith(`/${bucket}/${encodeKey(key)}`));
  const store = s3Store({ endpoint, bucket, credentials, fetchImpl: recording, now });

  const lines: string[] = [];
  let ok = true;
  const check = (passed: boolean, what: string) => { lines.push(`${passed ? "ok" : "FAILED"}: ${what}`); ok &&= passed; };

  // 1. A new object, with the uploader's headers.
  const id = scanIdOf(now().toISOString());
  const key = scanKey(id, "manifest.json");
  const first = planned(key, Buffer.from(`${JSON.stringify({ preflight: now().toISOString() })}\n`));
  check(await store.putNew(first), `a create-only PUT of a new key (${key}) is accepted`);
  const sha = await store.head(key);
  const head = answer("HEAD", key);
  check(head?.headers.get("content-type") === "application/json", `HEAD answers Content-Type application/json (got ${head?.headers.get("content-type") ?? "none"})`);
  check(head?.headers.get("cache-control") === immutableCache, `HEAD answers Cache-Control "${immutableCache}" (got ${head?.headers.get("cache-control") ?? "none"})`);
  check(sha === first.sourceSha256, `HEAD answers x-amz-meta-source-sha256 as it was sent (got ${sha || "none"})`);

  // 2. The same key again, with other content.
  const second = planned(key, Buffer.from(`${JSON.stringify({ preflight: now().toISOString(), other: "content, longer than the first" })}\n`));
  const refused = !(await store.putNew(second));
  const status = answer("PUT", key)?.status;
  check(refused && status === (expectLock ? 409 : 412), `a create-only PUT to a key already there is refused with ${expectLock ? "409 ObjectLockedByBucketPolicy (bucket lock)" : "412"} (got ${status ?? "no answer"}${status === 409 && !expectLock ? ": the bucket has a lock rule; run again with the lock input on" : ""})`);
  await store.head(key);
  const after = answer("HEAD", key);
  check(after?.headers.get("x-amz-meta-source-sha256") === first.sourceSha256 && after.headers.get("etag") === head?.headers.get("etag") && after.headers.get("content-length") === String(first.body.length),
    "the object is left as it was (same sha256 metadata, ETag and size)");

  // 3. latest.json: replaced only while the version read is current. A weak ETag makes getPointer throw; the
  // checks still report what GET answered.
  const readLatest = () => store.getPointer().catch((error: unknown) => { if (error instanceof WeakEtagError) return "weak" as const; throw error; });
  const etagCheck = (passed: boolean) => {
    const get = answer("GET", pointerKey);
    check(passed, `GET latest.json answers a quoted ETag (got ${get?.headers.get("etag") ?? "none"}; Content-Encoding ${get?.headers.get("content-encoding") ?? "none"})`);
  };
  const read = await readLatest();
  // latest.json is there from an earlier run, and cannot be read with an ETag that If-Match takes.
  if (read === "weak") { etagCheck(false); return { ok, lines }; }
  const current = read;
  const pointer = (at: Date) => pointerObject(nextPointer(readPointer(current?.body ?? null), id, at.toISOString()));
  check(await store.putPointer(pointer(now()), current?.etag ?? null), `latest.json is written ${current ? "with If-Match and its current ETag" : "with If-None-Match: * while there is none"}`);
  const again = await readLatest();
  const written = again === "weak" ? null : again;
  const get = answer("GET", pointerKey);
  check(get?.headers.get("content-type") === "application/json" && get.headers.get("cache-control") === "public, max-age=60", `GET latest.json answers Content-Type application/json and Cache-Control "public, max-age=60" (got ${get?.headers.get("content-type") ?? "none"}; ${get?.headers.get("cache-control") ?? "none"})`);
  etagCheck(/^"[^"]+"$/.test(written?.etag ?? ""));
  check(!(await store.putPointer(pointer(new Date(now().getTime() + 1000)), null)) && answer("PUT", pointerKey)?.status === 412, "If-None-Match: * on latest.json, which is there now, answers 412");
  const stale = current?.etag ?? `"${"0".repeat(32)}"`;
  check(!(await store.putPointer(pointer(new Date(now().getTime() + 2000)), stale)) && answer("PUT", pointerKey)?.status === 412, "If-Match with a stale ETag answers 412");
  check(await store.putPointer(pointer(new Date(now().getTime() + 3000)), written?.etag ?? null), "If-Match with the current ETag, as GET answered it, succeeds");
  return { ok, lines };
}
