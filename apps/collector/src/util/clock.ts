/** Injectable time source so scheduler and scoring tests can fake the clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Test clock: starts at `start`, moves only when told to. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string | number) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(to: Date | string | number): void {
    this.t = new Date(to).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function floorMinute(ms: number): number {
  return ms - (ms % 60_000);
}
