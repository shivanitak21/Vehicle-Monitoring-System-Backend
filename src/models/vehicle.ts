import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const statusEnum = ['running', 'idle', 'unavailable', 'unknown'] as const;

const vehicleSchema = new Schema(
  {
    familyGroupId: { type: Schema.Types.ObjectId, ref: 'FamilyGroup', required: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    registrationIdentifier: { type: String, required: true, trim: true, uppercase: true, maxlength: 32 },
    assignedDriverId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['active', 'inactive', 'maintenance'], default: 'active', index: true },
    demo: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

vehicleSchema.index({ familyGroupId: 1, registrationIdentifier: 1 }, { unique: true });

const deviceSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    familyGroupId: { type: Schema.Types.ObjectId, ref: 'FamilyGroup', required: true, index: true },
    deviceType: {
      type: String,
      enum: ['vehicle_unit', 'driver_camera', 'cabin_camera', 'display', 'combined'],
      required: true,
    },
    deviceIdentity: { type: String, required: true, unique: true, trim: true, maxlength: 120 },
    ingestKeyHash: { type: String, required: true, select: false },
    mqttUsername: { type: String, required: true, trim: true, maxlength: 120 },
    firmwareVersion: { type: String, default: '', maxlength: 64 },
    lastHeartbeatAt: { type: Date, default: null },
    cameraConnected: { type: Boolean, default: null },
    driverModelStatus: { type: String, enum: statusEnum, default: 'unknown' },
    cabinModelStatus: { type: String, enum: statusEnum, default: 'unknown' },
    displayStatus: { type: String, enum: ['online', 'offline', 'unknown'], default: 'unknown' },
    mqttConnected: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    demo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type VehicleDocument = HydratedDocument<InferSchemaType<typeof vehicleSchema>>;
export type DeviceDocument = HydratedDocument<InferSchemaType<typeof deviceSchema>>;
export const VehicleModel = model('Vehicle', vehicleSchema);
export const DeviceModel = model('Device', deviceSchema);
