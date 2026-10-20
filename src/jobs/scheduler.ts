import { getConfig } from '../config/env';
import { logger } from '../config/logger';
import { LocationPointModel } from '../models/location';
import { MediaAssetModel } from '../models/incident';
import { DeviceModel } from '../models/vehicle';
import { TripModel } from '../models/trip';
import { deleteObject } from '../integrations/storage/storage-provider';
import { loadVehicle, recordSafetyEvent } from '../modules/safety/safety.service';
import { processNotificationQueue } from '../modules/notifications/notification.service';

let timers: NodeJS.Timeout[] = [];

export function startJobs(): void {
  stopJobs();
  timers = [
    setInterval(() => void runSafe('notifications', () => processNotificationQueue()), 5000),
    setInterval(() => void runSafe('retention', retention), 60 * 60 * 1000),
    setInterval(() => void runSafe('staleness', staleness), 30_000),
  ];
  for (const timer of timers) timer.unref?.();
}

export function stopJobs(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
}

async function runSafe(name: string, job: () => Promise<unknown>): Promise<void> {
  try {
    await job();
  } catch (error) {
    logger.error({ err: error, job: name }, 'background job failed');
  }
}

async function retention(): Promise<void> {
  const config = getConfig();
  const locationCutoff = new Date(Date.now() - config.location.retentionDays * 24 * 60 * 60 * 1000);
  await LocationPointModel.deleteMany({ recordedAt: { $lt: locationCutoff } });
  const expired = await MediaAssetModel.find({ retentionExpiresAt: { $lt: new Date() }, uploadState: { $nin: ['deleted', 'expired'] } }).limit(50);
  for (const media of expired) {
    await deleteObject(media.storageKey).catch((error) => logger.error({ err: error, mediaId: media.id }, 'media delete failed'));
    media.uploadState = 'expired';
    await media.save();
  }
}

async function staleness(): Promise<void> {
  const config = getConfig();
  const now = Date.now();
  const trips = await TripModel.find({ status: 'active' });
  for (const trip of trips) {
    const locationAge = trip.lastLocationAt ? (now - trip.lastLocationAt.getTime()) / 1000 : null;
    if (locationAge !== null && locationAge > config.location.staleAfterSeconds && !trip.staleAlertActive) {
      await recordSafetyEvent({
        eventId: `gps-stale:${trip.id}:${trip.lastLocationAt?.toISOString() ?? 'none'}`,
        eventType: 'gps_stale',
        severity: 'warning',
        source: 'system',
        demo: trip.demo,
        occurredAt: new Date(),
        trip,
        vehicle: await loadVehicle(trip.vehicleId.toString()),
        payload: { ageSeconds: Math.round(locationAge) },
      });
      trip.staleAlertActive = true;
      await trip.save();
    }
    const device = await DeviceModel.findOne({ vehicleId: trip.vehicleId, status: 'active' }).sort({ lastHeartbeatAt: -1 });
    const heartbeatAge = device?.lastHeartbeatAt ? (now - device.lastHeartbeatAt.getTime()) / 1000 : null;
    if (device && heartbeatAge !== null && heartbeatAge > config.location.deviceOfflineAfterSeconds && !trip.offlineAlertActive) {
      await recordSafetyEvent({
        eventId: `device-offline:${device.id}:${device.lastHeartbeatAt?.toISOString() ?? 'none'}`,
        eventType: 'device_offline',
        severity: 'warning',
        source: 'system',
        demo: trip.demo,
        occurredAt: new Date(),
        trip,
        vehicle: await loadVehicle(trip.vehicleId.toString()),
        payload: { ageSeconds: Math.round(heartbeatAge) },
      });
      trip.offlineAlertActive = true;
      await trip.save();
    }
  }
}
