import { getConfig } from '../../config/env';
import { logger } from '../../config/logger';
import type { NotificationDocument } from '../../models/notification';

export type PushDelivery = {
  status: 'simulated' | 'unavailable' | 'provider_accepted' | 'provider_rejected';
  ticketId?: string;
  error?: string;
  invalidToken?: boolean;
};

export async function deliverPush(input: {
  notification: NotificationDocument;
  token: string;
}): Promise<PushDelivery> {
  const config = getConfig();
  if (!config.push.configured) {
    if (config.isDevelopment) {
      logger.info(
        {
          simulated: true,
          notificationId: input.notification.id,
          recipientId: input.notification.recipientId.toString(),
          eventId: input.notification.eventId,
          channel: 'development-logger',
        },
        'simulated push notification',
      );
      return { status: 'simulated' };
    }
    return { status: 'unavailable', error: 'Expo push access token is not configured' };
  }

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.push.expoAccessToken}`,
    },
    body: JSON.stringify({
      to: input.token,
      title: input.notification.title,
      body: input.notification.body,
      data: {
        tripId: input.notification.tripId?.toString() ?? null,
        incidentId: input.notification.incidentId?.toString() ?? null,
        eventId: input.notification.eventId,
        url: input.notification.deepLink,
      },
      priority: 'high',
    }),
  });
  const json = (await response.json().catch(() => null)) as { data?: { status?: string; id?: string; message?: string; details?: { error?: string } } } | null;
  const ticket = json?.data;
  if (!response.ok || ticket?.status === 'error') {
    const invalidToken = ticket?.details?.error === 'DeviceNotRegistered';
    return {
      status: 'provider_rejected',
      error: ticket?.message || `Expo push request failed with HTTP ${response.status}`,
      invalidToken,
    };
  }
  return { status: 'provider_accepted', ticketId: ticket?.id };
}
