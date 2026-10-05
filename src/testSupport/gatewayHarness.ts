/**
 * @file The one place a test app is wired up.
 *
 * Every suite used to repeat the same twelve-field GatewayConfig literal, so
 * adding a config field meant editing four files, and the values that drifted
 * between copies (different rps, different cache TTL) hid which setting a
 * given test actually depended on. Overrides now say exactly that.
 */

import { createGateway } from "../server";
import type { GatewayConfig } from "../config";
import { FakeSpaceTraders } from "./fakeSpaceTraders";
import { FakeAuthService, TEST_AUTH_SERVICE_SHARED_SECRET } from "./fakeAuthService";
import { FakeCenter, TEST_INTROSPECTION_SECRET } from "./fakeCenter";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Gateway {
  readonly spaceTraders = new FakeSpaceTraders();
  readonly authService = new FakeAuthService();
  readonly center = new FakeCenter();
  private spaceTradersUrl = "";
  private authServiceUrl = "";
  /** The full introspection endpoint URL the default app is configured with. */
  centerUrl = "";

  async start() {
    this.spaceTradersUrl = await this.spaceTraders.start();
    this.authServiceUrl = await this.authService.start();
    this.centerUrl = await this.center.start();
  }

  async stop() {
    await this.spaceTraders.stop();
    await this.authService.stop();
    await this.center.stop();
  }

  gateway(overrides: Partial<GatewayConfig> = {}) {
    return createGateway({
      // Never listened on: every suite drives the app through supertest.
      port: 0,
      spaceTradersBaseUrl: this.spaceTradersUrl,
      rateLimitRps: 100,
      rateLimitBurst: 100,
      maxRetries: 3,
      retryBaseMs: 5,
      maxRetryDelayMs: 30_000,
      authServiceUrl: this.authServiceUrl,
      authServiceSharedSecret: TEST_AUTH_SERVICE_SHARED_SECRET,
      authServiceTokenCacheMs: 30_000,
      introspection: { url: this.centerUrl, secret: TEST_INTROSPECTION_SECRET },
      ...overrides,
    });
  }

  app(overrides: Partial<GatewayConfig> = {}) {
    return this.gateway(overrides).app;
  }
}

/**
 * Fresh fakes and a fresh app factory per test in the calling describe block.
 * All three request logs are assertion targets, so they must never carry over.
 */
export const useHarness = () => {
  let current: Gateway;

  beforeEach(async () => {
    current = new Gateway();
    await current.start();
  });
  afterEach(() => current.stop());

  return {
    get spaceTraders() {
      return current.spaceTraders;
    },
    get authService() {
      return current.authService;
    },
    get center() {
      return current.center;
    },
    get centerUrl() {
      return current.centerUrl;
    },
    app: (overrides: Partial<GatewayConfig> = {}) => current.app(overrides),
    /** The app with its stop function, for the tests that listen on a real port. */
    gateway: (overrides: Partial<GatewayConfig> = {}) => current.gateway(overrides),
  };
};
