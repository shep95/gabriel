// token bucket: refills `rate` tokens per second, holds at most `burst`.
// rate 0 never refills (useful in tests).
export class TokenBucket {
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = Date.now();
  }

  take(now = Date.now()) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) * this.rate) / 1000);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// fixed window counter. add() returns the running total in the current window.
export class WindowCounter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.start = 0;
    this.total = 0;
  }

  add(n, now = Date.now()) {
    if (now - this.start >= this.windowMs) {
      this.start = now;
      this.total = 0;
    }
    this.total += n;
    return this.total;
  }
}
