import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { createApp } from "../server";
import { configFromEnv } from "../config";
import { FakeAuthService, TEST_AUTH_SERVICE_SHARED_SECRET } from "../testSupport/fakeAuthService";
import { TEST_CLERK_JWT_KEY } from "../testSupport/authTokens";

/**
 * In-process fake SpaceTraders API. Records every request (path, method,
 * headers, body, arrival time) and replies from a programmable queue of
 * responses (last one repeats).
 */
class FakeSpaceTraders {
  server: http.Server;
  requests: {
    method: string;
    url: string;
    authorization?: string;
    body: string;
    receivedAt: number;
  }[] = [];
  private responses: { status: number; body: string; headers?: Record<string, string> }[] = [
    { status: 200, body: JSON.stringify({ data: "ok" }) },
  ];

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          authorization: req.headers.authorization,
          body,
          receivedAt: Date.now(),
        });
        const next =
          this.responses.length > 1 ? this.responses.shift()! : this.responses[0];
        res.writeHead(next.status, {
          "Content-Type": "application/json",
          ...next.headers,
        });
        res.end(next.body);
      });
    });
  }

  /** Queue responses in order; the final entry repeats forever. */
  respondWith(...responses: { status: number; body: string; headers?: Record<string, string> }[]) {
    this.responses = responses;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop() {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

describe("st-gateway proxy", () => {
  let fake: FakeSpaceTraders;
  let baseUrl: string;
  let authService: FakeAuthService;
  let authServiceUrl: string;

  beforeEach(async () => {
    fake = new FakeSpaceTraders();
    baseUrl = await fake.start();
    authService = new FakeAuthService();
    authServiceUrl = await authService.start();
  });

  afterEach(async () => {
    await fake.stop();
    await authService.stop();
  });

  const app = (overrides: Partial<Parameters<typeof createApp>[0]> = {}) =>
    createApp({
      spaceTradersBaseUrl: baseUrl,
      rateLimitRps: 100,
      rateLimitBurst: 100,
      maxRetries: 3,
      retryBaseMs: 5,
      maxRetryDelayMs: 30_000,
      authServiceUrl,
      authServiceSharedSecret: TEST_AUTH_SERVICE_SHARED_SECRET,
      authServiceTokenCacheMs: 30_000,
      clerkJwtKeyPem: TEST_CLERK_JWT_KEY,
      clerkIssuer: null,
      ...overrides,
    });

  it("forwards a GET's query string and injects the credential fetched from auth-service", async () => {
    fake.respondWith({ status: 200, body: JSON.stringify({ data: { symbol: "X1-TEST" } }) });

    const res = await request(app())
      .get("/proxy/my/ships?page=2&limit=10")
      .set("Authorization", "Bearer whatever-the-caller-sent");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { symbol: "X1-TEST" } });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].method).toBe("GET");
    expect(fake.requests[0].url).toBe("/my/ships?page=2&limit=10");
    // Injected (decision 5), not the caller's own header — see
    // injection.test.ts for the dedicated coverage of this behavior.
    expect(fake.requests[0].authorization).toBe("Bearer fake-agent-token");
  });

  it("forwards a POST body verbatim", async () => {
    const res = await request(app())
      .post("/proxy/my/ships/TEST-1/navigate")
      .set("Authorization", "Bearer test-token")
      .send({ waypointSymbol: "X1-FQ86-B29" });

    expect(res.status).toBe(200);
    expect(fake.requests[0].method).toBe("POST");
    expect(JSON.parse(fake.requests[0].body)).toEqual({ waypointSymbol: "X1-FQ86-B29" });
  });

  it("passes non-retryable upstream errors through unchanged, with a single attempt", async () => {
    fake.respondWith({
      status: 404,
      body: JSON.stringify({ error: { message: "Ship not found." } }),
    });

    const res = await request(app())
      .get("/proxy/my/ships/NOPE")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: "Ship not found." } });
    expect(fake.requests).toHaveLength(1);
  });

  it("retries 429s with backoff so the caller only sees the final success", async () => {
    fake.respondWith(
      { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) },
      { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) },
      { status: 200, body: JSON.stringify({ data: "recovered" }) }
    );

    const res = await request(app())
      .get("/proxy/my/agent")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: "recovered" });
    expect(fake.requests).toHaveLength(3);
  });

  it("honors a Retry-After header on 429 before retrying", async () => {
    fake.respondWith(
      {
        status: 429,
        body: JSON.stringify({ error: { message: "rate limited" } }),
        headers: { "Retry-After": "0.2" },
      },
      { status: 200, body: JSON.stringify({ data: "recovered" }) }
    );

    const started = Date.now();
    const res = await request(app())
      .get("/proxy/my/agent")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(fake.requests[1].receivedAt - started).toBeGreaterThanOrEqual(150);
  });

  it("retries 5xx errors and surfaces the last upstream response when retries are exhausted", async () => {
    fake.respondWith({
      status: 503,
      body: JSON.stringify({ error: { message: "upstream down" } }),
    });

    const res = await request(app({ maxRetries: 2 }))
      .get("/proxy/my/agent")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { message: "upstream down" } });
    // initial attempt + 2 retries
    expect(fake.requests).toHaveLength(3);
  });

  it("returns 502 when SpaceTraders is unreachable after retries", async () => {
    const unreachable = app({
      spaceTradersBaseUrl: "http://127.0.0.1:1",
      maxRetries: 1,
    });

    const res = await request(unreachable)
      .get("/proxy/my/agent")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(502);
    expect(res.body.error).toBeDefined();
  });

  it("enforces the global rate budget across concurrent callers", async () => {
    const rps = 10;
    const burst = 1;
    const limited = app({ rateLimitRps: rps, rateLimitBurst: burst });

    await Promise.all(
      Array.from({ length: 8 }, () =>
        request(limited).get("/proxy/my/agent").set("Authorization", "Bearer test-token")
      )
    );

    expect(fake.requests).toHaveLength(8);
    const times = fake.requests.map((r) => r.receivedAt).sort((a, b) => a - b);
    // 8 requests at 10/s with burst 1 cannot complete faster than ~700ms.
    expect(times[times.length - 1] - times[0]).toBeGreaterThanOrEqual(600);
    expect(burst).toBe(1); // documents the budget the elapsed-time bound assumes
  });

  it("does not retry a POST on 5xx: the mutation may already have executed upstream", async () => {
    fake.respondWith({
      status: 500,
      body: JSON.stringify({ error: { message: "internal" } }),
    });

    const res = await request(app())
      .post("/proxy/my/ships/TEST-1/purchase")
      .set("Authorization", "Bearer test-token")
      .send({ symbol: "FUEL", units: 1 });

    expect(res.status).toBe(500);
    expect(fake.requests).toHaveLength(1);
  });

  it("retries a POST on 429, since a rate-limited request was never executed", async () => {
    fake.respondWith(
      { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) },
      { status: 200, body: JSON.stringify({ data: "bought" }) }
    );

    const res = await request(app())
      .post("/proxy/my/ships/TEST-1/purchase")
      .set("Authorization", "Bearer test-token")
      .send({ symbol: "FUEL", units: 1 });

    expect(res.status).toBe(200);
    expect(fake.requests).toHaveLength(2);
  });

  it("forwards pacing headers (Retry-After) on a final passed-through 429", async () => {
    fake.respondWith({
      status: 429,
      body: JSON.stringify({ error: { message: "rate limited" } }),
      headers: { "Retry-After": "3", "x-ratelimit-remaining": "0" },
    });

    const res = await request(app({ maxRetries: 0 }))
      .get("/proxy/my/agent")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("3");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("returns body-parser failures as JSON, not Express's HTML error page", async () => {
    const res = await request(app())
      .post("/proxy/my/ships/TEST-1/navigate")
      .set("Authorization", "Bearer test-token")
      .set("Content-Type", "application/json")
      .send(Buffer.alloc(6 * 1024 * 1024));

    expect(res.status).toBe(413);
    expect(res.body.error.message).toBeDefined();
    expect(fake.requests).toHaveLength(0);
  });

  it.each(["/health", "/api/st-gateway/health"])("exposes a health endpoint at %s", async (path) => {
    const res = await request(app()).get(path);
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
});
