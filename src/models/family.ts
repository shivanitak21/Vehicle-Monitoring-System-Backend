import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const familyGroupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    memberIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);

const permissionsSchema = new Schema(
  {
    viewLocation: { type: Boolean, default: true },
    viewTrips: { type: Boolean, default: true },
    viewIncidents: { type: Boolean, default: true },
    viewMedia: { type: Boolean, default: false },
    receiveAlerts: { type: Boolean, default: true },
  },
  { _id: false },
);

const familyRelationshipSchema = new Schema(
  {
    familyGroupId: { type: Schema.Types.ObjectId, ref: 'FamilyGroup', required: true, index: true },
    guardianId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    passengerId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    inviteEmail: { type: String, lowercase: true, trim: true, maxlength: 254, default: '' },
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 32, default: '' },
    relationship: { type: String, required: true, trim: true, maxlength: 80 },
    memberRole: { type: String, enum: ['guardian', 'passenger', 'driver'], required: true },
    permissions: { type: permissionsSchema, default: () => ({}) },
    consentStatus: { type: String, enum: ['pending', 'granted', 'revoked'], default: 'pending', index: true },
    sharingLocation: { type: Boolean, default: false },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

familyRelationshipSchema.index({ guardianId: 1, passengerId: 1 });

const emergencyContactSchema = new Schema(
  {
    familyGroupId: { type: Schema.Types.ObjectId, ref: 'FamilyGroup', required: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    relationship: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
  },
  { timestamps: true },
);

export type FamilyGroupDocument = HydratedDocument<InferSchemaType<typeof familyGroupSchema>>;
export type FamilyRelationshipDocument = HydratedDocument<InferSchemaType<typeof familyRelationshipSchema>>;
export type EmergencyContactDocument = HydratedDocument<InferSchemaType<typeof emergencyContactSchema>>;

export const FamilyGroupModel = model('FamilyGroup', familyGroupSchema);
export const FamilyRelationshipModel = model('FamilyRelationship', familyRelationshipSchema);
export const EmergencyContactModel = model('EmergencyContact', emergencyContactSchema);
