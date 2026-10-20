import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const notificationSchema = new Schema(
  {
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    eventId: { type: String, required: true },
    incidentId: { type: Schema.Types.ObjectId, ref: 'Incident', default: null },
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', default: null },
    channel: { type: String, enum: ['push', 'in_app'], required: true },
    status: {
      type: String,
      enum: ['queued', 'simulated', 'unavailable', 'provider_accepted', 'provider_rejected', 'retry_scheduled', 'failed'],
      default: 'queued',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: () => new Date(), index: true },
    lastError: { type: String, default: '', maxlength: 400 },
    providerTicketId: { type: String, default: '' },
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, required: true, maxlength: 500 },
    dedupKey: { type: String, required: true, unique: true },
    demo: { type: Boolean, default: false },
    deepLink: { type: String, required: true, maxlength: 300 },
  },
  { timestamps: true },
);

notificationSchema.index({ status: 1, nextAttemptAt: 1 });

const pushTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token: { type: String, required: true, select: false },
    tokenHash: { type: String, required: true, unique: true },
    platform: { type: String, enum: ['ios', 'android', 'unknown'], default: 'unknown' },
    disabledAt: { type: Date, default: null },
    lastError: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true },
);

const deviceCommandSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    commandId: { type: String, required: true, unique: true },
    type: { type: String, enum: ['request_status', 'display_text', 'set_brightness', 'acknowledge_alarm'], required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['queued', 'published', 'failed'], default: 'queued' },
    demo: { type: Boolean, default: false },
    lastError: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true },
);

export type NotificationDocument = HydratedDocument<InferSchemaType<typeof notificationSchema>>;
export type PushTokenDocument = HydratedDocument<InferSchemaType<typeof pushTokenSchema>>;
export type DeviceCommandDocument = HydratedDocument<InferSchemaType<typeof deviceCommandSchema>>;
export const NotificationModel = model('Notification', notificationSchema);
export const PushTokenModel = model('PushToken', pushTokenSchema);
export const DeviceCommandModel = model('DeviceCommand', deviceCommandSchema);
