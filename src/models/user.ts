import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const privacySchema = new Schema(
  {
    shareWithGuardians: { type: Boolean, default: true },
    foregroundSharing: { type: Boolean, default: true },
    backgroundSharing: { type: Boolean, default: false },
    cameraEvidence: { type: Boolean, default: false },
    speechMonitoring: { type: Boolean, default: false },
  },
  { _id: false },
);

const notificationPrefsSchema = new Schema(
  {
    tripStart: { type: Boolean, default: true },
    arrival: { type: Boolean, default: true },
    speeding: { type: Boolean, default: true },
    fatigue: { type: Boolean, default: true },
    sos: { type: Boolean, default: true },
    pushEnabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 32, default: '' },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['guardian', 'passenger', 'administrator'], required: true },
    accountStatus: { type: String, enum: ['active', 'suspended', 'invited'], default: 'active' },
    familyGroupId: { type: Schema.Types.ObjectId, ref: 'FamilyGroup', default: null, index: true },
    privacy: { type: privacySchema, default: () => ({}) },
    notificationPrefs: { type: notificationPrefsSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export type UserRole = 'guardian' | 'passenger' | 'administrator';
export type UserSchema = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<UserSchema>;
export const UserModel = model('User', userSchema);
