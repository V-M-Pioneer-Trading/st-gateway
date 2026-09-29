import request from "supertest";
import { gatewayConfigFromEnv } from "../config";
import { createApp } from "../server";

/**
 * What the process demands of its environment before it binds a port.
 * gatewayConfigFromEnv is the whole of the startup block in server.ts, so
 * a throw here is a crash before listen().
 */
describe("startup environment", () => {
  const saved = { ...process.env };

  const valid = {
    AUTH_SERVICE_SHARED_SECRET: "vault-secret",
    AUTH_INTROSPECTION_URL: "http://auth-service:8082/auth/v1/introspect",
    AUTH_INTROSPECTION_SECRET: "introspection-secret",
  };

  beforeEach(() => {
    process.env = { ...saved };
    for (const name of [...Object.keys(valid), "CLERK_JWT_KEY", "CLERK_JWT_KEY_FILE", "CLERK_ISSUER"]) {
      delete process.env[name];
    }
  });

  afterAll(() => {
    process.env = { ...saved };
  });

  it("starts with the three auth-service variables and nothing from Clerk", () => {
    Object.assign(process.env, valid);

    const config = gatewayConfigFromEnv();

    expect(config.introspection).toEqual({
      url: "http://auth-service:8082/auth/v1/introspect",
      secret: "introspection-secret",
    });
    expect(config.authServiceSharedSecret).toBe("vault-secret");
  });

  it.each(["AUTH_INTROSPECTION_URL", "AUTH_INTROSPECTION_SECRET", "AUTH_SERVICE_SHARED_SECRET"])(
    "refuses to start without %s, unset or empty, and names it",
    (name) => {
      Object.assign(process.env, valid);

      delete process.env[name];
      expect(() => gatewayConfigFromEnv()).toThrow(name);

      process.env[name] = "";
      expect(() => gatewayConfigFromEnv()).toThrow(name);
    },
  );

  it("never puts the introspection secret in a startup error", () => {
    Object.assign(process.env, valid, { AUTH_INTROSPECTION_URL: "not a url" });

    expect(() => gatewayConfigFromEnv()).toThrow(/AUTH_INTROSPECTION_URL/);
    try {
      gatewayConfigFromEnv();
    } catch (err) {
      expect(String(err)).not.toContain("introspection-secret");
    }
  });

  it.each([
    ["a base URL that is not http(s)", "ftp://auth-service/auth/v1/introspect"],
    ["a URL carrying a query string", "http://auth-service/auth/v1/introspect?secret=x"],
  ])("refuses %s for AUTH_INTROSPECTION_URL", (_name, url) => {
    Object.assign(process.env, valid, { AUTH_INTROSPECTION_URL: url });
    expect(() => gatewayConfigFromEnv()).toThrow(/AUTH_INTROSPECTION_URL/);
  });

  // The stack keeps setting the Clerk variables until meta#80 step 10 removes
  // them. The old gateway read all three and imported the key; this one must
  // not so much as open the file, or a stale mount would take it down.
  it("starts and serves with garbage CLERK_* variables still in the environment", async () => {
    Object.assign(process.env, valid, {
      CLERK_JWT_KEY: "-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----",
      CLERK_JWT_KEY_FILE: "/definitely/not/a/file.pem",
      CLERK_ISSUER: "::not a url::",
    });

    const config = gatewayConfigFromEnv();
    expect(JSON.stringify(config)).not.toMatch(/clerk|not a key/i);

    const res = await request(createApp(config)).get("/health");
    expect(res.status).toBe(200);
  });

  it("does not accept a Clerk key in place of the introspection variables", () => {
    Object.assign(process.env, {
      AUTH_SERVICE_SHARED_SECRET: "vault-secret",
      CLERK_JWT_KEY: "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----",
    });
    expect(() => gatewayConfigFromEnv()).toThrow(/AUTH_INTROSPECTION_URL/);
  });
});
