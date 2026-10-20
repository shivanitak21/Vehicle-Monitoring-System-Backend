import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { EVENT_TYPES } from '../config/risk-rules';

const safetyEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, maxlength: 120 },
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', default: null, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null, index: true },
    passengerId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    familyGroupId: { type: Schema.Types.ObjectId, ref: 'FamilyGroup', required: true, index: true },
    eventType: { type: String, enum: EVENT_TYPES, required: true, index: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], required: true },
    source: { type: String, required: true, maxlength: 80 },
    demo: { type: Boolean, default: false, index: true },
    occurredAt: { type: Date, required: true, index: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    inferenceSource: { type: String, default: '', maxlength: 120 },
    modelName: { type: String, default: '', maxlength: 120 },
    modelVersion: { type: String, default: '', maxlength: 64 },
    modelConfidence: { type: Number, min: 0, max: 1, default: null },
    locationUnavailable: { type: Boolean, default: false },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    acknowledgement: {
      acknowledged: { type: Boolean, default: false },
      acknowledgedAt: { type: Date, default: null },
      acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },
    review: {
      status: { type: String, enum: ['pending', 'confirmed', 'rejected', 'corrected'], default: 'pending' },
      note: { type: String, default: '', maxlength: 1000 },
      reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      reviewedAt: { type: Date, default: null },
    },
    processingStatus: { type: String, enum: ['received', 'processed', 'failed'], default: 'received' },
    notificationsEnqueued: { type: Boolean, default: false },
  },
  { timestamps: true },
);

safetyEventSchema.index({ tripId: 1, occurredAt: -1 });
safetyEventSchema.index({ familyGroupId: 1, occurredAt: -1 });

const cabinSnapshotSchema = new Schema(
  {
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', default: null, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    eventId: { type: String, required: true, unique: true },
    recordedAt: { type: Date, required: true },
    totalSeats: { type: Number, required: true, min: 0, max: 20 },
    occupiedSeats: { type: Number, required: true, min: 0, max: 20 },
    seats: { type: Schema.Types.Mixed, default: [] },
    inferenceSource: { type: String, required: true },
    confidence: { type: Number, min: 0, max: 1, default: null },
    cameraAvailable: { type: Boolean, required: true },
    modelAvailable: { type: Boolean, required: true },
    demo: { type: Boolean, default: false },
    source: { type: String, required: true },
  },
  { timestamps: true },
);

export type SafetyEventDocument = HydratedDocument<InferSchemaType<typeof safetyEventSchema>>;
export type CabinSnapshotDocument = HydratedDocument<InferSchemaType<typeof cabinSnapshotSchema>>;
export const SafetyEventModel = model('SafetyEvent', safetyEventSchema);
export const CabinSnapshotModel = model('CabinSnapshot', cabinSnapshotSchema);
