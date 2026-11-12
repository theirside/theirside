import type { Clock } from '../util/clock.js';

/**
 * The simulated clock (simulation mode only). Product time reads it; only the
 * simulation engine moves it, one minute step at a time after that minute's
 * work is done, so a slow machine slows the clock instead of skipping work.
 */
export class SimClock implements Clock {
  constructor(private t: number) {}
  now(): Date {
    return new Date(this.t);
  }
  ms(): number {
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

/** Speeds the controls offer; `max` runs minute after minute without waiting. */
export const SPEEDS = [1, 60, 600, 3600, 'max'] as const;
export type Speed = number | 'max';

export function parseSpeed(v: unknown): Speed | null {
  if (v === 'max') return 'max';
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? n : null;
}
