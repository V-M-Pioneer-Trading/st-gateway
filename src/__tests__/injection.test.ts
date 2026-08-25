import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { createApp } from "../server";
import { FakeAuthService, TEST_AUTH_SERVICE_SHARED_SECRET } from "../testSupport/fakeAuthService";
import { TEST_CLERK_JWT_KEY } from "../testSupport/authTokens";

/** Same fake SpaceTraders API shape as gateway.test.ts, kept local. */
class FakeSpaceTraders {
  server: http.Server;
  requests: { method: string; url: string; authorization?: string }[] = [];
  private responses: { status: number; body: string }[] = [{ status: 200, body: JSON.stringify({ data: "ok" }) }];

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.requests.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
        const next = this.responses.length > 1 ? this.responses.shift()! : this.responses[0];
        res.writeHead(next.status, { "Content-Type": "application/json" });
        res.end(next.body);
      });
    });
  }

  respondWith(...responses: { status: number; body: string }[]) {
    this.responses = responses;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop() {
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe("st-gateway credential injection (auth-design.md decision 5)", () => {
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

  it("injects the agent token fetched from auth-service, ignoring whatever the caller sent", async () => {
    authService.respondWith(200, { agentToken: "injected-token" });

    const res = await request(app())
      .get("/proxy/my/ships")
      .set("Authorization", "Bearer whatever-the-caller-sent");

    expect(res.status).toBe(200);
    expect(fake.requests[0].authorization).toBe("Bearer injected-token");
    expect(authService.requests[0].secret).toBe(TEST_AUTH_SERVICE_SHARED_SECRET);
  });

  it("caches the token across requests within the TTL instead of calling auth-service every time", async () => {
    const gateway = app({ authServiceTokenCacheMs: 60_000 });

    await request(gateway).get("/proxy/my/ships").set("Authorization", "Bearer x");
    await request(gateway).get("/proxy/my/agent").set("Authorization", "Bearer x");

    expect(authService.requests).toHaveLength(1);
    expect(fake.requests).toHaveLength(2);
  });

  it("does not inject anything on GET / — the one unauthenticated SpaceTraders endpoint", async () => {
    const res = await request(app()).get("/proxy/");

    expect(res.status).toBe(200);
    expect(fake.requests[0].authorization).toBeUndefined();
    expect(authService.requests).toHaveLength(0);
  });

  // POST /register inverts the injection rule: it authenticates with the
  // *account* token, which only auth-service holds. Injecting the agent token
  // here would break registration outright, and — because an UNCONFIGURED
  // auth-service has no agent token to inject — would make it impossible to
  // ever leave UNCONFIGURED, or to recover automatically after a wipe.
  it("forwards the caller's account token on POST /register instead of injecting", async () => {
    authService.respondWith(200, { agentToken: "injected-token" });

    const res = await request(app())
      .post("/proxy/register")
      .set("Authorization", "Bearer account-token")
      .send({ symbol: "TESTAGENT", faction: "COSMIC" });

    expect(res.status).toBe(200);
    expect(fake.requests[0].authorization).toBe("Bearer account-token");
    expect(authService.requests).toHaveLength(0);
  });

  it("still registers while auth-service is UNCONFIGURED — the bootstrap path must not 503", async () => {
    authService.respondWith(503, { error: { message: "no agent token configured" } });

    const res = await request(app())
      .post("/proxy/register")
      .set("Authorization", "Bearer account-token")
      .send({ symbol: "TESTAGENT", faction: "COSMIC" });

    expect(res.status).toBe(200);
    expect(fake.requests[0].authorization).toBe("Bearer account-token");
  });

  it("does not refetch the agent token when registration itself returns 401", async () => {
    authService.respondWith(200, { agentToken: "injected-token" });
    fake.respondWith({ status: 401, body: JSON.stringify({ error: "bad account token" }) });

    const res = await request(app())
      .post("/proxy/register")
      .set("Authorization", "Bearer wrong-account-token")
      .send({ symbol: "TESTAGENT", faction: "COSMIC" });

    expect(res.status).toBe(401);
    // One attempt only: a 401 here is the caller's account token being
    // rejected, not a stale injected token, so retrying would re-attempt a
    // mutation for no reason.
    expect(fake.requests).toHaveLength(1);
  });

  it("returns 503 without calling SpaceTraders when auth-service has no token (UNCONFIGURED)", async () => {
    authService.respondWith(503, { error: { message: "no agent token configured" } });

    const res = await request(app()).get("/proxy/my/ships").set("Authorization", "Bearer x");

    expect(res.status).toBe(503);
    expect(fake.requests).toHaveLength(0);
  });

  it("returns 503 when auth-service is unreachable", async () => {
    const gateway = app({ authServiceUrl: "http://127.0.0.1:1" });

    const res = await request(gateway).get("/proxy/my/ships").set("Authorization", "Bearer x");

    expect(res.status).toBe(503);
    expect(fake.requests).toHaveLength(0);
  });

  it("on a 401, forces an out-of-cycle refresh and retries with the new token", async () => {
    // One long-lived gateway so the token cache carries across both requests
    // below — the whole point is proving a *cached* (now-stale) token gets
    // replaced, not that a fresh fetch happens to get it right.
    const gateway = app({ authServiceTokenCacheMs: 60_000 });

    authService.respondWith(200, { agentToken: "stale-token" });
    fake.respondWith({ status: 200, body: JSON.stringify({ data: "ok" }) });
    await request(gateway).get("/proxy/my/ships").set("Authorization", "Bearer x");
    expect(fake.requests[0].authorization).toBe("Bearer stale-token");

    // Simulate the token having gone bad server-side (e.g. Restore Token ran)
    // without the gateway's cache knowing yet.
    authService.respondWith(200, { agentToken: "fresh-token" });
    fake.respondWith(
      { status: 401, body: JSON.stringify({ error: { message: "invalid token" } }) },
      { status: 200, body: JSON.stringify({ data: "recovered" }) },
    );

    const res = await request(gateway).get("/proxy/my/agent").set("Authorization", "Bearer x");

    expect(res.status).toBe(200);
    expect(fake.requests[fake.requests.length - 1].authorization).toBe("Bearer fresh-token");
    expect(authService.requests.some((r) => r.url.includes("afterUnauthorized=true"))).toBe(true);
  });

  it("does not retry a POST-with-401 as if it were a mutation-unsafe 5xx: it retries anyway (auth fails before any mutation runs)", async () => {
    authService.respondWith(200, { agentToken: "fresh-token" });
    fake.respondWith(
      { status: 401, body: JSON.stringify({ error: { message: "invalid token" } }) },
      { status: 200, body: JSON.stringify({ data: "bought" }) },
    );

    const res = await request(app())
      .post("/proxy/my/ships/TEST-1/purchase")
      .set("Authorization", "Bearer x")
      .send({ symbol: "FUEL", units: 1 });

    expect(res.status).toBe(200);
    expect(fake.requests).toHaveLength(2);
  });
});
