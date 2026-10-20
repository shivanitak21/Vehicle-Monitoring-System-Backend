import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/http/async-handler';
import { authenticate } from '../../common/middleware/authenticate';
import { registerPushToken } from '../notifications/notification.service';
import { ingestLocation } from '../locations/location.service';
import { authenticateDevice, assertDeviceVehicle } from '../vehicles/vehicle.service';
import { telemetrySchema } from '../../mqtt/schemas';

export const deviceIngestRouter = Router();

deviceIngestRouter.post('/telemetry', asyncHandler(async (req, res) => {
  const identity = req.header('x-device-identity');
  const key = req.header('x-device-key');
  if (!identity || !key) {
    res.status(401).json({ code: 'DEVICE_UNAUTHORIZED', message: 'Device authentication failed', requestId: req.id });
    return;
  }
  const device = await authenticateDevice(identity, key);
  const body = telemetrySchema.omit({ authToken: true, deviceIdentity: true }).parse(req.body);
  await assertDeviceVehicle(device, body.vehicleId);
  const result = await ingestLocation({
    vehicleId: body.vehicleId,
    tripId: body.tripId,
    device,
    latitude: body.latitude,
    longitude: body.longitude,
    speedKph: body.speedKph,
    heading: body.heading,
    accuracyMeters: body.accuracyMeters,
    recordedAt: new Date(body.recordedAt),
    source: body.source,
    demo: body.demo,
    sequence: body.sequence,
    eventId: body.eventId,
  });
  res.status(result.duplicate ? 200 : 201).json({
    duplicate: result.duplicate,
    eventId: body.eventId,
    tripId: result.trip.id,
    demo: body.demo,
    source: body.source,
  });
}));

deviceIngestRouter.post('/push-token', authenticate, asyncHandler(async (req, res) => {
  const body = z.object({
    token: z.string().min(10).max(300),
    platform: z.enum(['ios', 'android', 'unknown']).default('unknown'),
  }).parse(req.body);
  res.status(201).json(await registerPushToken(req.user!.id, body.token, body.platform));
}));
