import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/http/async-handler';
import { authenticate } from '../../common/middleware/authenticate';
import { objectIdSchema, paginationQuerySchema } from '../../common/validation/primitives';
import { assertTripAccess } from '../access/access.service';
import { acknowledgeEvent, acknowledgeIncident, assessVisibleRisk, getIncident, listIncidents, presentIncident, recordSafetyEvent } from '../safety/safety.service';
import { listTrips, toMobileTrip, tripRoute } from '../trips/trip.service';

export const mobileRouter = Router();
mobileRouter.use(authenticate);

mobileRouter.get('/trips/active', asyncHandler(async (req, res) => {
  const page = await listTrips(req.user!, { limit: 20, status: 'active' });
  const trips = [];
  for (const item of page.items) trips.push(await toMobileTrip(await assertTripAccess(req.user!, item.id), req.user!));
  res.json(trips);
}));

mobileRouter.get('/trips/history', asyncHandler(async (req, res) => {
  const query = paginationQuerySchema.parse(req.query);
  const page = await listTrips(req.user!, { ...query, status: 'completed' });
  const items = [];
  for (const item of page.items) items.push(await toMobileTrip(await assertTripAccess(req.user!, item.id), req.user!));
  res.json({ items, nextCursor: page.nextCursor });
}));

mobileRouter.get('/trips/:tripId/route', asyncHandler(async (req, res) => {
  const route = await tripRoute(req.user!, String(req.params.tripId));
  res.json({
    coordinates: route.coordinates.map((point) => ({ latitude: point.latitude, longitude: point.longitude })),
    eta: null,
    etaAvailability: route.etaAvailability,
    routingAvailability: route.routingAvailability,
  });
}));

mobileRouter.get('/trips/:tripId', asyncHandler(async (req, res) => {
  const trip = await assertTripAccess(req.user!, String(req.params.tripId));
  res.json(await toMobileTrip(trip, req.user!));
}));

mobileRouter.get('/safety/score', asyncHandler(async (req, res) => {
  const assessment = await assessVisibleRisk(req.user!);
  res.json({ ...assessment, score: null, simulated: false });
}));

mobileRouter.get('/safety/alerts', asyncHandler(async (req, res) => {
  const incidents = await listIncidents(req.user!);
  res.json(incidents.map((incident) => ({
    id: incident.eventIds[0] ?? incident.id,
    tripId: incident.tripId,
    incidentId: incident.id,
    kind: incident.kind,
    eventType: incident.eventType,
    severity: incident.severity === 'warning' ? 'watch' : incident.severity,
    canonicalSeverity: incident.severity,
    title: incident.title,
    message: incident.summary,
    createdAt: incident.occurredAt,
    simulated: incident.demo,
    acknowledged: incident.acknowledged,
    source: incident.source,
  })));
}));

mobileRouter.get('/safety/incidents', asyncHandler(async (req, res) => {
  res.json(await listIncidents(req.user!));
}));

mobileRouter.get('/safety/incidents/:incidentId', asyncHandler(async (req, res) => {
  res.json(await getIncident(req.user!, String(req.params.incidentId)));
}));

mobileRouter.post('/safety/alerts/:eventId/acknowledge', asyncHandler(async (req, res) => {
  await acknowledgeEvent(req.user!, String(req.params.eventId));
  res.status(204).send();
}));

mobileRouter.post('/safety/incidents/:incidentId/acknowledge', asyncHandler(async (req, res) => {
  await acknowledgeIncident(req.user!, String(req.params.incidentId));
  res.status(204).send();
}));

mobileRouter.post('/safety/sos', asyncHandler(async (req, res) => {
  const body = z.object({ tripId: objectIdSchema }).parse(req.body);
  const trip = await assertTripAccess(req.user!, body.tripId, 'safety.sos');
  const result = await recordSafetyEvent({
    eventId: `sos_mobile_${trip.id}_${Date.now()}`,
    eventType: 'sos',
    severity: 'critical',
    source: 'guardian_app',
    demo: false,
    occurredAt: new Date(),
    trip,
    latitude: null,
    longitude: null,
  });
  res.status(201).json(result.incident ? await presentIncident(result.incident) : { incident: null, locationUnavailable: true });
}));

mobileRouter.post('/safety/incidents/:incidentId/evidence', asyncHandler(async (_req, res) => {
  res.status(409).json({
    code: 'USE_SIGNED_UPLOAD',
    message: 'Direct binary upload is disabled. Request a signed URL from POST /api/v1/incidents/:incidentId/media/upload-url.',
  });
}));
