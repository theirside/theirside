import type { Incident, ProviderRecord, Storage, Tenant } from '../../storage/types.js';
import { isOutbound } from '../../storage/types.js';
import { floorMinute } from '../../util/clock.js';
import type { AlertDispatcher } from '../alerts/dispatcher.js';
import { refreshBaselines } from '../scoring/baseline.js';
import type { IncidentKind } from '../scoring/evaluate.js';
import {
  expectedKey,
  expectedLookup,
  isExpectable,
  type ExpectableStatus,
} from '../scoring/expected.js';
import { resolveThresholds, thresholdsFor } from '../scoring/thresholds.js';
import { buildPayload } from './job.js';

/** The incident kinds a marked status explains: its own 4xx group, or a behaviour change. */
const KINDS_OF: Record<ExpectableStatus, IncidentKind[]> = {
  400: ['validation', 'behaviour'],
  409: ['validation', 'behaviour'],
  422: ['validation', 'behaviour'],
  401: ['auth', 'behaviour'],
  403: ['auth', 'behaviour'],
  404: ['not_found', 'behaviour'],
};

export interface MarkExpectedInput {
  provider: ProviderRecord;
  method: string;
  endpoint: string;
  status: number;
  /** true: mark expected; false: unmark. */
  expected: boolean;
  /** Who did it, for the incident note ("by ana@example.test"). */
  by: string | null;
}

export interface MarkExpectedResult {
  provider: ProviderRecord;
  /** Statuses now marked expected for this endpoint. */
  statuses: number[];
  /** Open incidents this endpoint was resolved in (whole incident or this endpoint). */
  resolvedIncidents: string[];
}

export class ExpectedStatusError extends Error {}

/**
 * Mark (or unmark) a status as expected for one endpoint from the dashboard
 * (docs/scoring.md "Expected outcomes"): stores it on the provider, recomputes the
 * endpoint's baselines without (or with) those calls at once, and resolves an open
 * incident it explains with a note: the endpoint is taken out of the incident, and
 * an incident left without endpoints is resolved (resolve alert unless muted).
 */
export async function markExpected(
  storage: Storage,
  dispatcher: AlertDispatcher,
  tenant: Tenant,
  now: Date,
  publicUrl: string | undefined,
  input: MarkExpectedInput,
): Promise<MarkExpectedResult> {
  const { provider, method, endpoint, status } = input;
  if (!isExpectable(status))
    throw new ExpectedStatusError(
      status >= 500 || status < 400
        ? 'only 4xx answers can be expected: 5xx, timeouts and connection errors never are'
        : status === 429
          ? '429 means the provider is limiting your calls; it can’t be marked expected'
          : `only ${[400, 401, 403, 404, 409, 422].join(', ')} can be marked from the dashboard; mark other statuses in code (markExpected)`,
    );
  const key = expectedKey({ method, endpoint });
  const current = provider.expectedStatuses ?? {};
  const set = new Set((current[key] ?? []).filter(isExpectable));
  if (input.expected) set.add(status);
  else set.delete(status);
  const statuses = [...set].sort((a, b) => a - b);
  const next = { ...current };
  if (statuses.length > 0) next[key] = statuses;
  else delete next[key];
  const updated =
    (await storage.config.updateProvider(tenant, provider.id, { expectedStatuses: next })) ??
    provider;

  // baselines without (or with) those calls now, so detection is right at once
  const projectT = resolveThresholds(await storage.config.getThresholds(tenant));
  const t = thresholdsFor(projectT, updated.thresholds);
  const keys = (await storage.rollups.listKeys(tenant, { provider: updated.name })).filter(
    (k) => k.method === method && k.endpoint === endpoint,
  );
  if (keys.length > 0)
    await refreshBaselines(storage, tenant, keys, now, t, () => t, expectedLookup([updated]));

  const resolvedIncidents: string[] = [];
  if (input.expected) {
    const T = new Date(floorMinute(now.getTime()));
    const open = (await storage.incidents.list(tenant, { status: 'open', provider: updated.name }))
      .filter(isOutbound)
      .filter(
        (i) =>
          KINDS_OF[status].includes(i.kind) &&
          i.endpoints.some((e) => !e.recoveredAt && e.method === method && e.endpoint === endpoint),
      );
    for (const inc of open) {
      const note = `${status} marked as an expected answer for ${method} ${endpoint}${input.by ? ` by ${input.by}` : ''} at ${T.toISOString().slice(11, 16)} UTC.`;
      const next: Incident = {
        ...inc,
        endpoints: inc.endpoints.map((e) =>
          e.method === method && e.endpoint === endpoint && !e.recoveredAt
            ? { ...e, recoveredAt: T }
            : { ...e },
        ),
      };
      const stillActive = next.endpoints.some((e) => !e.recoveredAt);
      if (!stillActive) {
        next.status = 'resolved';
        next.resolvedAt = T;
        next.resolutionNote = `Resolved: ${note}`;
        next.summary = `${inc.summary}\nResolved: ${note}`;
      } else {
        next.summary = `${inc.summary}\n${note}`;
      }
      await storage.transaction(async (tx) => {
        await tx.incidents.update(next);
        if (!stillActive && !inc.alertsMuted)
          await dispatcher.enqueue(
            tenant,
            buildPayload('resolve', next, [], publicUrl, now, updated),
            { tx },
          );
      });
      resolvedIncidents.push(inc.id);
    }
  }
  return { provider: updated, statuses, resolvedIncidents };
}
