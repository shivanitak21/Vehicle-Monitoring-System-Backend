import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const placeSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 200 },
    latitude: { type: Number, min: -90, max: 90, default: null },
    longitude: { type: Number, min: -180, max: 180, default: null },
  },
  { _id: false },
);

const tripSchema = new Schema(
  {
    familyGroupId: { type: Schema.Types.ObjectId, ref: 'FamilyGroup', required: true, index: true },
    passengerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    authorizedGuardianIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    origin: { type: placeSchema, required: true },
    destination: { type: placeSchema, required: true },
    status: {
      type: String,
      enum: ['scheduled', 'active', 'completed', 'cancelled', 'interrupted'],
      default: 'scheduled',
      index: true,
    },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    sharing: {
      shareLocation: { type: Boolean, default: true },
      shareMedia: { type: Boolean, default: false },
    },
    demo: { type: Boolean, default: false, index: true },
    source: { type: String, enum: ['user', 'demo', 'system'], default: 'user' },
    relationshipLabel: { type: String, default: '', maxlength: 80 },
    lastLocationAt: { type: Date, default: null },
    lastLocationSource: { type: String, default: null },
    lastSpeedKph: { type: Number, default: null },
    lastHeading: { type: Number, default: null },
    lastAccuracyMeters: { type: Number, default: null },
    lastLatitude: { type: Number, default: null },
    lastLongitude: { type: Number, default: null },
    staleAlertActive: { type: Boolean, default: false },
    offlineAlertActive: { type: Boolean, default: false },
  },
  { timestamps: true },
);

tripSchema.index({ passengerId: 1, status: 1 });
tripSchema.index({ vehicleId: 1, status: 1 });
tripSchema.index({ familyGroupId: 1, status: 1, updatedAt: -1 });

export type TripStatus = 'scheduled' | 'active' | 'completed' | 'cancelled' | 'interrupted';
export type TripDocument = HydratedDocument<InferSchemaType<typeof tripSchema>>;
export const TripModel = model('Trip', tripSchema);
