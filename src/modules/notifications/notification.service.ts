import { getConfig } from '../../config/env';
import { logger } from '../../config/logger';
import { isDuplicateKey } from '../../common/errors/app-error';
import { deliverPush } from '../../integrations/push/push-provider';
import { NotificationModel, PushTokenModel, type NotificationDocument } from '../../models/notification';
import { UserModel } from '../../models/user';
import { publishToUsers } from '../../realtime/publisher';
import type { SafetyEventType } from '../../config/risk-rules';

const PREF_KEYS: Partial<Record<SafetyEventType, 'speeding' | 'fatigue' | 'sos'>> = {
  speeding: 'speeding',
  driver_fatigue: 'fatigue',
  face_not_detected: 'fatigue',
  sos: 'sos',
};

export async function enqueueAlerts(input: {
  recipientIds: string[];
  eventId: string;
  eventType: SafetyEventType;
  incidentId?: string | null;
  tripId?: string | null;
  passengerName: string;
  vehicleLabel: string;
  locationUnavailable: boolean;
  demo: boolean;
}): Promise<void> {
  const title = titleFor(input.eventType);
  const body = bodyFor(input);
  const deepLink = input.incidentId
    ? `vehiclesafety://incidents/${input.incidentId}`
    : `vehiclesafety://trips/${input.tripId ?? ''}`;
  for (const recipientId of new Set(input.recipientIds)) {
    const user = await UserModel.findById(recipientId);
    if (!user) continue;
    const prefKey = PREF_KEYS[input.eventType];
    if (input.eventType !== 'sos' && prefKey && user.notificationPrefs[prefKey] === false) continue;
    await createNotification({
      recipientId,
      eventId: input.eventId,
      incidentId: input.incidentId,
      tripId: input.tripId,
      channel: 'in_app',
      title,
      body,
      deepLink,
      demo: input.demo,
      initialStatus: 'provider_accepted',
    });
    const pushWanted = input.eventType === 'sos' || user.notificationPrefs.pushEnabled !== false;
    if (!pushWanted) continue;
    await createNotification({
      recipientId,
      eventId: input.eventId,
      incidentId: input.incidentId,
      tripId: input.tripId,
      channel: 'push',
      title,
      body,
      deepLink,
      demo: input.demo,
      initialStatus: 'queued',
    });
    publishToUsers([recipientId], 'notification:created', {
      eventId: input.eventId,
      incidentId: input.incidentId ?? null,
      tripId: input.tripId ?? null,
      title,
      body,
      demo: input.demo,
      deepLink,
    });
  }
}

