import request from "supertest";
import { useHarness, sleep } from "../testSupport/gatewayHarness";
import { LANE_TIMEOUT_MS } from "../server";
import {
  ACTIVE_OPERATOR,
  MACHINE_BEARER,
  OPERATOR_BEARER,
  OPERATOR_TOKEN,
  TEST_INTROSPECTION_SECRET,
} from "../testSupport/fakeCenter";
import { TEST_AUTH_SERVICE_SHARED_SECRET } from "../testSupport/fakeAuthService";
import { sendThrough } from "../testSupport/rawHttp";

/**
 * The queue lane (auth-design.md decisions 2 and 21) at the HTTP boundary.
 *
 * The lane is auth-service's answer about the caller's token, read through
 * the shared client's lane deriver: `interactive` for an active `operator`,
 * `background` for everything else. The fixture's twelve gateway cases are
 * driven in lane.conformance.test.ts; this file covers what the fixture
 * cannot say — queue order, the timeout, retries, and which routes never ask.
 *
 * Queue *depth* lives in tokenBucket.test.ts, where it can be asserted
 * without a wall-clock race. The lane a request took is read here from
 * /metrics, whose per-queue latency count goes up by one per dispatch.
 */
describe("st-gateway queue lanes", () => {
  const gw = useHarness();
  // burst 1 + 5 rps: the first request takes the bucket, everything after it
  // queues 200ms apart — wide enough to slot a request in mid-queue.
  const app = (overrides = {}) => gw.app({ rateLimitRps: 5, rateLimitBurst: 1, maxRetries: 0, ...overrides });

  /** A token the center does not recognise, so it answers `{"active":false}`. */
  const unknown = "Bearer opaque-caller-token";

  const lanes = async (gateway: ReturnType<typeof app>) => {
    const metrics = await request(gateway).get("/metrics");
    return {
      interactive: metrics.body.queues.interactive.latencyMs.count as number,
      background: metrics.body.queues.background.latencyMs.count as number,
    };
  };

  it("serves an active operator ahead of background requests queued before it", async () => {
    const gateway = app();

    const background = Array.from({ length: 4 }, (_, i) =>
      request(gateway).get(`/proxy/my/agent?bg=${i}`).set("Authorization", MACHINE_BEARER),
    );

    await sleep(30); // let the background requests reach the gateway and queue
    const interactive = request(gateway).get("/proxy/my/agent?priority=interactive").set("Authorization", OPERATOR_BEARER);

    await Promise.all([...background, interactive]);

    const arrivalOrder = gw.spaceTraders.requests.map((r) => r.url);
    const interactiveIndex = arrivalOrder.findIndex((u) => u.includes("priority=interactive"));
    // The very first background request may already have claimed the burst
    // token before the interactive request was even sent; every request queued
    // behind it must yield to the interactive one.
    expect(interactiveIndex).toBeGreaterThanOrEqual(0);
    expect(interactiveIndex).toBeLessThanOrEqual(1);
  });

  it("queues a token the center calls inactive in plain FIFO order, behind everything already waiting", async () => {
    const gateway = app();

    const background = Array.from({ length: 3 }, (_, i) =>
      request(gateway).get(`/proxy/my/agent?bg=${i}`).set("Authorization", unknown),
    );
    await sleep(30);
    const unmarked = request(gateway).get("/proxy/my/agent?unmarked=1").set("Authorization", unknown);

    await Promise.all([...background, unmarked]);

    const arrivalOrder = gw.spaceTraders.requests.map((r) => r.url);
    expect(arrivalOrder.findIndex((u) => u.includes("unmarked=1"))).toBe(arrivalOrder.length - 1);
  });

  // decision 2's whole point: X-Priority is not a trust signal, so
  // self-declaring it must have zero effect — otherwise any caller, anonymous
  // ones included (decision 3), could jump the queue for free.
  it("ignores a self-declared X-Priority: interactive header entirely", async () => {
    const gateway = app();

    const background = Array.from({ length: 3 }, (_, i) =>
      request(gateway).get(`/proxy/my/agent?bg=${i}`).set("Authorization", unknown),
    );
    await sleep(30);
    const spoofed = request(gateway)
      .get("/proxy/my/agent?spoofed=1")
      .set("Authorization", unknown)
      .set("X-Priority", "interactive");

    await Promise.all([...background, spoofed]);

    const arrivalOrder = gw.spaceTraders.requests.map((r) => r.url);
    expect(arrivalOrder.findIndex((u) => u.includes("spoofed=1"))).toBe(arrivalOrder.length - 1);
  });

  it("never grants the interactive lane to an active machine token", async () => {
    const gateway = app();

    const res = await request(gateway).get("/proxy/my/agent").set("Authorization", MACHINE_BEARER);
    expect(res.status).toBe(200);
    expect(await lanes(gateway)).toEqual({ interactive: 0, background: 1 });
  });

  it("asks the center about the caller's token with the introspection secret, never the vault's", async () => {
    await request(app()).get("/proxy/my/agent").set("Authorization", OPERATOR_BEARER);

    expect(gw.center.requests).toHaveLength(1);
    const [call] = gw.center.requests;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/auth/v1/introspect");
    expect(call.contentType).toBe("application/x-www-form-urlencoded");
    expect(call.token).toBe(OPERATOR_TOKEN);
    expect(call.secret).toBe(TEST_INTROSPECTION_SECRET);
    expect(call.secret).not.toBe(TEST_AUTH_SERVICE_SHARED_SECRET);
  });

  it.each([
    ["no Authorization header at all", undefined],
    ["a token the center calls inactive", unknown],
    ["a non-bearer scheme", "Basic dXNlcjpwYXNz"],
    ["garbage after the scheme", "Bearer !!!not-a-token-of-any-kind%%%"],
    ["a bare scheme", "Bearer"],
  ])("degrades to background rather than rejecting the request: %s", async (_name, authorization) => {
    const gateway = app();
    const req = request(gateway).get("/proxy/my/agent");
    if (authorization !== undefined) req.set("Authorization", authorization);
    const res = await req;

    // The lane never blocks the request itself. A missing, malformed or
    // invalid identity still gets SpaceTraders' own answer.
    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests).toHaveLength(1);
    expect(await lanes(gateway)).toEqual({ interactive: 0, background: 1 });
  });

  it.each([
    ["answers 500", { status: 500, body: "" }],
    ["rejects our caller secret", { status: 401, body: JSON.stringify({ error: { message: "nope" } }) }],
    ["answers something that is not JSON", { status: 200, body: "<html>" }],
  ])("proxies an operator in the background lane when the center %s", async (_name, reply) => {
    gw.center.respondWith(reply);
    const gateway = app();

    const res = await request(gateway).get("/proxy/my/agent").set("Authorization", OPERATOR_BEARER);

    expect(res.status).toBe(200);
    expect(gw.center.requests).toHaveLength(1);
    expect(await lanes(gateway)).toEqual({ interactive: 0, background: 1 });
  });

  // The center is on the hot path of every credentialed game call, so a hung
  // auth-service must cost each one the lane timeout and no more. Without a
  // timeout of its own the gateway would wait on the shared client's 1 s
  // default; without any timeout it would wait for as long as the center does.
  it(`gives up on a hanging center after ${LANE_TIMEOUT_MS} ms and proxies the call in the background lane`, async () => {
    gw.center.respondWith({ ...ACTIVE_OPERATOR, delayMs: 5_000 });
    const gateway = app();

    const res = await sendThrough(gateway, { path: "/proxy/my/agent", authorization: OPERATOR_BEARER });

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests).toHaveLength(1);
    expect(gw.center.requests).toHaveLength(1);
    // A floor proves the center really was asked and waited on; the ceiling
    // is the property. The margin covers the rest of the request on a slow
    // CI runner and still fails a 1000 ms timeout.
    expect(res.elapsedMs).toBeGreaterThanOrEqual(LANE_TIMEOUT_MS - 20);
    expect(res.elapsedMs).toBeLessThan(LANE_TIMEOUT_MS + 450);
    expect(await lanes(gateway)).toEqual({ interactive: 0, background: 1 });
  });

  // Retries re-enter the queue, but they must not re-ask auth-service: the
  // lane is decided once per inbound request.
  it("asks the center once per inbound request, however many attempts the call takes upstream", async () => {
    gw.spaceTraders.respondWith(
      { status: 429, body: "{}", headers: { "retry-after": "0" } },
      { status: 503, body: "{}" },
      { status: 200, body: JSON.stringify({ data: "ok" }) },
    );
    const gateway = gw.app({ maxRetries: 3, retryBaseMs: 1 });

    const res = await request(gateway).get("/proxy/my/agent").set("Authorization", OPERATOR_BEARER);

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests).toHaveLength(3);
    expect(gw.center.requests).toHaveLength(1);
    expect(await lanes(gateway)).toEqual({ interactive: 3, background: 0 });
  });

  it.each([
    ["an internal space: `Bearer abc def` is not the token `abcdef`", "Bearer abc def"],
    ["an empty token", "Bearer "],
    ["two lines, both well-formed operator sessions", [OPERATOR_BEARER, OPERATOR_BEARER]],
    ["two lines, the first empty", ["", OPERATOR_BEARER]],
    ["two lines, the second empty", [OPERATOR_BEARER, ""]],
    ["three lines", [OPERATOR_BEARER, MACHINE_BEARER, OPERATOR_BEARER]],
  ])("makes no center call for a header that is not one credential: %s", async (_name, authorization) => {
    const gateway = app();

    const res = await sendThrough(gateway, { path: "/proxy/my/agent", authorization });

    expect(res.status).toBe(200);
    expect(gw.center.requests).toHaveLength(0);
    expect(await lanes(gateway)).toEqual({ interactive: 0, background: 1 });
  });

  it.each(["/health", "/api/st-gateway/health", "/metrics"])(
    "never asks the center on %s, whatever the caller sends",
    async (path) => {
      const res = await request(app()).get(path).set("Authorization", OPERATOR_BEARER);

      expect(res.status).toBe(200);
      expect(gw.center.requests).toHaveLength(0);
    },
  );

  it("reports per-lane wait latency through /metrics once requests have drained", async () => {
    const gateway = app();
    gw.spaceTraders.respondAfter(20);

    await Promise.all([
      request(gateway).get("/proxy/my/agent?a=1").set("Authorization", unknown),
      request(gateway).get("/proxy/my/agent?a=2").set("Authorization", OPERATOR_BEARER),
      request(gateway).get("/proxy/my/agent?a=3").set("Authorization", unknown),
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
