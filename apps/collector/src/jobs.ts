import type { CollectorConfig } from './config.js';
import type { AppContext } from './context.js';
import {
  discoveryDigestJob,
  endpointMergeJob,
  templateMergeJob,
} from './modules/discovery/jobs.js';
import { catalogRegroupJob } from './modules/discovery/regroup.js';
import { alertJob, incidentJob } from './modules/incidents/job.js';
import { inboundJob } from './modules/incidents/inbound.js';
import { partitionJob, rollupRetentionJob } from './modules/scheduler/maintenance.js';
import type { Job } from './modules/scheduler/scheduler.js';

/** Every scheduler job, in the order they run each minute (normal and simulation mode). */
export function schedulerJobs(
  ctx: AppContext,
  config: CollectorConfig,
  info: (m: string) => void,
): Job[] {
  const storage = ctx.storage;
  return [
    partitionJob(
      storage,
      { ahead: config.partitionsAhead, rawRetentionDays: config.rawRetentionDays },
      info,
    ),
    incidentJob(storage, ctx.alerts, { publicUrl: config.publicUrl, log: info }),
    inboundJob(storage, ctx.alerts, { publicUrl: config.publicUrl, log: info }),
    alertJob(ctx.alerts),
    discoveryDigestJob(storage, ctx.alerts, { publicUrl: config.publicUrl, log: info }),
    catalogRegroupJob(storage, ctx.directory.catalog, info),
    templateMergeJob(storage, info),
    endpointMergeJob(storage, ctx.directory.catalog.entries, info),
    rollupRetentionJob(storage, ctx.entitlements, {
      rollupRetentionDays: config.rollupRetentionDays,
    }),
  ];
}
