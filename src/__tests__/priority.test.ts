import net from "net";
import type { AddressInfo } from "net";
import request from "supertest";
import { useHarness, sleep } from "../testSupport/gatewayHarness";
import { CENTER_WARNING_INTERVAL_MS, LANE_TIMEOUT_MS } from "../server";
import {
  ACTIVE_OPERATOR,
  MACHINE_BEARER,
  OPERATOR_BEARER,
  OPERATOR_TOKEN,
  TEST_INTROSPECTION_SECRET,
} from "../testSupport/fakeCenter";
import { TEST_AUTH_SERVICE_SHARED_SECRET } from "../testSupport/fakeAuthService";
import { sendThrough } from "../testSupport/rawHttp";

interface Metrics { queues: Record<"interactive" | "background", { latencyMs: { count: number; avg: number; max: number } }> }

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
      interactive: (metrics.body as Metrics).queues.interactive.latencyMs.count,
      background: (metrics.body as Metrics).queues.background.latencyMs.count,
    };
  };

  it("serves an active operator ahead of background requests queued before it", async () => {
    const gateway = app();

    const background = Array.from({ length: 4 }, (_, i) =>
      request(gateway).get(`/proxy/my/agent?bg=${String(i)}`).set("Authorization", MACHINE_BEARER),
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
      request(gateway).get(`/proxy/my/agent?bg=${String(i)}`).set("Authorization", unknown),
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
      request(gateway).get(`/proxy/my/agent?bg=${String(i)}`).set("Authorization", unknown),
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

  // Pinned on its own because the hang test below uses a fixed ceiling: a
  // ceiling derived from the constant would let the constant itself drift
  // (to 1000, say) and still pass.
  it("pins the lane timeout at 250 ms", () => {
    expect(LANE_TIMEOUT_MS).toBe(250);
  });

  // The center is on the hot path of every credentialed game call, so a hung
  // auth-service must cost each one the lane timeout and no more. Without a
  // timeout of its own the gateway would wait on the shared client's 1 s
  // default; without any timeout it would wait for as long as the center does.
  it("gives up on a hanging center after 250 ms and proxies the call in the background lane", async () => {
    gw.center.respondWith({ ...ACTIVE_OPERATOR, delayMs: 5_000 });
    const gateway = app();

    const res = await sendThrough(gateway, { path: "/proxy/my/agent", authorization: OPERATOR_BEARER });

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests).toHaveLength(1);
    expect(gw.center.requests).toHaveLength(1);
    // A floor proves the center really was asked and waited on; the ceiling
    // is the property. Both are fixed numbers, not derived from
    // LANE_TIMEOUT_MS, so doubling the timeout at the construction site
    // (500 ms) fails here. 450 ms leaves 200 ms for the rest of the request
    // on a slow CI runner.
    expect(res.elapsedMs).toBeGreaterThanOrEqual(230);
    expect(res.elapsedMs).toBeLessThan(450);
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

  // Node's parser caps a request at 2000 raw header entries. Past the cap,
  // Node 22 answers 431 before any handler runs, and Node 25 hands the app a
  // TRUNCATED rawHeaders — so a second Authorization line sent after enough
  // filler is simply not in the list. A gateway that counted rawHeaders
  // itself and then read req.header() would see one line and introspect the
  // first; soleAuthorizationLine reads a list that reached the cap as
  // uncountable. Either way: no center call, and never the interactive lane.
  it("makes no center call when a second Authorization line hides past the header-count cap", async () => {
    const gateway = app();
    const server = gateway.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => { resolve(); }));
    const { port } = server.address() as AddressInfo;

    const fillers = Array.from({ length: 1100 }, (_, i) => `x-filler-${String(i)}: 1\r\n`).join("");
    const raw =
      "GET /proxy/my/agent HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
      `Authorization: ${OPERATOR_BEARER}\r\n` +
      fillers +
      `Authorization: ${OPERATOR_BEARER}\r\n` +
      "Connection: close\r\n\r\n";

    let status = 0;
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(raw));
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (data += String(chunk)));
        socket.on("end", () => { resolve(data); });
        socket.on("error", reject);
      });
      status = Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    }

    expect([200, 431]).toContain(status);
    expect(gw.center.requests).toHaveLength(0);
    const expected = status === 200 ? { interactive: 0, background: 1 } : { interactive: 0, background: 0 };
    expect(await lanes(gateway)).toEqual(expected);
  });

  // POST /register authenticates with the SpaceTraders account token, which
  // is not a session and is nobody's business but SpaceTraders'. It used to
  // go to auth-service's introspection endpoint like any other bearer, for an
  // answer that could only ever be "inactive".
  it("never asks the center about POST /register's account token, and forwards it untouched", async () => {
    const gateway = app();

    const res = await request(gateway).post("/proxy/register").set("Authorization", OPERATOR_BEARER).send({ symbol: "X" });

    expect(res.status).toBe(200);
    expect(gw.center.requests).toHaveLength(0);
    expect(gw.spaceTraders.requests[0].authorization).toBe(OPERATOR_BEARER);
    expect(await lanes(gateway)).toEqual({ interactive: 0, background: 1 });
  });

  // A misconfigured center — a rotated secret, a trailing slash on the URL —
  // demotes every operator to background and fails nothing, so without a log
  // line nobody would ever know.
  describe("when the center cannot be used", () => {
    let warn: jest.SpyInstance<void, unknown[]>;
    beforeEach(() => {
      warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => { warn.mockRestore(); });

    const centerWarnings = () =>
      warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes("introspection"));

    it("warns once for a burst, naming the endpoint and never the token or the secret", async () => {
      gw.center.respondWith({ status: 401, body: JSON.stringify({ error: { message: "bad secret" } }) });
      const gateway = gw.app();

      await Promise.all(
        Array.from({ length: 5 }, () => request(gateway).get("/proxy/my/agent").set("Authorization", OPERATOR_BEARER)),
      );
      await request(gateway).get("/proxy/my/agent").set("Authorization", OPERATOR_BEARER);

      expect(gw.center.requests).toHaveLength(6);
      expect(CENTER_WARNING_INTERVAL_MS).toBe(60_000);
      const lines = centerWarnings();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(new URL(gw.centerUrl).pathname);
      expect(lines[0]).not.toContain(OPERATOR_TOKEN);
      expect(lines[0]).not.toContain(TEST_INTROSPECTION_SECRET);
    });

    it("says nothing when the center answers, even when the answer is inactive", async () => {
      const gateway = gw.app();

      await request(gateway).get("/proxy/my/agent").set("Authorization", unknown);
      await request(gateway).get("/proxy/my/agent").set("Authorization", OPERATOR_BEARER);

      expect(centerWarnings()).toHaveLength(0);
    });
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

    const afterRes = await request(gateway).get("/metrics");
    const after = { body: afterRes.body as Metrics };
    expect(after.body.queues.interactive.latencyMs.count).toBe(1);
    expect(after.body.queues.background.latencyMs.count).toBe(2);
    expect(after.body.queues.interactive.latencyMs.avg).toBeGreaterThanOrEqual(0);
    expect(after.body.queues.background.latencyMs.max).toBeGreaterThanOrEqual(
      after.body.queues.background.latencyMs.avg,
    );
  });
});
