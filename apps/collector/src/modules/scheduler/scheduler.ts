import type { Storage } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';

export interface Job {
  name: string;
  run(now: Date): Promise<void>;
}

export interface TickResult {
  leader: boolean;
  ran: string[];
  failed: { job: string; error: string }[];
}

const LEADER_LOCK = 'theirside:scheduler';

/**
 * Runs every job once per tick (default every minute) on exactly one replica:
 * each tick takes a Postgres advisory lock and skips if another replica holds it.
 * A failing job is logged and does not stop the others.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private alignTimer: NodeJS.Timeout | undefined;
  private running: Promise<TickResult> | undefined;

  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
    private readonly jobs: Job[],
    private readonly log: { info(o: object, m: string): void; error(o: object, m: string): void },
    private readonly intervalMs = 60_000,
  ) {}

  /**
   * Run one tick now (partitions, catch-up), then tick every interval. With a
   * one-minute interval, ticks are aligned to `alignOffsetMs` past each minute
   * so the minute being evaluated has received its late SDK flushes.
   */
  start(alignOffsetMs = 5000): void {
    const loop = () => {
      void this.tick().catch(() => {});
    };
    loop();
    const startInterval = () => {
      this.timer = setInterval(loop, this.intervalMs);
      this.timer.unref();
    };
    if (this.intervalMs === 60_000) {
      const now = Date.now();
      const wait = (60_000 - (now % 60_000) + alignOffsetMs) % 60_000;
      this.alignTimer = setTimeout(() => {
        loop();
        startInterval();
      }, wait);
      this.alignTimer.unref();
    } else {
      startInterval();
    }
  }

  async stop(): Promise<void> {
    if (this.alignTimer) clearTimeout(this.alignTimer);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  /** One tick; concurrent calls share it. Exposed for tests with a fake clock. */
  tick(): Promise<TickResult> {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnce(): Promise<TickResult> {
    const now = this.clock.now();
    const result: TickResult = { leader: false, ran: [], failed: [] };
    const got = await this.storage.withLeaderLock(LEADER_LOCK, async () => {
      result.leader = true;
      for (const job of this.jobs) {
        try {
          await job.run(now);
          result.ran.push(job.name);
        } catch (err) {
          result.failed.push({ job: job.name, error: (err as Error).message });
          this.log.error({ job: job.name, err }, 'scheduler job failed');
        }
      }
      return true;
    });
    if (got === null) result.leader = false;
    return result;
  }
}
