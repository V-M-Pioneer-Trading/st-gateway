import { createHash } from "crypto";
import { readFileSync } from "fs";
import http from "http";
import { AddressInfo } from "net";
import { join } from "path";
import request from "supertest";
import { useHarness } from "../testSupport/gatewayHarness";
import { TEST_INTROSPECTION_SECRET, unreachableCenterUrl } from "../testSupport/fakeCenter";
import { send, sendThrough } from "../testSupport/rawHttp";

/**
 * meta's introspection fixture, version 5, against the real gateway.
 *
 * Each of the thirteen gateway cases goes through createApp over real HTTP:
 * the case's Authorization lines out of a real client, a real stub center
 * answering as the case says, and the fake SpaceTraders behind it. The lane
 * is read back from /metrics, which counts one dispatch per queue.
 *
 * `expect.lane` is the only verdict a gateway case has, and "a case that
 * produces a status code fails": every case must also come back with
 * SpaceTraders' own 200, relayed, because the gateway never rejects.
 *
 * The forty-one calling-service cases describe a verdict (proceed, 401, 403,
 * 503) that this gateway never reaches, so they are listed by name and
 * skipped. The list is exact: a case added upstream, in either group, fails
 * here until someone decides what it means for the gateway.
 */

const FIXTURE_PATH = join(__dirname, "fixtures", "introspection.json");
const FIXTURE_SHA256 = "ffbb7aa932d8d8523da125a0ff9a93f1fd771d5a32841d7e03ee25ec7b1315b7";
const FIXTURE_BYTES = 56516;

const raw = readFileSync(FIXTURE_PATH);
const fixture = JSON.parse(raw.toString("utf8")) as {
  version: number;
  cases: { name: string }[];
  gatewayCases: GatewayCase[];
};

interface GatewayCase {
  name: string;
  why: string;
  request: { authorization: string | string[] | null };
  center: { notCalled?: true; status?: number; body?: string; delayMs?: number; transport?: "no-response" };
  expect: { outcome: "lane"; lane: "interactive" | "background"; centerCalls: number };
}

const GATEWAY_CASES = [
  "gateway-active-machine",
  "gateway-active-operator",
  "gateway-active-operator-lacking-scope-key",
  "gateway-bearer-with-empty-token",
  "gateway-center-rejects-our-caller-secret",
  "gateway-center-returns-duplicate-key",
  "gateway-center-unreachable",
  "gateway-inactive-token",
  "gateway-kind-machine-with-user-subject",
  "gateway-kind-operator-with-machine-subject",
  "gateway-no-header",
  "gateway-non-bearer-scheme",
  "gateway-two-authorization-lines",
];

/** Driven by ts-introspection-client's own suite; a verdict the gateway never gives. */
const CALLING_SERVICE_CASES = [
  "active-machine-kind",
  "active-with-irregular-scope-whitespace",
  "active-with-multi-value-scope",
  "active-with-required-scope",
  "active-with-scope-differing-only-in-case",
  "active-with-scope-that-is-a-prefix-of-required",
  "active-without-required-scope",
  "bearer-with-empty-token",
  "bearer-with-internal-whitespace",
  "center-rejects-our-caller-secret",
  "center-returns-500",
  "center-returns-duplicate-key",
  "center-returns-malformed-json",
  "center-times-out",
  "center-unreachable",
  "head-on-guarded-route-with-no-header",
  "head-on-guarded-route-with-valid-token",
  "head-on-public-get",
  "inactive-token-on-guarded-route",
  "inactive-token-on-public-get",
  "kind-disagrees-with-sub-prefix",
  "lowercase-bearer-scheme",
  "lowercase-route-method",
  "mutating-route-with-no-declared-scope",
  "mutating-route-with-no-declared-scope-and-inactive-token",
  "mutating-route-with-no-declared-scope-and-no-header",
  "no-header-on-guarded-route",
  "non-bearer-scheme-on-guarded-route",
  "operator-on-public-get",
  "options-on-guarded-route-with-no-header",
  "options-with-no-declared-scope",
  "scoped-route-with-token-lacking-scope-key",
  "session-route-with-inactive-token",
  "session-route-with-no-header",
  "session-route-with-scopeless-token",
  "session-route-with-token-lacking-scope-key",
  "token-on-public-get-while-center-is-down",
  "two-authorization-lines",
  "two-authorization-lines-on-public-get",
  "two-authorization-lines-second-empty",
  "visitor-on-public-get",
];

const KNOWN_KEYS = {
  case: ["name", "why", "request", "center", "expect"],
  request: ["authorization"],
  center: ["notCalled", "status", "body", "delayMs", "transport"],
  expect: ["outcome", "lane", "centerCalls"],
};

