import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { createApp } from "../server";

/** Same fake SpaceTraders API as gateway.test.ts, kept local to avoid a shared-fixture seam. */
class FakeSpaceTraders {
  server: http.Server;
  requests: { url: string; receivedAt: number }[] = [];
  private delayMs = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.requests.push({ url: req.url ?? "", receivedAt: Date.now() });
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: "ok" }));
        }, this.delayMs);
      });
    });
  }

  /** Simulate a slow upstream so requests pile up in the gateway's queue behind it. */
  respondAfter(ms: number) {
    this.delayMs = ms;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("st-gateway priority classes and observability", () => {
  let fake: FakeSpaceTraders;
  let baseUrl: string;

  beforeEach(async () => {
    fake = new FakeSpaceTraders();
    baseUrl = await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  const app = () =>
    createApp({
      spaceTradersBaseUrl: baseUrl,
      rateLimitRps: 5,
      rateLimitBurst: 1,
      maxRetries: 0,
      retryBaseMs: 5,
      maxRetryDelayMs: 30_000,
    });

  it("serves an interactive request ahead of background requests queued before it", async () => {
    const gateway = app();

    // Burst of 1 lets the first request through immediately, queueing the rest
    // at 5/s (200ms apart) — plenty of room to insert the interactive request.
    const background = Array.from({ length: 4 }, (_, i) =>
      request(gateway).get(`/proxy/my/agent?bg=${i}`).set("Authorization", "Bearer t")
    );

    await sleep(30); // let the background requests reach the gateway and queue
    const interactive = request(gateway)
      .get("/proxy/my/agent?priority=interactive")
      .set("Authorization", "Bearer t")
      .set("X-Priority", "interactive");

    await Promise.all([...background, interactive]);

    const arrivalOrder = fake.requests.map((r) => r.url);
    const interactiveIndex = arrivalOrder.findIndex((u) => u.includes("priority=interactive"));
    // The very first background request may already have claimed the burst
    // token before the interactive request was even sent; every request queued
    // behind it must yield to the interactive one.
    expect(interactiveIndex).toBeGreaterThanOrEqual(0);
    expect(interactiveIndex).toBeLessThanOrEqual(1);
  });

  it("treats requests without X-Priority as background", async () => {
    const gateway = app();

    const background = Array.from({ length: 3 }, (_, i) =>
      request(gateway).get(`/proxy/my/agent?bg=${i}`).set("Authorization", "Bearer t")
    );
    await sleep(30);
    const unmarked = request(gateway).get("/proxy/my/agent?unmarked=1").set("Authorization", "Bearer t");

    await Promise.all([...background, unmarked]);

    const arrivalOrder = fake.requests.map((r) => r.url);
    const unmarkedIndex = arrivalOrder.findIndex((u) => u.includes("unmarked=1"));
    // No priority boost: it lands wherever plain FIFO puts it, i.e. last.
    expect(unmarkedIndex).toBe(arrivalOrder.length - 1);
  });

  it("exposes queue depth and latency per priority class via /metrics", async () => {
    const gateway = app();
    fake.respondAfter(50);

    const inFlight = Promise.all([
      request(gateway).get("/proxy/my/agent?a=1").set("Authorization", "Bearer t"),
      request(gateway)
        .get("/proxy/my/agent?a=2")
        .set("Authorization", "Bearer t")
        .set("X-Priority", "interactive"),
      request(gateway).get("/proxy/my/agent?a=3").set("Authorization", "Bearer t"),
    ]);

    await sleep(20); // requests queued but not yet all dispatched
    const midFlight = await request(gateway).get("/metrics");
    expect(midFlight.status).toBe(200);
    expect(midFlight.body.queues.interactive.depth + midFlight.body.queues.background.depth).toBeGreaterThan(0);

    await inFlight;

    const after = await request(gateway).get("/metrics");
    expect(after.body.queues.interactive.latencyMs.count).toBeGreaterThanOrEqual(1);
    expect(after.body.queues.background.latencyMs.count).toBeGreaterThanOrEqual(2);
    expect(after.body.queues.interactive.latencyMs.avg).toBeGreaterThanOrEqual(0);
  });
});
