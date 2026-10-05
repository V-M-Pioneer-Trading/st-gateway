/**
 * @file Graceful shutdown: what SIGTERM (`docker stop`) and SIGINT do.
 *
 * Order, and why:
 *  1. Stop accepting: `server.close()` refuses new connections at once. Idle
 *     keep-alive sockets are closed (and re-checked until the drain ends), so
 *     they do not hold the process open.
 *  2. Let in-flight requests finish. Their calls to SpaceTraders still need the
 *     token bucket, so its timer is left running through this step.
 *  3. Stop the token bucket's timer, once the last request is done.
 *  4. Exit 0.
 *
 * The drain is bounded: past `timeoutMs` the remaining connections are
 * destroyed, the bucket is stopped and the process exits 0 all the same.
 * Docker kills a container 10 s after SIGTERM unless `stop_grace_period` says
 * otherwise, so a deployment that wants the full bound there sets it higher.
 */

import type http from "http";

/** The most a shutdown waits for in-flight requests. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;
/** How often idle keep-alive sockets are swept while draining. */
const IDLE_SWEEP_MS = 100;

export interface ShutdownDeps {
  readonly server: Pick<http.Server, "close" | "closeIdleConnections" | "closeAllConnections">;
  /** Stops the gateway's timers (the token bucket's); called once, after the drain. */
  readonly stop: () => void;
  readonly exit: (code: number) => void;
  readonly log: (line: string) => void;
  readonly timeoutMs?: number;
}

/** Returns the handler for a termination signal. A second signal while shutting down is ignored. */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const { server, stop, exit, log, timeoutMs = SHUTDOWN_TIMEOUT_MS } = deps;
  let started = false;

  return (signal) => {
    if (started) return;
    started = true;
    log(`st-gateway: ${signal} received, no longer accepting; waiting up to ${String(timeoutMs)} ms for in-flight requests`);

    let finished = false;
    const finish = (forced: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearInterval(sweep);
      if (forced) {
        log(`st-gateway: in-flight requests still running after ${String(timeoutMs)} ms; closing their connections`);
        server.closeAllConnections();
      }
      stop();
      exit(0);
    };

    // Not unref'd: the process stays up until one of the two ends the drain.
    const deadline = setTimeout(() => { finish(true); }, timeoutMs);
    const sweep = setInterval(() => { server.closeIdleConnections(); }, IDLE_SWEEP_MS);
    server.close(() => { finish(false); });
    server.closeIdleConnections();
  };
}

/** Wires SIGTERM and SIGINT to a graceful shutdown of `server`. */
export function installGracefulShutdown(server: http.Server, stop: () => void): void {
  const shutdown = createShutdown({
    server,
    stop,
    exit: (code) => process.exit(code),
    log: (line) => { console.log(line); },
  });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  process.on("SIGINT", () => { shutdown("SIGINT"); });
}
