import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const locationPointSchema = new Schema(
  {
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', default: null },
    location: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    },
    speedKph: { type: Number, required: true, min: 0, max: 400 },
    heading: { type: Number, required: true, min: 0, max: 360 },
    accuracyMeters: { type: Number, required: true, min: 0, max: 100000 },
    recordedAt: { type: Date, required: true, index: true },
    receivedAt: { type: Date, required: true },
    source: { type: String, enum: ['vehicle_gps', 'mobile_gps', 'demo_gps'], required: true },
    demo: { type: Boolean, default: false, index: true },
    sequence: { type: Number, required: true, min: 0 },
    eventId: { type: String, required: true, maxlength: 120 },
  },
  { timestamps: false },
);

locationPointSchema.index({ location: '2dsphere' });
locationPointSchema.index({ tripId: 1, recordedAt: -1, _id: -1 });
locationPointSchema.index({ vehicleId: 1, recordedAt: -1 });
locationPointSchema.index(
  { deviceId: 1, sequence: 1 },
  { unique: true, partialFilterExpression: { deviceId: { $type: 'objectId' } } },
);
locationPointSchema.index({ eventId: 1 }, { unique: true });

export type LocationPointDocument = HydratedDocument<InferSchemaType<typeof locationPointSchema>>;
export const LocationPointModel = model('LocationPoint', locationPointSchema);
