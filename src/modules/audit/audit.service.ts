import { AuditLogModel } from '../../models/audit';

export async function writeAudit(input: {
  actorId?: string | null;
  actorRole?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  decision: 'allow' | 'deny';
  requestId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await AuditLogModel.create({
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? '',
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    decision: input.decision,
    requestId: input.requestId ?? '',
    metadata: input.metadata ?? {},
  });
}
