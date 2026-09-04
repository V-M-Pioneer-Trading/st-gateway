import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { configFromEnv } from "../config";
import { useHarness, sleep } from "../testSupport/gatewayHarness";

describe("st-gateway proxy", () => {
  const gw = useHarness();

  it("forwards a GET's query string and injects the credential fetched from auth-service", async () => {
    gw.spaceTraders.respondWith({ status: 200, body: JSON.stringify({ data: { symbol: "X1-TEST" } }) });

    const res = await request(gw.app())
      .get("/proxy/my/ships?page=2&limit=10")
      .set("Authorization", "Bearer whatever-the-caller-sent");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { symbol: "X1-TEST" } });
    expect(gw.spaceTraders.requests).toHaveLength(1);
    expect(gw.spaceTraders.requests[0].method).toBe("GET");
    expect(gw.spaceTraders.requests[0].url).toBe("/my/ships?page=2&limit=10");
    // Injected (decision 5), not the caller's own header — see
    // injection.test.ts for the dedicated coverage of this behavior.
    expect(gw.spaceTraders.requests[0].authorization).toBe("Bearer fake-agent-token");
  });

  it("forwards a POST body verbatim", async () => {
    const res = await request(gw.app())
      .post("/proxy/my/ships/TEST-1/navigate")
      .set("Authorization", "Bearer test-token")
      .send({ waypointSymbol: "X1-FQ86-B29" });

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests[0].method).toBe("POST");
    expect(JSON.parse(gw.spaceTraders.requests[0].body)).toEqual({ waypointSymbol: "X1-FQ86-B29" });
  });

  it("passes non-retryable upstream errors through unchanged, with a single attempt", async () => {
    gw.spaceTraders.respondWith({ status: 404, body: JSON.stringify({ error: { message: "Ship not found." } }) });

    const res = await request(gw.app()).get("/proxy/my/ships/NOPE").set("Authorization", "Bearer test-token");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: "Ship not found." } });
    expect(gw.spaceTraders.requests).toHaveLength(1);
  });

  it("retries 429s with backoff so the caller only sees the final success", async () => {
    gw.spaceTraders.respondWith(
      { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) },
      { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) },
      { status: 200, body: JSON.stringify({ data: "recovered" }) },
    );

    const res = await request(gw.app()).get("/proxy/my/agent").set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: "recovered" });
    expect(gw.spaceTraders.requests).toHaveLength(3);
  });

  it("honors a Retry-After header on 429 before retrying", async () => {
    gw.spaceTraders.respondWith(
      {
        status: 429,
        body: JSON.stringify({ error: { message: "rate limited" } }),
        headers: { "Retry-After": "0.2" },
      },
      { status: 200, body: JSON.stringify({ data: "recovered" }) },
    );

    const started = Date.now();
    const res = await request(gw.app()).get("/proxy/my/agent").set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests[1].receivedAt - started).toBeGreaterThanOrEqual(150);
  });

  it("retries 5xx errors and surfaces the last upstream response when retries are exhausted", async () => {
    gw.spaceTraders.respondWith({ status: 503, body: JSON.stringify({ error: { message: "upstream down" } }) });

    const res = await request(gw.app({ maxRetries: 2 }))
      .get("/proxy/my/agent")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { message: "upstream down" } });
    // initial attempt + 2 retries
    expect(gw.spaceTraders.requests).toHaveLength(3);
  });

  it("returns 502 when SpaceTraders is unreachable after retries", async () => {
    const res = await request(gw.app({ spaceTradersBaseUrl: "http://127.0.0.1:1", maxRetries: 1 }))
      .get("/proxy/my/agent")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(502);
    expect(res.body.error).toBeDefined();
  });

  it("enforces the global rate budget across concurrent callers", async () => {
    // burst 1 is what makes the elapsed-time bound below meaningful: with a
    // larger bucket the first N requests would all dispatch together.
    const limited = gw.app({ rateLimitRps: 10, rateLimitBurst: 1 });

    await Promise.all(
      Array.from({ length: 8 }, () =>
        request(limited).get("/proxy/my/agent").set("Authorization", "Bearer test-token"),
      ),
    );

    expect(gw.spaceTraders.requests).toHaveLength(8);
    const times = gw.spaceTraders.requests.map((r) => r.receivedAt).sort((a, b) => a - b);
    // 8 requests at 10/s with burst 1 cannot complete faster than ~700ms.
    expect(times[times.length - 1] - times[0]).toBeGreaterThanOrEqual(600);
  });

  it("does not retry a POST on 5xx: the mutation may already have executed upstream", async () => {
    gw.spaceTraders.respondWith({ status: 500, body: JSON.stringify({ error: { message: "internal" } }) });

    const res = await request(gw.app())
      .post("/proxy/my/ships/TEST-1/purchase")
      .set("Authorization", "Bearer test-token")
      .send({ symbol: "FUEL", units: 1 });

    expect(res.status).toBe(500);
    expect(gw.spaceTraders.requests).toHaveLength(1);
  });

  it("retries a POST on 429, since a rate-limited request was never executed", async () => {
    gw.spaceTraders.respondWith(
      { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) },
      { status: 200, body: JSON.stringify({ data: "bought" }) },
    );

    const res = await request(gw.app())
      .post("/proxy/my/ships/TEST-1/purchase")
      .set("Authorization", "Bearer test-token")
      .send({ symbol: "FUEL", units: 1 });

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests).toHaveLength(2);
  });

  it("forwards pacing headers (Retry-After) on a final passed-through 429", async () => {
    gw.spaceTraders.respondWith({
      status: 429,
      body: JSON.stringify({ error: { message: "rate limited" } }),
      headers: { "Retry-After": "3", "x-ratelimit-remaining": "0" },
    });

    const res = await request(gw.app({ maxRetries: 0 }))
      .get("/proxy/my/agent")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("3");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("returns body-parser failures as JSON, not Express's HTML error page", async () => {
    const res = await request(gw.app())
      .post("/proxy/my/ships/TEST-1/navigate")
      .set("Authorization", "Bearer test-token")
      .set("Content-Type", "application/json")
      .send(Buffer.alloc(6 * 1024 * 1024));

    expect(res.status).toBe(413);
    expect(res.body.error.message).toBeDefined();
    expect(gw.spaceTraders.requests).toHaveLength(0);
  });

  // REGRESSION (bug: unhandled rejection in the async /proxy handler).
  // Old behaviour: the handler was an async function whose body-read
  // (`upstream.text()`) was not guarded. When an upstream response fell apart
  // mid-read — connection reset after headers, truncated Content-Length — the
  // promise rejected, Express 4 dropped it as an unhandled rejection, and the
  // caller was left holding an open socket forever with no status and no log
  // line. The client only ever learned about it by timing out.
  it("answers 502 instead of hanging when the upstream response dies mid-body", async () => {
    gw.spaceTraders.respondWith({ status: 200, body: '{"data":', truncated: true });

    const res = await request(gw.app({ maxRetries: 0 })).get("/proxy/my/agent").set("Authorization", "Bearer t");

    expect(res.status).toBe(502);
    expect(res.body.error.message).toBeDefined();
  }, 10_000);

  // REGRESSION (bug: the disconnect check ran only *before* the queue wait).
  // Old behaviour: a caller that gave up while its request sat in the rate
  // limiter still had its upstream call dispatched the moment a token freed
  // up — the one check happened before `acquire()`, i.e. before the wait where
  // callers actually time out. Under a deep queue that spends the shared
  // SpaceTraders budget on responses nobody will ever read.
  it("does not call SpaceTraders for a caller that disconnected while queued", async () => {
    // 1 rps / burst 1: the first request takes the token, the second must wait
    // ~1s — a wide, un-raceable window in which to hang up.
    const server = gw.app({ rateLimitRps: 1, rateLimitBurst: 1, maxRetries: 0 }).listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      await new Promise<void>((resolve) => http.get({ port, path: "/proxy/my/agent" }, (res) => res.resume().on("end", resolve)));
      expect(gw.spaceTraders.requests).toHaveLength(1);

      const abandoned = http.get({ port, path: "/proxy/my/ships" });
      abandoned.on("error", () => {}); // destroying it below is the point, not a failure
      await sleep(100); // queued behind the spent token
      abandoned.destroy();

      await sleep(1500); // well past when a token frees up for it
      expect(gw.spaceTraders.requests).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it.each(["/health", "/api/st-gateway/health"])("exposes a health endpoint at %s", async (path) => {
    const res = await request(gw.app()).get(path);
    expect(res.status).toBe(200);
  });
});

describe("configFromEnv", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("fails startup on values that would silently hang the bucket", () => {
    process.env.RATE_LIMIT_BURST = "0";
    expect(() => configFromEnv()).toThrow(/RATE_LIMIT_BURST/);

    delete process.env.RATE_LIMIT_BURST;
    process.env.RATE_LIMIT_RPS = "two";
    expect(() => configFromEnv()).toThrow(/RATE_LIMIT_RPS/);
  });

  it("falls back to defaults when a variable is unset or empty", () => {
    process.env.RATE_LIMIT_RPS = "";
    delete process.env.RATE_LIMIT_BURST;
    const config = configFromEnv();
    expect(config.rateLimitRps).toBe(2);
    expect(config.rateLimitBurst).toBe(1);
  });

  // REGRESSION (bug: PORT was never validated).
  // Old behaviour: server.ts read `Number(process.env.PORT ?? 3002)` inline,
  // outside configFromEnv's validation. `PORT=http` became NaN, and
  // `listen(NaN)` makes Node bind an arbitrary free port instead of failing —
  // so the service came up "fine" and nothing could reach it.
  it("rejects a non-numeric PORT instead of binding an arbitrary free port", () => {
    process.env.PORT = "http";
    expect(() => configFromEnv()).toThrow(/PORT/);
  });

  // REGRESSION (bug: MAX_RETRIES accepted fractions).
  // Old behaviour: `MAX_RETRIES=2.5` passed validation. The retry loop runs
  // `attempt <= maxRetries` but re-arms on `attempt < maxRetries`, so with a
  // fraction the loop could exit *after a retry* without ever relaying a
  // response — falling through to `502 SpaceTraders unreachable: null` even
  // though SpaceTraders had answered normally.
  it("rejects a fractional MAX_RETRIES, which made the retry loop fall through to a bogus 502", () => {
    process.env.MAX_RETRIES = "2.5";
    expect(() => configFromEnv()).toThrow(/MAX_RETRIES/);
  });
});
