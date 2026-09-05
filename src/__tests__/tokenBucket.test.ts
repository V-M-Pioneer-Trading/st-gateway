import { TokenBucket } from "../tokenBucket";

/**
 * Unit level for the shared budget.
 *
 * The HTTP suites could only observe the queue by sleeping a fixed number of
 * milliseconds and peeking at /metrics — which raced against everything the
 * gateway does *before* enqueueing (the auth-service token fetch, the one-off
 * RSA key import) and made the depth assertion flaky. Depth and ordering are
 * synchronous properties of this class, so they belong here where there is no
 * clock to lose to.
 */
describe("TokenBucket", () => {
  it("rejects a configuration that could never dispatch", () => {
    expect(() => new TokenBucket(0, 1)).toThrow(/rps > 0/);
    expect(() => new TokenBucket(1, 0)).toThrow(/burst >= 1/);
    expect(() => new TokenBucket(Number.NaN, 1)).toThrow();
  });

  it("dispatches up to the burst immediately and queues the rest", async () => {
    const bucket = new TokenBucket(1, 1);

    await bucket.acquire("background");
    void bucket.acquire("background");
    void bucket.acquire("background");

    expect(bucket.getMetrics().background.depth).toBe(2);
    expect(bucket.getMetrics().interactive.depth).toBe(0);
  });

  it("lets a whole burst through back-to-back", async () => {
    const bucket = new TokenBucket(1, 5);

    await Promise.all(Array.from({ length: 5 }, () => bucket.acquire("background")));

    expect(bucket.getMetrics().background.depth).toBe(0);
  });

  it("drains interactive ahead of background already waiting", async () => {
    const bucket = new TokenBucket(100, 1);
    const order: string[] = [];

    const settled = [
      bucket.acquire("background").then(() => order.push("bg-0")),
      bucket.acquire("background").then(() => order.push("bg-1")),
      bucket.acquire("background").then(() => order.push("bg-2")),
      bucket.acquire("interactive").then(() => order.push("interactive")),
    ];

    await Promise.all(settled);

    // bg-0 took the burst token before anything else was queued; from there on
    // interactive jumps every background request waiting behind it.
    expect(order).toEqual(["bg-0", "interactive", "bg-1", "bg-2"]);
  });

  it("counts wait latency per class, and never reports max below avg", async () => {
    const bucket = new TokenBucket(100, 1);

    await Promise.all([
      bucket.acquire("background"),
      bucket.acquire("background"),
      bucket.acquire("interactive"),
    ]);

    const metrics = bucket.getMetrics();
    expect(metrics.background.latencyMs.count).toBe(2);
    expect(metrics.interactive.latencyMs.count).toBe(1);
    expect(metrics.background.latencyMs.max).toBeGreaterThanOrEqual(metrics.background.latencyMs.avg);
    expect(metrics.interactive.latencyMs.avg).toBeGreaterThanOrEqual(0);
  });

  it("reports zeroed stats before anything has been acquired", () => {
    const metrics = new TokenBucket(1, 1).getMetrics();
    expect(metrics).toEqual({
      interactive: { depth: 0, latencyMs: { count: 0, avg: 0, max: 0 } },
      background: { depth: 0, latencyMs: { count: 0, avg: 0, max: 0 } },
    });
  });
});
