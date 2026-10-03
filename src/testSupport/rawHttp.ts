/**
 * @file One request to a real listening gateway, with Authorization sent as
 * the exact header lines a test names.
 *
 * supertest cannot say "two Authorization lines": a header value is one
 * value. Node's own client can — an array value goes out as one line per
 * element — and that is the only way to reach the case the gateway has to
 * count from req.rawHeaders.
 */

import http from "http";
import type { AddressInfo } from "net";
import type { Express } from "express";

export interface RawResponse {
  status: number;
  body: string;
  elapsedMs: number;
}

/**
 * `authorization`: null sends no line, a string sends one, an array sends one
 * line per element, in order (an empty string is an empty line).
 */
export async function sendThrough(
  app: Express,
  { method = "GET", path, authorization }: { method?: string; path: string; authorization: string | string[] | null },
): Promise<RawResponse> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => { resolve(); }));
  const { port } = server.address() as AddressInfo;
  try {
    return await send(port, method, path, authorization);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  }
}

export function send(
  port: number,
  method: string,
  path: string,
  authorization: string | string[] | null,
): Promise<RawResponse> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {};
    if (authorization !== null) headers.Authorization = authorization;
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += String(chunk)));
      res.on("end", () => { resolve({ status: res.statusCode ?? 0, body, elapsedMs: Date.now() - started }); });
    });
    req.on("error", reject);
    req.end();
  });
}
