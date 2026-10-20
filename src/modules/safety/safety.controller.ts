import { Router } from 'express';
import { z } from 'zod';
import { EVENT_TYPES } from '../../config/risk-rules';
import { asyncHandler } from '../../common/http/async-handler';
import { authenticate } from '../../common/middleware/authenticate';
import { objectIdSchema, paginationQuerySchema } from '../../common/validation/primitives';
import { TripModel } from '../../models/trip';
import { UserModel } from '../../models/user';
import { assertTripAccess } from '../access/access.service';
import { authenticateDevice, assertDeviceVehicle } from '../vehicles/vehicle.service';
import { loadTripForEvent, loadVehicle, recordSafetyEvent, listEvents, getEvent, acknowledgeEvent, reviewEvent, listIncidents, getIncident, acknowledgeIncident, assessVisibleRisk } from './safety.service';
import { requestUploadUrl, completeUpload, listMedia, accessUrl, deleteMedia, reviewMedia } from '../media/media.service';
import { AppError } from '../../common/errors/app-error';

const eventSchema = z.object({
  eventId: z.string().trim().min(4).max(120),
  eventType: z.enum(EVENT_TYPES),
  severity: z.enum(['info', 'warning', 'critical']),
  occurredAt: z.coerce.date(),
  tripId: objectIdSchema.optional(),
  vehicleId: objectIdSchema.optional(),
  latitude: z.number().gte(-90).lte(90).optional(),
  longitude: z.number().gte(-180).lte(180).optional(),
  source: z.string().trim().min(2).max(80).optional(),
  demo: z.boolean().optional(),
  inferenceSource: z.string().max(120).optional(),
  modelName: z.string().max(120).optional(),
  modelVersion: z.string().max(64).optional(),
  modelConfidence: z.number().min(0).max(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const speechSchema = eventSchema.extend({
  eventType: z.literal('abusive_language'),
  provider: z.string().min(2).max(120),
  confidence: z.number().min(0).max(1).optional(),
  includeTranscript: z.boolean().optional(),
  transcript: z.string().max(2000).optional(),
});

export const safetyRouter = Router();

safetyRouter.post('/events', asyncHandler(async (req, res) => {
  const body = eventSchema.parse(req.body);
  const recorded = await acceptEvent(req, body);
  res.status(recorded.duplicate ? 200 : 201).json(recorded);
}));

safetyRouter.get('/events', authenticate, asyncHandler(async (req, res) => {
  const query = paginationQuerySchema.extend({ tripId: objectIdSchema.optional() }).parse(req.query);
  res.json(await listEvents(req.user!, query));
}));

safetyRouter.get('/events/:eventId', authenticate, asyncHandler(async (req, res) => {
  res.json(await getEvent(req.user!, String(req.params.eventId)));
}));

safetyRouter.post('/events/:eventId/acknowledge', authenticate, asyncHandler(async (req, res) => {
  res.json(await acknowledgeEvent(req.user!, String(req.params.eventId)));
}));

safetyRouter.post('/events/:eventId/review', authenticate, asyncHandler(async (req, res) => {
  const body = z.object({ status: z.enum(['confirmed', 'rejected', 'corrected']), note: z.string().max(1000).optional() }).parse(req.body);
  res.json(await reviewEvent(req.user!, String(req.params.eventId), body));
}));

safetyRouter.post('/sos', authenticate, asyncHandler(async (req, res) => {
  const body = z.object({
    tripId: objectIdSchema,
    eventId: z.string().trim().min(4).max(120).optional(),
    latitude: z.number().gte(-90).lte(90).optional(),
    longitude: z.number().gte(-180).lte(180).optional(),
    occurredAt: z.coerce.date().optional(),
  }).parse(req.body);
  const trip = await assertTripAccess(req.user!, body.tripId, 'safety.sos');
  const result = await recordSafetyEvent({
    eventId: body.eventId ?? `sos_${trip.id}_${Date.now()}`,
    eventType: 'sos',
    severity: 'critical',
    source: 'guardian_app',
    demo: false,
    occurredAt: body.occurredAt ?? new Date(),
    trip,
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
    payload: { reportedBy: req.user!.id },
  });
  const { presentIncident } = await import('./safety.service');
  res.status(result.duplicate ? 200 : 201).json(result.incident ? await presentIncident(result.incident) : { event: result.event.eventId, incident: null });
}));

safetyRouter.post('/speech-events', asyncHandler(async (req, res) => {
  const body = speechSchema.parse(req.body);
  const trip = body.tripId ? await loadTripForEvent(body.tripId) : null;
  if (!trip) throw new AppError(422, 'VALIDATION_ERROR', 'tripId is required for speech events');
  const passenger = await UserModel.findById(trip.passengerId);
  if (!passenger?.privacy.speechMonitoring) throw new AppError(409, 'CONSENT_REQUIRED', 'Speech monitoring consent is not granted');
  const payload: { provider: string; confidence: number | null; transcriptStored: boolean; transcript?: string } = {
    ...(body.payload ?? {}),
    provider: body.provider,
    confidence: body.confidence ?? null,
    transcriptStored: false,
  };
  if (body.includeTranscript && body.transcript && passenger.privacy.speechMonitoring) {
    payload.transcript = body.transcript;
    payload.transcriptStored = true;
  }
  const device = await deviceFromRequest(req);
  if (!device && !req.header('authorization')) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  if (!device) {
    await authenticate(req, res, () => undefined);
    if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
    await assertTripAccess(req.user, trip.id, 'safety.speech');
  } else {
    await assertDeviceVehicle(device, trip.vehicleId.toString());
  }
  const result = await recordSafetyEvent({
    eventId: body.eventId,
    eventType: 'abusive_language',
    severity: body.severity,
    source: device ? (device.demo ? 'demo' : 'device_inference') : 'guardian_app',
    demo: device ? device.demo : false,
    occurredAt: body.occurredAt,
    trip,
    vehicle: await loadVehicle(trip.vehicleId.toString()) ?? undefined,
    inferenceSource: body.provider,
    modelConfidence: body.confidence ?? null,
    payload,
  });
  res.status(result.duplicate ? 200 : 201).json({ eventId: result.event.eventId, duplicate: result.duplicate, transcriptStored: payload.transcriptStored === true });
}));

safetyRouter.get('/risk', authenticate, asyncHandler(async (req, res) => {
  res.json(await assessVisibleRisk(req.user!));
}));

export const incidentRouter = Router();
incidentRouter.use(authenticate);

incidentRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ items: await listIncidents(req.user!) });
}));

