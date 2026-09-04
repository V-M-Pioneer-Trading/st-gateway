/**
 * @file In-process fake auth-service. Responds to GET /auth/v1/token from a
 * programmable queue, and records every request (path + the shared secret it
 * was called with) so tests can assert on what st-gateway sent.
 *
 * Queue semantics deliberately match FakeSpaceTraders: responses are consumed
 * in order and the last one repeats. Tests that need to model a *genuinely*
 * rotated credential (a forced refresh that returns something new) depend on
 * it.
 */

import http from "http";
import { AddressInfo } from "net";

export interface FakeAuthResponse {
  status: number;
  body: unknown;
}

export class FakeAuthService {
  readonly server: http.Server;
  readonly requests: { url: string; secret: string | undefined }[] = [];
  private responses: FakeAuthResponse[] = [{ status: 200, body: { agentToken: "fake-agent-token" } }];
  private delayMs = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      this.requests.push({ url: req.url ?? "", secret: req.headers["x-auth-service-secret"] as string | undefined });
      const next = this.responses.length > 1 ? this.responses.shift()! : this.responses[0];
      setTimeout(() => {
        res.writeHead(next.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(next.body));
      }, this.delayMs);
    });
  }

  /** Queue responses in order; the final entry repeats forever. */
  respondWith(...responses: FakeAuthResponse[]) {
    this.responses = responses;
  }

  /** Hold every reply open, so concurrent callers overlap on a cold cache. */
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

export const TEST_AUTH_SERVICE_SHARED_SECRET = "test-auth-service-secret";
