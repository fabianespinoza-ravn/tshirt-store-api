import type { ThrottlerStorage } from '@nestjs/throttler';

// The package exports the storage contract but not its record type; derive
// it from the contract so the two can never drift apart.
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

interface Window {
  hits: number;
  expiresAt: number;
  blockExpiresAt: number;
}

const secondsUntil = (timestamp: number): number =>
  Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));

/**
 * The in-memory throttler storage, minus its timers, plus `reset()`.
 *
 * Same decision as @nestjs/throttler's own ThrottlerStorageService: the hit
 * that goes past `limit` inside the window is the one that blocks, and the
 * block lasts `blockDuration`. Keeping the semantics is what lets one e2e
 * file assert the 429 for real; `reset()` is what lets every other file
 * hit the sensitive routes more than five times a minute without meeting
 * it.
 */
export class ResettableThrottlerStorage implements ThrottlerStorage {
  private readonly windows = new Map<string, Window>();

  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    const id = `${throttlerName}:${key}`;

    let window = this.windows.get(id);
    if (!window || window.expiresAt <= now) {
      window = { hits: 0, expiresAt: now + ttl, blockExpiresAt: 0 };
      this.windows.set(id, window);
    }

    if (window.blockExpiresAt > now) {
      return Promise.resolve({
        totalHits: window.hits,
        timeToExpire: secondsUntil(window.expiresAt),
        isBlocked: true,
        timeToBlockExpire: secondsUntil(window.blockExpiresAt),
      });
    }

    window.hits += 1;
    const isBlocked = window.hits > limit;
    if (isBlocked) {
      window.blockExpiresAt = now + blockDuration;
    }

    return Promise.resolve({
      totalHits: window.hits,
      timeToExpire: secondsUntil(window.expiresAt),
      isBlocked,
      timeToBlockExpire: isBlocked ? secondsUntil(window.blockExpiresAt) : 0,
    });
  }

  reset(): void {
    this.windows.clear();
  }
}
