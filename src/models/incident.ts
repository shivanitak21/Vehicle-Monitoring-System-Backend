import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { EVENT_TYPES } from '../config/risk-rules';

const incidentSchema = new Schema(
  {
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    passengerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyGroupId: { type: Schema.Types.ObjectId, ref: 'FamilyGroup', required: true, index: true },
    eventIds: [{ type: String }],
    primaryEventId: { type: String, required: true },
    eventType: { type: String, enum: EVENT_TYPES, required: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], required: true },
    description: { type: String, required: true, maxlength: 2000 },
    status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open', index: true },
    location: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },
    locationUnavailable: { type: Boolean, default: false },
    locationLabel: { type: String, default: '', maxlength: 200 },
    authorizedViewerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    demo: { type: Boolean, default: false, index: true },
    source: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

incidentSchema.index({ location: '2dsphere' }, { sparse: true });
incidentSchema.index({ primaryEventId: 1 }, { unique: true });

const mediaAssetSchema = new Schema(
  {
    incidentId: { type: Schema.Types.ObjectId, ref: 'Incident', required: true, index: true },
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    eventId: { type: String, default: '', maxlength: 120 },
    familyGroupId: { type: Schema.Types.ObjectId, ref: 'FamilyGroup', required: true, index: true },
    storageKey: { type: String, required: true },
    mediaType: { type: String, enum: ['photo', 'video'], required: true },
    mimeType: { type: String, required: true, maxlength: 120 },
    sizeBytes: { type: Number, required: true, min: 1 },
    originalFileName: { type: String, default: '', maxlength: 200 },
    capturedAt: { type: Date, required: true },
    durationSeconds: { type: Number, min: 0, default: null },
    uploadState: {
      type: String,
      enum: ['pending', 'uploaded', 'failed', 'expired', 'deleted'],
      default: 'pending',
      index: true,
    },
    consentContext: { type: String, required: true, maxlength: 200 },
    retentionExpiresAt: { type: Date, required: true, index: true },
    demo: { type: Boolean, default: false },
    uploadedAt: { type: Date, default: null },
    modelReview: {
      status: { type: String, enum: ['not_requested', 'unavailable', 'completed', 'failed'], default: 'not_requested' },
      provider: { type: String, default: '', maxlength: 120 },
      summary: { type: String, default: '', maxlength: 2000 },
      modelGenerated: { type: Boolean, default: false },
      completedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

export type IncidentDocument = HydratedDocument<InferSchemaType<typeof incidentSchema>>;
export type MediaAssetDocument = HydratedDocument<InferSchemaType<typeof mediaAssetSchema>>;
export const IncidentModel = model('Incident', incidentSchema);
export const MediaAssetModel = model('MediaAsset', mediaAssetSchema);