incidentRouter.get('/:incidentId', asyncHandler(async (req, res) => {
  res.json(await getIncident(req.user!, String(req.params.incidentId)));
}));

incidentRouter.post('/:incidentId/acknowledge', asyncHandler(async (req, res) => {
  res.json(await acknowledgeIncident(req.user!, String(req.params.incidentId)));
}));

const uploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(3).max(120),
  sizeBytes: z.number().int().positive(),
  mediaType: z.enum(['photo', 'video']),
  capturedAt: z.coerce.date(),
  durationSeconds: z.number().min(0).max(60 * 30).optional(),
  eventId: z.string().max(120).optional(),
});

incidentRouter.post('/:incidentId/media/upload-url', asyncHandler(async (req, res) => {
  const body = uploadSchema.parse(req.body);
  res.status(201).json(await requestUploadUrl(req.user!, String(req.params.incidentId), body));
}));

incidentRouter.post('/:incidentId/media/complete', asyncHandler(async (req, res) => {
  const body = z.object({ mediaId: objectIdSchema }).parse(req.body);
  res.json(await completeUpload(req.user!, String(req.params.incidentId), body.mediaId));
}));

incidentRouter.get('/:incidentId/media', asyncHandler(async (req, res) => {
  res.json({ items: await listMedia(req.user!, String(req.params.incidentId)) });
}));

export const mediaRouter = Router();
mediaRouter.use(authenticate);

mediaRouter.get('/:mediaId/access-url', asyncHandler(async (req, res) => {
  res.json(await accessUrl(req.user!, String(req.params.mediaId)));
}));

mediaRouter.delete('/:mediaId', asyncHandler(async (req, res) => {
  await deleteMedia(req.user!, String(req.params.mediaId));
  res.status(204).send();
}));

mediaRouter.post('/:mediaId/cabin-review', asyncHandler(async (req, res) => {
  res.json(await reviewMedia(req.user!, String(req.params.mediaId)));
}));

async function acceptEvent(req: import('express').Request, body: z.infer<typeof eventSchema>) {
  const device = await deviceFromRequest(req);
  const trip = body.tripId ? await loadTripForEvent(body.tripId) : body.vehicleId ? await TripModel.findOne({ vehicleId: body.vehicleId, status: 'active' }) : null;
  if (device) {
    const vehicleId = body.vehicleId ?? trip?.vehicleId.toString();
    if (!vehicleId) throw new AppError(422, 'VALIDATION_ERROR', 'vehicleId is required');
    await assertDeviceVehicle(device, vehicleId);
    const vehicle = await loadVehicle(vehicleId);
    return recordSafetyEvent({
      ...body,
      severity: body.severity,
      source: device.demo ? 'demo' : (body.source && body.source !== 'demo' ? body.source : 'device_inference'),
      demo: device.demo,
      trip,
      vehicle,
      payload: body.payload,
    });
  }
  await new Promise<void>((resolve, reject) => authenticate(req, {} as import('express').Response, (error) => error ? reject(error) : resolve()));
  if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  if (!trip) throw new AppError(422, 'VALIDATION_ERROR', 'tripId is required');
  await assertTripAccess(req.user, trip.id, 'safety.create');
  if (body.demo) throw new AppError(403, 'DEMO_REJECTED', 'Clients cannot mark an event as demo');
  return recordSafetyEvent({
    ...body,
    source: 'guardian_app',
    demo: false,
    trip,
    payload: body.payload,
  });
}

async function deviceFromRequest(req: import('express').Request) {
  const identity = req.header('x-device-identity');
  const key = req.header('x-device-key');
  if (!identity || !key) return null;
  return authenticateDevice(identity, key);
}
