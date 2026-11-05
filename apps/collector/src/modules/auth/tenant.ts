import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import type { Tenant } from '../../storage/types.js';

/**
 * Tenant for an admin request: the principal's org and `?project=` (default:
 * the org's first project). Returns null after sending 404 for a foreign project.
 */
export async function adminTenant(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<Tenant | null> {
  const p = req.principal!;
  const projects = await ctx.storage.config.listProjects(p.orgId);
  const wanted = (req.query as { project?: string } | undefined)?.project;
  const project = wanted ? projects.find((x) => x.id === wanted) : projects[0];
  if (!project) {
    await reply.code(404).send({ error: 'project not found' });
    return null;
  }
  return { orgId: p.orgId, projectId: project.id };
}

/** Admin-only mutations: owners and admins. */
export function canWrite(req: FastifyRequest): boolean {
  const role = req.principal?.role;
  return role === 'owner' || role === 'admin';
}
