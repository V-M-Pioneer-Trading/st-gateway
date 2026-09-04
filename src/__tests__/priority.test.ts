import request from "supertest";
import { useHarness, sleep } from "../testSupport/gatewayHarness";
import { userBearer, machineBearer, expiredUserBearer, foreignBearer } from "../testSupport/authTokens";

/**
 * Priority derivation (auth-design.md decision 2) at the HTTP boundary.
 *
 * This file absorbed the old auth.test.ts, which had drifted into a near-copy:
 * both suites carried their own FakeSpaceTraders, the same twelve-field config
 * literal, and a byte-identical "exposes queue depth and latency" test. Queue
 * *depth* now lives in tokenBucket.test.ts, where it can be asserted without a
 * wall-clock race; what stays here is the behaviour that genuinely needs the
 * whole gateway wired up.
 */
describe("st-gateway priority classes and observability", () => {
  const gw = useHarness();
  // burst 1 + 5 rps: the first request takes the bucket, everything after it
  // queues 200ms apart — wide enough to slot a request in mid-queue.
  const app = (overrides = {}) => gw.app({ rateLimitRps: 5, rateLimitBurst: 1, maxRetries: 0, ...overrides });

  const bg = "Bearer opaque-caller-token";

  it("serves a request carrying a verified human session ahead of background requests queued before it", async () => {
    const gateway = app();

    const background = Array.from({ length: 4 }, (_, i) =>
      request(gateway).get(`/proxy/my/agent?bg=${i}`).set("Authorization", bg),
    );

    await sleep(30); // let the background requests reach the gateway and queue
    const interactive = request(gateway).get("/proxy/my/agent?priority=interactive").set("Authorization", userBearer());

    await Promise.all([...background, interactive]);

    const arrivalOrder = gw.spaceTraders.requests.map((r) => r.url);
    const interactiveIndex = arrivalOrder.findIndex((u) => u.includes("priority=interactive"));
    // The very first background request may already have claimed the burst
    // token before the interactive request was even sent; every request queued
    // behind it must yield to the interactive one.
    expect(interactiveIndex).toBeGreaterThanOrEqual(0);
    expect(interactiveIndex).toBeLessThanOrEqual(1);
  });

  it("treats requests without a verified session as background", async () => {
    const gateway = app();

    const background = Array.from({ length: 3 }, (_, i) =>
      request(gateway).get(`/proxy/my/agent?bg=${i}`).set("Authorization", bg),
    );
    await sleep(30);
    const unmarked = request(gateway).get("/proxy/my/agent?unmarked=1").set("Authorization", bg);

    await Promise.all([...background, unmarked]);

    const arrivalOrder = gw.spaceTraders.requests.map((r) => r.url);
    // No priority boost: it lands wherever plain FIFO puts it, i.e. last.
    expect(arrivalOrder.findIndex((u) => u.includes("unmarked=1"))).toBe(arrivalOrder.length - 1);
  });

  // decision 2's whole point: X-Priority is no longer a trust signal, so
  // self-declaring it must have zero effect — otherwise any caller (soon
  // including anonymous ones, decision 3) can still jump the queue for free.
  it("ignores a self-declared X-Priority: interactive header entirely", async () => {
    const gateway = app();

    const background = Array.from({ length: 3 }, (_, i) =>
      request(gateway).get(`/proxy/my/agent?bg=${i}`).set("Authorization", bg),
    );
    await sleep(30);
    const spoofed = request(gateway)
      .get("/proxy/my/agent?spoofed=1")
      .set("Authorization", bg)
      .set("X-Priority", "interactive");

    await Promise.all([...background, spoofed]);

    const arrivalOrder = gw.spaceTraders.requests.map((r) => r.url);
    expect(arrivalOrder.findIndex((u) => u.includes("spoofed=1"))).toBe(arrivalOrder.length - 1);
  });

  it("never grants interactive priority to a Clerk M2M (machine) token", async () => {
    const gateway = app();

    const res = await request(gateway).get("/proxy/my/agent").set("Authorization", machineBearer());
    expect(res.status).toBe(200);

    const metrics = await request(gateway).get("/metrics");
    expect(metrics.body.queues.interactive.latencyMs.count).toBe(0);
    expect(metrics.body.queues.background.latencyMs.count).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["no Authorization header at all", undefined],
    ["an expired session", expiredUserBearer()],
    ["a token signed by an untrusted key", foreignBearer()],
    ["a non-bearer scheme", "Basic dXNlcjpwYXNz"],
  ])("degrades to background rather than rejecting the request: %s", async (_name, authorization) => {
    const gateway = app();
    const req = request(gateway).get("/proxy/my/agent");
    if (authorization !== undefined) req.set("Authorization", authorization);
    const res = await req;

    // Priority derivation never blocks the request itself — only the queue
    // lane. A malformed/invalid identity still gets a normal 200.
    expect(res.status).toBe(200);

    const metrics = await request(gateway).get("/metrics");
    expect(metrics.body.queues.interactive.latencyMs.count).toBe(0);
  });

  // CLERK_ISSUER is optional and was previously exercised by nothing at all,
  // so a typo in it would have silently demoted every human caller to
  // background with no test noticing.
  describe("CLERK_ISSUER", () => {
    const issuer = "https://clerk.example.test";

    it("accepts a session whose iss matches", async () => {
      const gateway = app({ clerkIssuer: issuer });
      await request(gateway).get("/proxy/my/agent").set("Authorization", userBearer({ issuer }));

      const metrics = await request(gateway).get("/metrics");
      expect(metrics.body.queues.interactive.latencyMs.count).toBe(1);
    });

    it("demotes a session whose iss does not match", async () => {
      const gateway = app({ clerkIssuer: issuer });
      await request(gateway).get("/proxy/my/agent").set("Authorization", userBearer({ issuer: "https://evil.test" }));

      const metrics = await request(gateway).get("/metrics");
      expect(metrics.body.queues.interactive.latencyMs.count).toBe(0);
      expect(metrics.body.queues.background.latencyMs.count).toBe(1);
    });
  });

  it("reports per-class wait latency through /metrics once requests have drained", async () => {
    const gateway = app();
    gw.spaceTraders.respondAfter(20);

    await Promise.all([
      request(gateway).get("/proxy/my/agent?a=1").set("Authorization", bg),
      request(gateway).get("/proxy/my/agent?a=2").set("Authorization", userBearer()),
      request(gateway).get("/proxy/my/agent?a=3").set("Authorization", bg),
    ]);

    const after = await request(gateway).get("/metrics");
    expect(after.body.queues.interactive.latencyMs.count).toBe(1);
    expect(after.body.queues.background.latencyMs.count).toBe(2);
    expect(after.body.queues.interactive.latencyMs.avg).toBeGreaterThanOrEqual(0);
    expect(after.body.queues.background.latencyMs.max).toBeGreaterThanOrEqual(
      after.body.queues.background.latencyMs.avg,
    );
  });
});
