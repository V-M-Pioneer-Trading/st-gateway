/**
 * @file In-process fake auth-service introspection endpoint: the center that
 * st-gateway asks which lane a caller's token earns (decision 21).
 *
 * A real HTTP server, not a mocked fetch, because what matters is what went
 * over the wire: how many calls one inbound request made, which token was
 * asked about, and which secret was presented. Every request is recorded.
 *
 * Answers are chosen per token, so one test can mix an operator, a machine
 * and an anonymous caller. OPERATOR_TOKEN and MACHINE_TOKEN are known out of
 * the box; any other token is inactive unless a test says otherwise. None of
 * them is a JWT: the gateway must never look inside a token, so a token it
 * could parse would hide a gateway that did.
 */

import http from "http";
import type { AddressInfo } from "net";

export const INTROSPECTION_PATH = "/auth/v1/introspect";
export const TEST_INTROSPECTION_SECRET = "test-introspection-secret";

export const OPERATOR_TOKEN = "operator.test.token";
export const MACHINE_TOKEN = "machine.test.token";
export const OPERATOR_BEARER = `Bearer ${OPERATOR_TOKEN}`;
export const MACHINE_BEARER = `Bearer ${MACHINE_TOKEN}`;

export interface CenterReply {
  status: number;
  body: string;
  /** Hold the reply this long. Longer than the gateway's lane timeout means "hanging". */
  delayMs?: number;
}

export const ACTIVE_OPERATOR: CenterReply = {
  status: 200,
  body: JSON.stringify({ active: true, sub: "user_2TestOperator", scope: "fleet:control", exp: 4102444800, kind: "operator" }),
};
export const ACTIVE_MACHINE: CenterReply = {
  status: 200,
  body: JSON.stringify({ active: true, sub: "mch_3TestMachine", scope: "fleet:control", exp: 4102444800, kind: "machine" }),
};
export const INACTIVE: CenterReply = { status: 200, body: JSON.stringify({ active: false }) };

export interface CenterCall {
  method: string;
  url: string;
  contentType: string | undefined;
  secret: string | undefined;
  /** The token the gateway asked about, decoded from the form body. */
  token: string | null;
}

export class FakeCenter {
  readonly server: http.Server;
  readonly requests: CenterCall[] = [];
  private readonly byToken = new Map<string, CenterReply>([
    [OPERATOR_TOKEN, ACTIVE_OPERATOR],
    [MACHINE_TOKEN, ACTIVE_MACHINE],
  ]);
  private fallback: CenterReply = INACTIVE;
  private override: CenterReply | null = null;
  private readonly pending = new Set<NodeJS.Timeout>();

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        const token = new URLSearchParams(body).get("token");
        this.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          contentType: req.headers["content-type"],
          secret: req.headers["x-introspection-secret"] as string | undefined,
          token,
        });
        const reply = this.override ?? (token !== null ? this.byToken.get(token) : undefined) ?? this.fallback;
        const send = () => {
          if (res.writableEnded) return;
          res.writeHead(reply.status, { "Content-Type": "application/json" });
          res.end(reply.body);
        };
        if (reply.delayMs === undefined || reply.delayMs <= 0) {
          send();
          return;
        }
        const timer = setTimeout(() => {
          this.pending.delete(timer);
          send();
        }, reply.delayMs);
        this.pending.add(timer);
      });
    });
  }

  /** Answer this one token with `reply`. */
  answer(token: string, reply: CenterReply) {
    this.byToken.set(token, reply);
  }

  /** Answer every token with `reply`, whatever it is. */
  respondWith(reply: CenterReply) {
    this.override = reply;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}${INTROSPECTION_PATH}`;
  }

  async stop() {
    // A delayed answer nobody is waiting for any more would otherwise hold
    // the suite open for its full delay.
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      }));
  }
}

/** A URL with nothing listening behind it: bind a port, then give it back. */
export async function unreachableCenterUrl(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => { resolve(); }));
  return `http://127.0.0.1:${String(port)}${INTROSPECTION_PATH}`;
}
