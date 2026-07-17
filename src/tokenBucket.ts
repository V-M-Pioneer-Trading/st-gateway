/**
 * Token bucket shared by every request the gateway sends upstream: refills at
 * `rps` tokens per second up to `burst` capacity, and hands tokens out FIFO so
 * a flood of background callers cannot starve earlier waiters.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private queue: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private rps: number, private burst: number) {
    if (!Number.isFinite(rps) || rps <= 0 || !Number.isFinite(burst) || burst < 1) {
      throw new Error(`TokenBucket requires rps > 0 and burst >= 1, got rps=${rps} burst=${burst}`);
    }
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.rps);
    this.lastRefill = now;
  }

  private drain() {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length > 0 && this.timer === null) {
      const msUntilNextToken = Math.max(((1 - this.tokens) / this.rps) * 1000, 1);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, msUntilNextToken);
      this.timer.unref?.();
    }
  }
}
