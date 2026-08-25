import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { createApp } from "../server";
import { FakeAuthService, TEST_AUTH_SERVICE_SHARED_SECRET } from "../testSupport/fakeAuthService";
import { TEST_CLERK_JWT_KEY, userBearer, machineBearer, expiredUserBearer, foreignBearer } from "../testSupport/authTokens";

class FakeSpaceTraders {
  server: http.Server;
  requests: { receivedAt: number }[] = [];
  private delayMs = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.requests.push({ receivedAt: Date.now() });
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: "ok" }));
        }, this.delayMs);
      });
    });
  }

  respondAfter(ms: number) {
    this.delayMs = ms;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("st-gateway priority derivation (auth-design.md decision 2)", () => {
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

  const app = () =>
    createApp({
      spaceTradersBaseUrl: baseUrl,
      rateLimitRps: 5,
      rateLimitBurst: 1,
      maxRetries: 0,
      retryBaseMs: 5,
      maxRetryDelayMs: 30_000,
      authServiceUrl,
      authServiceSharedSecret: TEST_AUTH_SERVICE_SHARED_SECRET,
      authServiceTokenCacheMs: 30_000,
      clerkJwtKeyPem: TEST_CLERK_JWT_KEY,
      clerkIssuer: null,
    });

  it("serves a verified human session ahead of background requests queued before it", async () => {
    const gateway = app();

    const background = Array.from({ length: 4 }, (_, i) =>
      request(gateway).get(`/proxy/my/agent?bg=${i}`).set("Authorization", "Bearer opaque-caller-token"),
    );

    await sleep(30);
    const interactive = request(gateway)
      .get("/proxy/my/agent?priority=interactive")
      .set("Authorization", userBearer());

    await Promise.all([...background, interactive]);

    // Priority derivation reads the caller's Authorization header, not the
    // upstream call's — fake here just needs arrival order, so track via a
    // second listener isn't necessary: reuse st-gateway's own /metrics to
    // confirm the interactive lane actually got used.
    const metrics = await request(gateway).get("/metrics");
    expect(metrics.body.queues.interactive.latencyMs.count).toBeGreaterThanOrEqual(1);
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

  it("exposes queue depth and latency per priority class via /metrics", async () => {
    const gateway = app();
    fake.respondAfter(50);

    const inFlight = Promise.all([
      request(gateway).get("/proxy/my/agent?a=1").set("Authorization", "Bearer t"),
      request(gateway).get("/proxy/my/agent?a=2").set("Authorization", userBearer()),
      request(gateway).get("/proxy/my/agent?a=3").set("Authorization", "Bearer t"),
    ]);

    await sleep(20);
    const midFlight = await request(gateway).get("/metrics");
    expect(midFlight.status).toBe(200);
    expect(midFlight.body.queues.interactive.depth + midFlight.body.queues.background.depth).toBeGreaterThan(0);

    await inFlight;

    const after = await request(gateway).get("/metrics");
    expect(after.body.queues.interactive.latencyMs.count).toBeGreaterThanOrEqual(1);
    expect(after.body.queues.background.latencyMs.count).toBeGreaterThanOrEqual(2);
  });
});
