/**
 * @file In-process fake SpaceTraders API — the upstream seam for every test.
 *
 * One copy, shared. gateway/priority/injection each used to carry their own
 * near-identical class; the drift between them (some recorded bodies, some
 * only arrival times) made it impossible to move a test between files.
 */

import http from "http";
import { AddressInfo } from "net";

export interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
  body: string;
  receivedAt: number;
}

export interface FakeResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
  /**
   * Reply with a Content-Length that promises more than is written, then kill
   * the socket. undici surfaces that as a rejected `.text()` — the only way to
   * exercise the gateway's "upstream response fell apart mid-read" path.
   */
  truncated?: boolean;
}

export class FakeSpaceTraders {
  readonly server: http.Server;
  readonly requests: RecordedRequest[] = [];
  private responses: FakeResponse[] = [{ status: 200, body: JSON.stringify({ data: "ok" }) }];
  private delayMs = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          authorization: req.headers.authorization,
          body,
          receivedAt: Date.now(),
        });
        const next = this.responses.length > 1 ? this.responses.shift()! : this.responses[0];
        setTimeout(() => this.reply(res, next), this.delayMs);
      });
    });
  }

  private reply(res: http.ServerResponse, next: FakeResponse) {
    if (next.truncated) {
      res.socket?.write(
        `HTTP/1.1 ${next.status} OK\r\nContent-Type: application/json\r\nContent-Length: ${next.body.length + 64}\r\n\r\n${next.body}`,
      );
      res.socket?.destroy();
      return;
    }
    res.writeHead(next.status, { "Content-Type": "application/json", ...next.headers });
    res.end(next.body);
  }

  /** Queue responses in order; the final entry repeats forever. */
  respondWith(...responses: FakeResponse[]) {
    this.responses = responses;
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
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }
}
