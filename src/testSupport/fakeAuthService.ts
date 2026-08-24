/**
 * @file In-process fake auth-service. Responds to GET /auth/v1/token with a
 * configurable status/body, and records every request (path + the shared
 * secret it was called with) so tests can assert on what st-gateway sent.
 */

import http from "http";
import { AddressInfo } from "net";

export class FakeAuthService {
  server: http.Server;
  requests: { url: string; secret: string | undefined }[] = [];
  private response: { status: number; body: unknown } = { status: 200, body: { agentToken: "fake-agent-token" } };

  constructor() {
    this.server = http.createServer((req, res) => {
      this.requests.push({ url: req.url ?? "", secret: req.headers["x-auth-service-secret"] as string | undefined });
      res.writeHead(this.response.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.response.body));
    });
  }

  /** Queue the response every subsequent request gets, until changed again. */
  respondWith(status: number, body: unknown) {
    this.response = { status, body };
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
