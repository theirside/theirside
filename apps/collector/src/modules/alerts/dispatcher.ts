import type { AlertChannelRecord, AlertDelivery, Storage, Tenant } from '../../storage/types.js';
import type { Clock } from '../../util/clock.js';
import { newId } from '../../util/ids.js';
import type { AlertPayload, ChannelAdapter } from './channels.js';

/** Retry schedule after a failed attempt: 30 s, 1 min, 2 min, 4 min, 8 min; then give up. */
export const MAX_ATTEMPTS = 6;
export function retryDelayMs(attempts: number): number {
  return 30_000 * 2 ** Math.max(0, attempts - 1);
}

/**
 * Alerts are queued as `alert_deliveries` rows (one per enabled channel) in the
 * same tick that decides them, then sent by `sendDue`, with retries and
 * backoff. Every attempt is logged on the row.
 */
export class AlertDispatcher {
  constructor(
    private readonly storage: Storage,
    private readonly adapters: Map<AlertChannelRecord['kind'], ChannelAdapter>,
    private readonly clock: Clock,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /**
   * Queue one delivery per enabled channel (or only `onlyChannelId`). Pass `tx`
   * to enqueue inside the transaction that records the incident change.
   */
  async enqueue(
    tenant: Tenant,
    payload: AlertPayload,
    opts: { onlyChannelId?: string; tx?: Storage } = {},
  ): Promise<AlertDelivery[]> {
    const storage = opts.tx ?? this.storage;
    const channels = (await storage.config.listAlertChannels(tenant)).filter((c) =>
      opts.onlyChannelId ? c.id === opts.onlyChannelId : c.enabled,
    );
    const now = this.clock.now();
    const created: AlertDelivery[] = [];
    for (const c of channels) {
      const d: AlertDelivery = {
        id: newId('dlv'),
        ...tenant,
        channelId: c.id,
        incidentId: payload.incidentId,
        event: payload.event,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        payload: payload as unknown as Record<string, unknown>,
        createdAt: now,
        sentAt: null,
      };
      await storage.config.createDelivery(d);
      created.push(d);
    }
    return created;
  }

  /** Attempt one delivery now. Returns the updated row. */
  async attempt(d: AlertDelivery): Promise<AlertDelivery> {
    const tenant = { orgId: d.orgId, projectId: d.projectId };
    const channel = await this.storage.config.getAlertChannel(tenant, d.channelId);
    const next: AlertDelivery = { ...d, attempts: d.attempts + 1 };
    const now = this.clock.now();
    try {
      if (!channel) throw new Error('channel deleted');
      const adapter = this.adapters.get(channel.kind);
      if (!adapter) throw new Error(`no adapter for ${channel.kind}`);
      await adapter.send(channel, d.payload as unknown as AlertPayload, { deliveryId: d.id });
      next.status = 'sent';
      next.sentAt = now;
      next.lastError = null;
    } catch (err) {
      next.lastError = String((err as Error)?.message ?? err).slice(0, 500);
      if (next.attempts >= MAX_ATTEMPTS || !channel) {
        next.status = 'failed';
      } else {
        next.nextAttemptAt = new Date(now.getTime() + retryDelayMs(next.attempts));
      }
      this.log(`alert delivery ${d.id} attempt ${next.attempts} failed: ${next.lastError}`);
    }
    await this.storage.config.updateDelivery(next);
    return next;
  }

  /** Send every delivery that is due. */
  async sendDue(limit = 50): Promise<number> {
    const due = await this.storage.config.dueDeliveries(this.clock.now(), limit);
    for (const d of due) await this.attempt(d);
    return due.length;
  }
}