/** An unknown key fails the case: a copy that falls behind must not quietly check less. */
const assertKnownKeys = (c: GatewayCase) => {
  const check = (where: keyof typeof KNOWN_KEYS, value: object) => {
    for (const key of Object.keys(value)) {
      if (!KNOWN_KEYS[where].includes(key)) throw new Error(`${c.name}: unknown ${where} key "${key}"`);
    }
  };
  check("case", c);
  check("request", c.request);
  check("center", c.center);
  check("expect", c.expect);
  if (c.expect.outcome !== "lane") throw new Error(`${c.name}: outcome "${c.expect.outcome}" is not a lane`);
  const auth = c.request.authorization;
  const shapeOk =
    auth === null ||
    typeof auth === "string" ||
    (Array.isArray(auth) && auth.length >= 2 && auth.every((line) => typeof line === "string"));
  if (!shapeOk) throw new Error(`${c.name}: request.authorization has a shape the fixture does not define`);
};

describe("introspection fixture v5", () => {
  it("is the vendored copy recorded in SOURCE.txt, byte for byte", () => {
    expect(raw.length).toBe(FIXTURE_BYTES);
    expect(createHash("sha256").update(raw).digest("hex")).toBe(FIXTURE_SHA256);
    expect(fixture.version).toBe(5);
  });

  it("holds exactly the thirteen gateway cases driven below", () => {
    expect(fixture.gatewayCases.map((c) => c.name).sort()).toEqual(GATEWAY_CASES);
  });

  it("holds exactly the forty-one calling-service cases skipped below", () => {
    expect(fixture.cases).toHaveLength(41);
    expect(CALLING_SERVICE_CASES).toHaveLength(41);
    expect(fixture.cases.map((c) => c.name).sort()).toEqual(CALLING_SERVICE_CASES);
  });

  // The two-lines case is only a test if the lines really arrive as two.
  // Node's client sends an array value as one line per element; this pins
  // that, so a client change cannot quietly turn the case into one line.
  it("sends an array-valued authorization as separate header lines", async () => {
    const seen: string[][] = [];
    const probe = http.createServer((req, res) => {
      seen.push(req.rawHeaders);
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    try {
      await send(port, "GET", "/", ["Bearer a", "", "Bearer b"]);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
    const lines = [];
    for (let i = 0; i < seen[0].length; i += 2) {
      if (seen[0][i].toLowerCase() === "authorization") lines.push(seen[0][i + 1]);
    }
    expect(lines).toEqual(["Bearer a", "", "Bearer b"]);
  });
});

describe("gateway cases through the real app", () => {
  const gw = useHarness();

  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  /** Calls the gateway made to `url`, whether or not anything answered them. */
  const callsTo = (url: string) => fetchSpy.mock.calls.filter(([target]) => String(target) === url).length;

  it.each(fixture.gatewayCases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    assertKnownKeys(c);

    let unreachable: string | null = null;
    if (c.center.transport === "no-response") {
      unreachable = await unreachableCenterUrl();
    } else if (c.center.notCalled) {
      // If it is called anyway, it answers the one thing that would move the
      // lane, so a stray call is visible twice: in the count and in the lane.
      gw.center.respondWith({
        status: 200,
        body: JSON.stringify({ active: true, sub: "user_stray", scope: "", exp: 4102444800, kind: "operator" }),
      });
    } else {
      gw.center.respondWith({ status: c.center.status ?? 200, body: c.center.body ?? "", delayMs: c.center.delayMs });
    }
    const gateway =
      unreachable === null ? gw.app() : gw.app({ introspection: { url: unreachable, secret: TEST_INTROSPECTION_SECRET } });

    const res = await sendThrough(gateway, { path: "/proxy/my/agent", authorization: c.request.authorization });

    // The gateway never rejects: SpaceTraders' own answer comes back.
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ data: "ok" });
    expect(gw.spaceTraders.requests).toHaveLength(1);

    const metrics = await request(gateway).get("/metrics");
    const other = c.expect.lane === "interactive" ? "background" : "interactive";
    expect(metrics.body.queues[c.expect.lane].latencyMs.count).toBe(1);
    expect(metrics.body.queues[other].latencyMs.count).toBe(0);

    if (unreachable !== null) {
      // Nothing is listening to count the call, so it is counted where it left.
      expect(callsTo(unreachable)).toBe(c.expect.centerCalls);
    } else {
      // Counted from both ends of the wire, and the two must agree.
      expect(callsTo(gw.centerUrl)).toBe(c.expect.centerCalls);
      expect(gw.center.requests).toHaveLength(c.expect.centerCalls);
      for (const call of gw.center.requests) expect(call.secret).toBe(TEST_INTROSPECTION_SECRET);
    }
  });

  it.skip.each(CALLING_SERVICE_CASES)("%s (a calling-service verdict; the gateway only picks a lane)", () => {});
});