async function createNotification(input: {
  recipientId: string;
  eventId: string;
  incidentId?: string | null;
  tripId?: string | null;
  channel: 'push' | 'in_app';
  title: string;
  body: string;
  deepLink: string;
  demo: boolean;
  initialStatus: 'queued' | 'provider_accepted';
}): Promise<void> {
  try {
    await NotificationModel.create({
      recipientId: input.recipientId,
      eventId: input.eventId,
      incidentId: input.incidentId ?? null,
      tripId: input.tripId ?? null,
      channel: input.channel,
      status: input.initialStatus,
      title: input.title,
      body: input.body,
      dedupKey: `${input.recipientId}:${input.eventId}:${input.channel}`,
      demo: input.demo,
      deepLink: input.deepLink,
      nextAttemptAt: new Date(),
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}

export async function processNotificationQueue(limit = 25): Promise<number> {
  const due = await NotificationModel.find({
    channel: 'push',
    status: { $in: ['queued', 'retry_scheduled'] },
    nextAttemptAt: { $lte: new Date() },
  }).sort({ nextAttemptAt: 1 }).limit(limit);
  let processed = 0;
  for (const notification of due) {
    await attempt(notification);
    processed += 1;
  }
  return processed;
}

async function attempt(notification: NotificationDocument): Promise<void> {
  const token = await PushTokenModel.findOne({ userId: notification.recipientId, disabledAt: null }).select('+token');
  notification.attempts += 1;
  if (!token) {
    notification.status = 'unavailable';
    notification.lastError = 'No active push token is registered for this guardian';
    await notification.save();
    return;
  }
  try {
    const result = await deliverPush({ notification, token: token.token });
    notification.status = result.status === 'provider_rejected' && notification.attempts < notification.maxAttempts && !result.invalidToken
      ? 'retry_scheduled'
      : result.status;
    notification.providerTicketId = result.ticketId ?? '';
    notification.lastError = result.error ?? '';
    if (result.invalidToken) {
      token.disabledAt = new Date();
      token.lastError = 'DeviceNotRegistered';
      await token.save();
      notification.status = 'failed';
    }
    if (notification.status === 'retry_scheduled') {
      notification.nextAttemptAt = new Date(Date.now() + backoff(notification.attempts));
    }
  } catch (error) {
    logger.error({ err: error, notificationId: notification.id }, 'push delivery failed');
    notification.lastError = 'Push provider request failed';
    if (notification.attempts >= notification.maxAttempts) notification.status = 'failed';
    else {
      notification.status = 'retry_scheduled';
      notification.nextAttemptAt = new Date(Date.now() + backoff(notification.attempts));
    }
  }
  await notification.save();
}

function backoff(attempt: number): number {
  return Math.min(15 * 60 * 1000, 2000 * 2 ** attempt);
}

export async function listNotifications(userId: string) {
  const items = await NotificationModel.find({ recipientId: userId }).sort({ createdAt: -1 }).limit(100);
  return items.map((item) => ({
    id: item.id,
    eventId: item.eventId,
    incidentId: item.incidentId?.toString() ?? null,
    tripId: item.tripId?.toString() ?? null,
    channel: item.channel,
    status: item.status,
    attempts: item.attempts,
    title: item.title,
    body: item.body,
    deepLink: item.deepLink,
    demo: item.demo,
    createdAt: item.createdAt,
    providerAccepted: item.status === 'provider_accepted',
    delivered: false,
  }));
}

export async function registerPushToken(userId: string, token: string, platform: 'ios' | 'android' | 'unknown') {
  const { sha256 } = await import('../../common/utils/crypto');
  const tokenHash = sha256(token);
  const existing = await PushTokenModel.findOne({ tokenHash }).select('+token');
  if (existing) {
    existing.userId = userId as unknown as typeof existing.userId;
    existing.platform = platform;
    existing.disabledAt = null;
    existing.lastError = '';
    await existing.save();
    return { registered: true };
  }
  await PushTokenModel.create({ userId, token, tokenHash, platform });
  return { registered: true };
}

function titleFor(eventType: SafetyEventType): string {
  const labels: Record<SafetyEventType, string> = {
    sos: 'SOS alert',
    driver_fatigue: 'Driver fatigue signal',
    driver_distraction: 'Driver distraction signal',
    speeding: 'Speeding signal',
    harsh_braking: 'Harsh braking signal',
    route_deviation: 'Route deviation signal',
    seat_occupancy_change: 'Seat occupancy change',
    abusive_language: 'Speech safety signal',
    face_not_detected: 'Driver face not detected',
    camera_offline: 'Camera offline',
    device_offline: 'Vehicle device offline',
    gps_stale: 'Location data is stale',
  };
  return labels[eventType];
}

function bodyFor(input: { eventType: SafetyEventType; passengerName: string; vehicleLabel: string; locationUnavailable: boolean }): string {
  const where = input.locationUnavailable ? 'Location is unavailable.' : 'A location was included with the event.';
  if (input.eventType === 'sos') {
    return `SOS from ${input.passengerName} in ${input.vehicleLabel}. ${where} This does not contact emergency services.`;
  }
  return `${titleFor(input.eventType)} for ${input.passengerName} in ${input.vehicleLabel}. ${where}`;
}

export function pushConfigured(): boolean {
  return getConfig().push.configured;
}
