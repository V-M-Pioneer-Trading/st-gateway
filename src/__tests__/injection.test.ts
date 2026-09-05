import request from "supertest";
import { useHarness } from "../testSupport/gatewayHarness";

describe("st-gateway credential injection (auth-design.md decision 5)", () => {
  const gw = useHarness();

  it("injects the agent token fetched from auth-service, ignoring whatever the caller sent", async () => {
    gw.authService.respondWith({ status: 200, body: { agentToken: "injected-token" } });

    const res = await request(gw.app()).get("/proxy/my/ships").set("Authorization", "Bearer whatever-the-caller-sent");

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests[0].authorization).toBe("Bearer injected-token");
    expect(gw.authService.requests[0].secret).toBe("test-auth-service-secret");
  });

  it("caches the token across requests within the TTL instead of calling auth-service every time", async () => {
    const gateway = gw.app({ authServiceTokenCacheMs: 60_000 });

    await request(gateway).get("/proxy/my/ships").set("Authorization", "Bearer x");
    await request(gateway).get("/proxy/my/agent").set("Authorization", "Bearer x");

    expect(gw.authService.requests).toHaveLength(1);
    expect(gw.spaceTraders.requests).toHaveLength(2);
  });

  it("does not inject anything on GET / — the one unauthenticated SpaceTraders endpoint", async () => {
    const res = await request(gw.app()).get("/proxy/");

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests[0].authorization).toBeUndefined();
    expect(gw.authService.requests).toHaveLength(0);
  });

  // POST /register inverts the injection rule: it authenticates with the
  // *account* token, which only auth-service holds. Injecting the agent token
  // here would break registration outright, and — because an UNCONFIGURED
  // auth-service has no agent token to inject — would make it impossible to
  // ever leave UNCONFIGURED, or to recover automatically after a wipe.
  it("forwards the caller's account token on POST /register instead of injecting", async () => {
    gw.authService.respondWith({ status: 200, body: { agentToken: "injected-token" } });

    const res = await request(gw.app())
      .post("/proxy/register")
      .set("Authorization", "Bearer account-token")
      .send({ symbol: "TESTAGENT", faction: "COSMIC" });

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests[0].authorization).toBe("Bearer account-token");
    expect(gw.authService.requests).toHaveLength(0);
  });

  it("still registers while auth-service is UNCONFIGURED — the bootstrap path must not 503", async () => {
    gw.authService.respondWith({ status: 503, body: { error: { message: "no agent token configured" } } });

    const res = await request(gw.app())
      .post("/proxy/register")
      .set("Authorization", "Bearer account-token")
      .send({ symbol: "TESTAGENT", faction: "COSMIC" });

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests[0].authorization).toBe("Bearer account-token");
  });

  it("does not refetch the agent token when registration itself returns 401", async () => {
    gw.authService.respondWith({ status: 200, body: { agentToken: "injected-token" } });
    gw.spaceTraders.respondWith({ status: 401, body: JSON.stringify({ error: "bad account token" }) });

    const res = await request(gw.app())
      .post("/proxy/register")
      .set("Authorization", "Bearer wrong-account-token")
      .send({ symbol: "TESTAGENT", faction: "COSMIC" });

    expect(res.status).toBe(401);
    // One attempt only: a 401 here is the caller's account token being
    // rejected, not a stale injected token, so retrying would re-attempt a
    // mutation for no reason.
    expect(gw.spaceTraders.requests).toHaveLength(1);
  });

  it("returns 503 without calling SpaceTraders when auth-service has no token (UNCONFIGURED)", async () => {
    gw.authService.respondWith({ status: 503, body: { error: { message: "no agent token configured" } } });

    const res = await request(gw.app()).get("/proxy/my/ships").set("Authorization", "Bearer x");

    expect(res.status).toBe(503);
    expect(gw.spaceTraders.requests).toHaveLength(0);
  });

  it("on a 401, forces an out-of-cycle refresh and retries with the new token", async () => {
    // One long-lived gateway so the token cache carries across both requests
    // below — the whole point is proving a *cached* (now-stale) token gets
    // replaced, not that a fresh fetch happens to get it right.
    const gateway = gw.app({ authServiceTokenCacheMs: 60_000 });

    gw.authService.respondWith({ status: 200, body: { agentToken: "stale-token" } });
    await request(gateway).get("/proxy/my/ships").set("Authorization", "Bearer x");
    expect(gw.spaceTraders.requests[0].authorization).toBe("Bearer stale-token");

    // Simulate the token having gone bad server-side (e.g. Restore Token ran)
    // without the gateway's cache knowing yet.
    gw.authService.respondWith({ status: 200, body: { agentToken: "fresh-token" } });
    gw.spaceTraders.respondWith(
      { status: 401, body: JSON.stringify({ error: { message: "invalid token" } }) },
      { status: 200, body: JSON.stringify({ data: "recovered" }) },
    );

    const res = await request(gateway).get("/proxy/my/agent").set("Authorization", "Bearer x");

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests[gw.spaceTraders.requests.length - 1].authorization).toBe("Bearer fresh-token");
    expect(gw.authService.requests.some((r) => r.url.includes("afterUnauthorized=true"))).toBe(true);
  });

  it("retries a 401 on a POST too — auth fails before any mutation runs", async () => {
    // The refresh must hand back a *different* credential, or there is nothing
    // for the retry to do differently; see the spin regression below.
    gw.authService.respondWith(
      { status: 200, body: { agentToken: "stale-token" } },
      { status: 200, body: { agentToken: "fresh-token" } },
    );
    gw.spaceTraders.respondWith(
      { status: 401, body: JSON.stringify({ error: { message: "invalid token" } }) },
      { status: 200, body: JSON.stringify({ data: "bought" }) },
    );

    const res = await request(gw.app())
      .post("/proxy/my/ships/TEST-1/purchase")
      .set("Authorization", "Bearer x")
      .send({ symbol: "FUEL", units: 1 });

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests).toHaveLength(2);
    expect(gw.spaceTraders.requests[1].authorization).toBe("Bearer fresh-token");
  });

  // REGRESSION (bug: the two credential exceptions matched on the raw URL).
  // Old behaviour: `req.url === "/register"` / `req.url === "/"` compared
  // against the path *plus query string*, so `POST /proxy/register?x=1` fell
  // through to the inject branch — registration went upstream carrying the
  // agent token instead of the caller's account token, and 503'd outright
  // whenever auth-service was UNCONFIGURED, i.e. exactly when registration is
  // the one call that has to work.
  it("treats POST /register as registration even with a query string attached", async () => {
    gw.authService.respondWith({ status: 503, body: { error: { message: "no agent token configured" } } });

    const res = await request(gw.app())
      .post("/proxy/register?trace=1")
      .set("Authorization", "Bearer account-token")
      .send({ symbol: "TESTAGENT", faction: "COSMIC" });

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests[0].authorization).toBe("Bearer account-token");
    expect(gw.authService.requests).toHaveLength(0);
  });

  // REGRESSION (same root cause, the other exception).
  // Old behaviour: `GET /proxy/?x=1` was not recognised as the unauthenticated
  // root, so the gateway tried to inject — and returned 503 while auth-service
  // was UNCONFIGURED, breaking the very poll auth-service uses to discover
  // that SpaceTraders is reachable.
  it("treats GET / as the unauthenticated root even with a query string attached", async () => {
    gw.authService.respondWith({ status: 503, body: { error: { message: "no agent token configured" } } });

    const res = await request(gw.app()).get("/proxy/?status=1");

    expect(res.status).toBe(200);
    expect(gw.spaceTraders.requests[0].authorization).toBeUndefined();
    expect(gw.authService.requests).toHaveLength(0);
  });

  // REGRESSION (bug: a failed forced refresh left the dead token cached).
  // Old behaviour: refreshAfterUnauthorized() only overwrote the cache on
  // success. When the refresh failed, the token SpaceTraders had *just*
  // rejected stayed cached and was re-injected on every subsequent request
  // until the TTL expired — a self-inflicted outage lasting up to
  // AUTH_SERVICE_TOKEN_CACHE_MS.
  it("drops the cached token when a forced refresh fails, instead of re-injecting a known-dead credential", async () => {
    const gateway = gw.app({ authServiceTokenCacheMs: 60_000, maxRetries: 1 });

    gw.authService.respondWith({ status: 200, body: { agentToken: "dead-token" } });
    await request(gateway).get("/proxy/my/ships").set("Authorization", "Bearer x");
    expect(gw.spaceTraders.requests[0].authorization).toBe("Bearer dead-token");

    // SpaceTraders rejects it and auth-service cannot produce a replacement.
    gw.spaceTraders.respondWith({ status: 401, body: JSON.stringify({ error: { message: "invalid token" } }) });
    gw.authService.respondWith({ status: 503, body: { error: { message: "no agent token configured" } } });
    await request(gateway).get("/proxy/my/agent").set("Authorization", "Bearer x");

    // Next call must not reuse the dead token from cache: with auth-service
    // still unable to supply one, that means 503 and no upstream call at all.
    const upstreamCallsSoFar = gw.spaceTraders.requests.length;
    const res = await request(gateway).get("/proxy/my/agent").set("Authorization", "Bearer x");

    expect(res.status).toBe(503);
    expect(gw.spaceTraders.requests).toHaveLength(upstreamCallsSoFar);
  });

  // REGRESSION (bug: 401 retries spun with no backoff and no new credential).
  // Old behaviour: every 401 re-armed the retry loop regardless of whether the
  // forced refresh actually produced a different token, and did so with *zero*
  // delay. A genuinely dead credential therefore burned MAX_RETRIES + 1
  // upstream calls back-to-back out of the shared global budget — on every
  // request — and forced an auth-service poll each time round.
  it("stops retrying a 401 once the forced refresh returns the same credential", async () => {
    gw.authService.respondWith({ status: 200, body: { agentToken: "same-token" } });
    gw.spaceTraders.respondWith({ status: 401, body: JSON.stringify({ error: { message: "invalid token" } }) });

    const res = await request(gw.app({ maxRetries: 3 })).get("/proxy/my/agent").set("Authorization", "Bearer x");

    expect(res.status).toBe(401);
    expect(gw.spaceTraders.requests).toHaveLength(1);
    expect(gw.authService.requests.filter((r) => r.url.includes("afterUnauthorized=true"))).toHaveLength(1);
  });

  // REGRESSION (bug: concurrent cold-cache requests each fetched a token).
  // Old behaviour: getToken() checked the cache, missed, and started its own
  // fetch, so N requests arriving before the first fetch resolved produced N
  // identical auth-service calls. Every cache expiry (and every process start)
  // hit auth-service with a burst proportional to in-flight traffic.
  it("collapses concurrent cold-cache token fetches into a single auth-service call", async () => {
    gw.authService.respondAfter(40);
    const gateway = gw.app({ authServiceTokenCacheMs: 60_000 });

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(gateway).get(`/proxy/my/ships?n=${i}`).set("Authorization", "Bearer x"),
      ),
    );

    expect(gw.spaceTraders.requests).toHaveLength(5);
    expect(gw.authService.requests).toHaveLength(1);
  });

  // REGRESSION (Copilot review: every non-2xx was classified "unconfigured").
  // Old behaviour: `if (!res.ok) return fail("unconfigured", ...)` lumped a
  // broken auth-service (500) and a wrong shared secret (403) in with its
  // documented 503 UNCONFIGURED, so an auth-service outage still answered
  // "SpaceTraders credential not configured" — the exact misdirection the
  // typed failure reason was introduced to remove.
  it("reports an auth-service 500 as an auth-service fault, not an unconfigured credential", async () => {
    gw.authService.respondWith({ status: 500, body: { error: { message: "boom" } } });

    const res = await request(gw.app()).get("/proxy/my/ships").set("Authorization", "Bearer x");

    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/auth-service/i);
    expect(res.body.error.message).not.toMatch(/not configured/i);
    expect(gw.spaceTraders.requests).toHaveLength(0);
  });

  // REGRESSION (bug: one null meant two very different things).
  // Old behaviour: the token client returned null both for "auth-service says
  // UNCONFIGURED" and for "auth-service is unreachable", and the gateway
  // answered every one of them with 503 "SpaceTraders credential not
  // configured". An operator paged for a dead auth-service went and checked
  // SpaceTraders credentials instead — the one place nothing was wrong.
  it("distinguishes an unreachable auth-service from an unconfigured one", async () => {
    const unconfigured = gw.app();
    gw.authService.respondWith({ status: 503, body: { error: { message: "no agent token configured" } } });
    const unconfiguredRes = await request(unconfigured).get("/proxy/my/ships").set("Authorization", "Bearer x");

    const unreachable = gw.app({ authServiceUrl: "http://127.0.0.1:1" });
    const unreachableRes = await request(unreachable).get("/proxy/my/ships").set("Authorization", "Bearer x");

    expect(unconfiguredRes.status).toBe(503);
    expect(unreachableRes.status).toBe(503);
    expect(unconfiguredRes.body.error.message).toMatch(/not configured/i);
    expect(unreachableRes.body.error.message).toMatch(/auth-service/i);
    expect(unreachableRes.body.error.message).not.toEqual(unconfiguredRes.body.error.message);
    expect(gw.spaceTraders.requests).toHaveLength(0);
  });
});
