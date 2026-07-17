export type Priority = "interactive" | "background";

interface Waiter {
  priority: Priority;
  resolve: () => void;
  enqueuedAt: number;
}

interface LatencyStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface QueueMetrics {
  depth: number;
  latencyMs: { count: number; avg: number; max: number };
}

const emptyStats = (): LatencyStats => ({ count: 0, totalMs: 0, maxMs: 0 });

/**
 * Token bucket shared by every request the gateway sends upstream: refills at
 * `rps` tokens per second up to `burst` capacity. Two FIFO queues — interactive
 * and background — share the budget; interactive is always drained first so UI
 * traffic stays responsive while background autopilot traffic saturates the rest.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private queues: Record<Priority, Waiter[]> = { interactive: [], background: [] };
  private stats: Record<Priority, LatencyStats> = { interactive: emptyStats(), background: emptyStats() };
  private timer: NodeJS.Timeout | null = null;

  constructor(private rps: number, private burst: number) {
    if (!Number.isFinite(rps) || rps <= 0 || !Number.isFinite(burst) || burst < 1) {
      throw new Error(`TokenBucket requires rps > 0 and burst >= 1, got rps=${rps} burst=${burst}`);
    }
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  acquire(priority: Priority = "background"): Promise<void> {
    return new Promise((resolve) => {
      this.queues[priority].push({ priority, resolve, enqueuedAt: Date.now() });
      this.drain();
    });
  }

  getMetrics(): Record<Priority, QueueMetrics> {
    const metricsFor = (priority: Priority): QueueMetrics => {
      const s = this.stats[priority];
      return {
        depth: this.queues[priority].length,
        latencyMs: { count: s.count, avg: s.count > 0 ? s.totalMs / s.count : 0, max: s.maxMs },
      };
    };
    return { interactive: metricsFor("interactive"), background: metricsFor("background") };
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.rps);
    this.lastRefill = now;
  }

  private nextWaiter(): Waiter | null {
    return this.queues.interactive.shift() ?? this.queues.background.shift() ?? null;
  }

  private queueLength(): number {
    return this.queues.interactive.length + this.queues.background.length;
  }

  private drain() {
    this.refill();
    while (this.tokens >= 1) {
      const waiter = this.nextWaiter();
      if (waiter === null) break;
      this.tokens -= 1;

      const latencyMs = Date.now() - waiter.enqueuedAt;
      const stats = this.stats[waiter.priority];
      stats.count += 1;
      stats.totalMs += latencyMs;
      stats.maxMs = Math.max(stats.maxMs, latencyMs);

      waiter.resolve();
    }
    if (this.queueLength() > 0 && this.timer === null) {
      const msUntilNextToken = Math.max(((1 - this.tokens) / this.rps) * 1000, 1);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, msUntilNextToken);
      this.timer.unref?.();
    }
  }
}
