/**
 * @file The one place a test app is wired up.
 *
 * Every suite used to repeat the same twelve-field GatewayConfig literal, so
 * adding a config field meant editing four files, and the values that drifted
 * between copies (different rps, different cache TTL) hid which setting a
 * given test actually depended on. Overrides now say exactly that.
 */

import { createApp } from "../server";
import type { GatewayConfig } from "../config";
import { FakeSpaceTraders } from "./fakeSpaceTraders";
import { FakeAuthService, TEST_AUTH_SERVICE_SHARED_SECRET } from "./fakeAuthService";
import { TEST_CLERK_JWT_KEY } from "./authTokens";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Gateway {
  readonly spaceTraders = new FakeSpaceTraders();
  readonly authService = new FakeAuthService();
  private spaceTradersUrl = "";
  private authServiceUrl = "";

  async start() {
    this.spaceTradersUrl = await this.spaceTraders.start();
    this.authServiceUrl = await this.authService.start();
  }

  async stop() {
    await this.spaceTraders.stop();
    await this.authService.stop();
  }

  app(overrides: Partial<GatewayConfig> = {}) {
    return createApp({
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
      clerkJwtKeyPem: TEST_CLERK_JWT_KEY,
      clerkIssuer: null,
      ...overrides,
    });
  }
}

/**
 * Fresh fakes and a fresh app factory per test in the calling describe block.
 * Both request logs are assertion targets, so they must never carry over.
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
    app: (overrides: Partial<GatewayConfig> = {}) => current.app(overrides),
  };
};
