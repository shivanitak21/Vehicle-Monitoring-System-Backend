import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorRole: { type: String, default: '' },
    action: { type: String, required: true, maxlength: 80, index: true },
    resourceType: { type: String, required: true, maxlength: 40 },
    resourceId: { type: String, required: true, maxlength: 80, index: true },
    decision: { type: String, enum: ['allow', 'deny'], required: true },
    requestId: { type: String, default: '' },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1 });

export type AuditLogDocument = HydratedDocument<InferSchemaType<typeof auditLogSchema>>;
export const AuditLogModel = model('AuditLog', auditLogSchema);
