import http from "http";
import type { AddressInfo } from "net";
import { createShutdown, SHUTDOWN_TIMEOUT_MS } from "../shutdown";
import { sleep, useHarness } from "../testSupport/gatewayHarness";

/** A server stub that records what shutdown does to it and lets a test decide when the drain ends. */
function stubServer(calls: string[]) {
  let onClosed: (() => void) | undefined;
  return {
    server: {
      close(cb?: (err?: Error) => void) {
        calls.push("close");
        onClosed = () => { cb?.(); };
        return this as unknown as http.Server;
      },
      closeIdleConnections: () => { calls.push("closeIdle"); },
      closeAllConnections: () => { calls.push("closeAll"); },
    },
    drained: () => { onClosed?.(); },
  };
}

describe("createShutdown: order and bound", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  const setup = (timeoutMs?: number) => {
    const calls: string[] = [];
    const { server, drained } = stubServer(calls);
    const shutdown = createShutdown({
      server,
      drain: () => { calls.push("drain"); },
      stop: () => { calls.push("stop"); },
      exit: (code) => { calls.push(`exit ${String(code)}`); },
      log: (line) => { calls.push(`log ${line}`); },
      timeoutMs,
    });
    /** The calls that matter for order: no log lines, no idle sweeps. */
    const steps = () => calls.filter((c) => !c.startsWith("log") && c !== "closeIdle");
    return { calls, shutdown, drained, steps };
  };

  it("stops accepting first, stops the timers only when in-flight work is done, and exits 0 last", () => {
    const { shutdown, drained, steps } = setup();

    shutdown("SIGTERM");
    expect(steps()).toEqual(["drain", "close"]);

    // Still draining: nothing else happens however long the requests take, up to the bound.
    jest.advanceTimersByTime(SHUTDOWN_TIMEOUT_MS - 1);
    expect(steps()).toEqual(["drain", "close"]);

    drained();
    expect(steps()).toEqual(["drain", "close", "stop", "exit 0"]);
  });

  it("exits at once when nothing is in flight", () => {
    const { shutdown, drained, steps } = setup();
    shutdown("SIGINT");
    drained();
    expect(steps()).toEqual(["drain", "close", "stop", "exit 0"]);
  });

  it("gives up at the bound: closes the remaining connections, stops the timers, exits 0", () => {
    const { shutdown, steps, calls } = setup(); // 8 s by default

    shutdown("SIGTERM");
    jest.advanceTimersByTime(7_999);
    expect(steps()).toEqual(["drain", "close"]);

    jest.advanceTimersByTime(1);
    expect(steps()).toEqual(["drain", "close", "closeAll", "stop", "exit 1"]);
    expect(calls.some((c) => c.startsWith("log st-gateway: in-flight requests still running after 8000 ms"))).toBe(true);
  });

  it("honours another bound", () => {
    const { shutdown, steps } = setup(250);
    shutdown("SIGTERM");
    jest.advanceTimersByTime(249);
    expect(steps()).toEqual(["drain", "close"]);
    jest.advanceTimersByTime(1);
    expect(steps()).toEqual(["drain", "close", "closeAll", "stop", "exit 1"]);
  });

  it("exits only once: a second signal, or a drain that ends after the bound, does nothing more", () => {
    const { shutdown, drained, steps } = setup(100);
    shutdown("SIGTERM");
    shutdown("SIGINT");
    jest.advanceTimersByTime(100);
    drained();
    shutdown("SIGTERM");
    jest.advanceTimersByTime(60_000);
    expect(steps()).toEqual(["drain", "close", "closeAll", "stop", "exit 1"]);
  });

  it("sweeps idle keep-alive connections while it waits, so they cannot hold the drain open", () => {
    const { shutdown, calls } = setup();
    shutdown("SIGTERM");
    const sweeps = () => calls.filter((c) => c === "closeIdle").length;
    const first = sweeps();
    jest.advanceTimersByTime(1_000);
    expect(sweeps()).toBeGreaterThanOrEqual(first + 9);
  });

  it("leaves no timer of its own behind after it finishes", () => {
    const { shutdown, drained } = setup();
    shutdown("SIGTERM");
    drained();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("graceful shutdown of a real gateway", () => {
  const gw = useHarness();
  let server: http.Server | undefined;

  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  const listen = async () => {
    const gateway = gw.gateway();
    const listening = gateway.app.listen(0, "127.0.0.1");
    server = listening;
    await new Promise<void>((resolve) => listening.once("listening", () => { resolve(); }));
    return { gateway, listening, port: (listening.address() as AddressInfo).port };
  };

  const get = (port: number, agent?: http.Agent) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/proxy/my/ships", headers: { Authorization: "Bearer x" }, agent }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += String(c)));
        res.on("end", () => { resolve({ status: res.statusCode ?? 0, body }); });
      });
      req.on("error", reject);
    });

  const connect = (port: number) =>
    new Promise<string>((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/health", agent: false }, () => { resolve("answered"); });
      req.on("error", (err: NodeJS.ErrnoException) => { resolve(err.code ?? "error"); });
    });

  it("lets an in-flight request finish, refuses new connections meanwhile, then stops the timers and exits 0", async () => {
    gw.spaceTraders.respondAfter(300);
    const { gateway, listening, port } = await listen();
    const order: string[] = [];
    let exitCode: number | undefined;
    const exited = new Promise<void>((resolve) => {
      const shutdown = createShutdown({
        server: listening,
        drain: () => { gateway.drain(); },
        stop: () => { order.push("stop"); gateway.stop(); },
        exit: (code) => { order.push("exit"); exitCode = code; resolve(); },
        log: () => undefined,
      });
      setTimeout(() => { order.push("signal"); shutdown("SIGTERM"); }, 100);
    });

    const inFlight = get(port);
    await sleep(150);
    expect(await connect(port)).toBe("ECONNREFUSED");
    expect(order).toEqual(["signal"]);

    const res = await inFlight;
    await exited;
    expect(res.status).toBe(200);
    expect(order).toEqual(["signal", "stop", "exit"]);
    expect(exitCode).toBe(0);
  });

  it("answers Connection: close from the drain on, on new requests and on ones already in flight, and not before", async () => {
    gw.spaceTraders.respondAfter(200);
    const { gateway, port } = await listen();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const connectionHeader = (): Promise<string | undefined> =>
      new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/proxy/my/ships", headers: { Authorization: "Bearer x" }, agent }, (res) => {
            res.resume();
            res.on("end", () => { resolve(res.headers.connection); });
          })
          .on("error", reject);
      });
    try {
      expect(await connectionHeader()).toBe("keep-alive");

      const inFlight = connectionHeader();
      await sleep(50);
      gateway.drain(); // the request is already inside the proxy
      expect(await inFlight).toBe("close");
      expect(await connectionHeader()).toBe("close");
    } finally {
      agent.destroy();
    }
  });

  it("does not wait for an idle keep-alive connection", async () => {
    const { gateway, listening, port } = await listen();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect((await get(port, agent)).status).toBe(200); // the socket now sits idle in the agent's pool
      const started = Date.now();
      await new Promise<void>((resolve) => {
        createShutdown({ server: listening, drain: () => { gateway.drain(); }, stop: () => { gateway.stop(); }, exit: () => { resolve(); }, log: () => undefined })("SIGTERM");
      });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      agent.destroy();
    }
  });

  it("closes a request that outlasts the bound and exits 1", async () => {
    gw.spaceTraders.respondAfter(1_500);
    const { gateway, listening, port } = await listen();
    const inFlight = get(port).catch((err: unknown) => err);
    await sleep(100);
    const started = Date.now();
    let exitCode: number | undefined;
    await new Promise<void>((resolve) => {
      createShutdown({
        server: listening,
        drain: () => { gateway.drain(); },
        stop: () => { gateway.stop(); },
        exit: (code) => { exitCode = code; resolve(); },
        log: () => undefined,
        timeoutMs: 300,
      })("SIGTERM");
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exitCode).toBe(1);
    expect(await inFlight).toMatchObject({ code: expect.stringMatching(/ECONNRESET|UND_ERR/) as unknown });
  });
});
