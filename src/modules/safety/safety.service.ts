import { FilterQuery, Types } from 'mongoose';
import { getConfig } from '../../config/env';
import { assessRisk, weightFor, type ObservedSignal, type SafetyEventType } from '../../config/risk-rules';
import { AppError, NotFoundError, isDuplicateKey } from '../../common/errors/app-error';
import type { AuthenticatedUser } from '../../common/middleware/authenticate';
import { encodeCursor, parseCursor } from '../../common/validation/primitives';
import { FamilyRelationshipModel } from '../../models/family';
import { IncidentModel, type IncidentDocument } from '../../models/incident';
import { SafetyEventModel, type SafetyEventDocument } from '../../models/safety';
import { TripModel, type TripDocument } from '../../models/trip';
import { UserModel } from '../../models/user';
import { VehicleModel, type VehicleDocument } from '../../models/vehicle';
import { assertIncidentAccess, assertTripAccess, recipientGuardians } from '../access/access.service';
import { writeAudit } from '../audit/audit.service';
import { enqueueAlerts } from '../notifications/notification.service';
import { publishToTrip, publishToUsers } from '../../realtime/publisher';
import { grantedRelationshipsForGuardian, tripQueryFor } from '../access/access.service';

const MOBILE_KIND: Record<SafetyEventType, string> = {
  sos: 'sos',
  driver_fatigue: 'fatigue',
  driver_distraction: 'distraction',
  speeding: 'speeding',
  harsh_braking: 'harsh_braking',
  route_deviation: 'geofence',
  seat_occupancy_change: 'occupancy',
  abusive_language: 'abusive_language',
  face_not_detected: 'face_not_detected',
  camera_offline: 'camera_offline',
  device_offline: 'device_offline',
  gps_stale: 'gps_stale',
};

export type RecordEventInput = {
  eventId: string;
  eventType: SafetyEventType;
  severity: 'info' | 'warning' | 'critical';
  source: string;
  demo: boolean;
  occurredAt: Date;
  trip?: TripDocument | null;
  vehicle?: VehicleDocument | null;
  latitude?: number | null;
  longitude?: number | null;
  payload?: Record<string, unknown>;
  inferenceSource?: string;
  modelName?: string;
  modelVersion?: string;
  modelConfidence?: number | null;
};

export async function recordSafetyEvent(input: RecordEventInput): Promise<{ event: SafetyEventDocument; incident: IncidentDocument | null; duplicate: boolean }> {
  assertSource(input.demo, input.source);
  const severity = input.eventType === 'sos' ? 'critical' : input.severity;
  const hasCoordinates = input.latitude != null && input.longitude != null;
  const familyGroupId = input.trip?.familyGroupId ?? input.vehicle?.familyGroupId;
  if (!familyGroupId) throw new AppError(422, 'VALIDATION_ERROR', 'An event needs a trip or a vehicle');
  const created = await SafetyEventModel.create({
    eventId: input.eventId,
    tripId: input.trip?._id ?? null,
    vehicleId: input.trip?.vehicleId ?? input.vehicle?._id ?? null,
    passengerId: input.trip?.passengerId ?? null,
    familyGroupId,
    eventType: input.eventType,
    severity,
    source: input.source,
    demo: input.demo,
    occurredAt: input.occurredAt,
    payload: sanitizePayload(input.payload ?? {}),
    inferenceSource: input.inferenceSource ?? '',
    modelName: input.modelName ?? '',
    modelVersion: input.modelVersion ?? '',
    modelConfidence: input.modelConfidence ?? null,
    locationUnavailable: !hasCoordinates,
    latitude: hasCoordinates ? input.latitude : null,
    longitude: hasCoordinates ? input.longitude : null,
    processingStatus: 'received',
  }).catch(async (error: unknown) => {
    if (!isDuplicateKey(error)) throw error;
    return null;
  });
  const event = created ?? await SafetyEventModel.findOne({ eventId: input.eventId });
  if (!event) throw new AppError(500, 'INTERNAL_ERROR', 'The safety event could not be stored');
  const duplicate = !created;
  if (duplicate) {
    const sameTrip = String(event.tripId ?? '') === String(input.trip?._id ?? '');
    const incomingVehicle = input.vehicle?._id ?? input.trip?.vehicleId ?? null;
    const sameVehicle = String(event.vehicleId ?? '') === String(incomingVehicle ?? '');
    if (!sameTrip || !sameVehicle) throw new AppError(409, 'EVENT_ID_CONFLICT', 'That event id is already in use');
  }
  const incident = await ensureIncident(event, input.trip ?? null);
  if (!event.notificationsEnqueued && shouldAlert(event)) {
    await fanOut(event, incident, input.trip ?? null);
    event.notificationsEnqueued = true;
  }
  event.processingStatus = 'processed';
  await event.save();
  return { event, incident, duplicate };
}

function shouldAlert(event: SafetyEventDocument): boolean {
  if (event.eventType === 'sos' || event.severity === 'critical') return true;
  return weightFor(event.eventType as SafetyEventType) >= getConfig().safety.highRiskThreshold;
}

async function ensureIncident(event: SafetyEventDocument, trip: TripDocument | null): Promise<IncidentDocument | null> {
  if (!shouldAlert(event) || !trip) return IncidentModel.findOne({ primaryEventId: event.eventId });
  const existing = await IncidentModel.findOne({ primaryEventId: event.eventId });
  if (existing) return existing;
  const guardians = await recipientGuardians(trip);
  const viewers = [trip.passengerId.toString(), ...guardians];
  const hasCoordinates = event.latitude != null && event.longitude != null;
  try {
    return await IncidentModel.create({
      tripId: trip._id,
      vehicleId: trip.vehicleId,
      passengerId: trip.passengerId,
      familyGroupId: trip.familyGroupId,
      eventIds: [event.eventId],
      primaryEventId: event.eventId,
      eventType: event.eventType,
      severity: event.severity,
      description: descriptionFor(event),
      status: 'open',
      ...(hasCoordinates ? { location: { type: 'Point', coordinates: [event.longitude, event.latitude] } } : {}),
      locationUnavailable: !hasCoordinates,
      locationLabel: hasCoordinates ? 'Reported coordinates' : 'Location unavailable',
      authorizedViewerIds: viewers,
      demo: event.demo,
      source: event.source,
      occurredAt: event.occurredAt,
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    return IncidentModel.findOne({ primaryEventId: event.eventId });
  }
}

async function fanOut(event: SafetyEventDocument, incident: IncidentDocument | null, trip: TripDocument | null): Promise<void> {
  const guardians = trip ? await recipientGuardians(trip) : await familyGuardians(event.familyGroupId.toString());
  const passenger = trip ? await UserModel.findById(trip.passengerId) : null;
  const vehicle = event.vehicleId ? await VehicleModel.findById(event.vehicleId) : null;
  await enqueueAlerts({
    recipientIds: guardians,
    eventId: event.eventId,
    eventType: event.eventType as SafetyEventType,
    incidentId: incident?.id ?? null,
    tripId: trip?.id ?? null,
    passengerName: passenger?.name ?? 'Unknown passenger',
    vehicleLabel: vehicle?.displayName ?? 'Unknown vehicle',
    locationUnavailable: event.locationUnavailable,
    demo: event.demo,
  });
  const socketUsers = [...guardians];
  if (trip) socketUsers.push(trip.passengerId.toString());
  const payload = presentAlert(event, incident, passenger?.name, vehicle?.displayName);
  publishToUsers(socketUsers, 'safety:event', payload);
  publishToTrip(trip?.id ?? '', 'safety:event', payload);
  if (event.eventType === 'sos') {
    publishToUsers(socketUsers, 'safety:sos', payload);
    publishToTrip(trip?.id ?? '', 'safety:sos', payload);
  }
  if (incident) {
    const incidentPayload = { incidentId: incident.id, tripId: trip?.id ?? null, eventId: event.eventId, demo: event.demo };
    publishToUsers(socketUsers, 'incident:created', incidentPayload);
  }
}

async function familyGuardians(familyGroupId: string): Promise<string[]> {
  const relationships = await FamilyRelationshipModel.find({
    familyGroupId,
    consentStatus: 'granted',
    revokedAt: null,
    'permissions.receiveAlerts': true,
  });
  return [...new Set(relationships.map((item) => item.guardianId.toString()))];
}

export async function listEvents(user: AuthenticatedUser, query: { cursor?: string; limit: number; tripId?: string }) {
  const filter: FilterQuery<SafetyEventDocument> = await eventFilter(user, query.tripId);
  const cursor = parseCursor(query.cursor);
  if (query.cursor && !cursor) throw new AppError(422, 'VALIDATION_ERROR', 'cursor: is invalid');
  if (cursor && Types.ObjectId.isValid(cursor.id)) {
    const clause = {
      $or: [
        { occurredAt: { $lt: cursor.recordedAt } },
        { occurredAt: cursor.recordedAt, _id: { $lt: cursor.id } },
      ],
    };
    filter.$and = [...(Array.isArray(filter.$and) ? filter.$and : []), clause];
  }
  const docs = await SafetyEventModel.find(filter).sort({ occurredAt: -1, _id: -1 }).limit(query.limit + 1);
  const page = docs.slice(0, query.limit);
  const next = docs.length > query.limit ? page[page.length - 1] : null;
  return {
    items: page.map((event) => presentEvent(event)),
    nextCursor: next ? encodeCursor(next.occurredAt, next.id) : null,
  };
}

export async function getEvent(user: AuthenticatedUser, eventId: string) {
  const event = await SafetyEventModel.findOne({ $or: [{ eventId }, ...(Types.ObjectId.isValid(eventId) ? [{ _id: eventId }] : [])] });
  if (!event) throw new NotFoundError('Safety event not found');
  if (event.tripId) await assertTripAccess(user, event.tripId.toString(), 'safety.view');
  else if (user.role !== 'administrator' && user.familyGroupId !== event.familyGroupId.toString()) throw new NotFoundError('Safety event not found');
  return presentEvent(event);
}

export async function acknowledgeEvent(user: AuthenticatedUser, eventId: string) {
  const event = await SafetyEventModel.findOne({ $or: [{ eventId }, ...(Types.ObjectId.isValid(eventId) ? [{ _id: eventId }] : [])] });
  if (!event) throw new NotFoundError('Safety event not found');
  if (!event.tripId) throw new NotFoundError('Safety event not found');
  await assertTripAccess(user, event.tripId.toString(), 'safety.acknowledge');
  event.acknowledgement = { acknowledged: true, acknowledgedAt: new Date(), acknowledgedBy: new Types.ObjectId(user.id) };
  await event.save();
  await writeAudit({ actorId: user.id, actorRole: user.role, action: 'safety.acknowledge', resourceType: 'safety_event', resourceId: event.eventId, decision: 'allow' });
  return presentEvent(event);
}

export async function reviewEvent(user: AuthenticatedUser, eventId: string, input: { status: 'confirmed' | 'rejected' | 'corrected'; note?: string }) {
  const event = await SafetyEventModel.findOne({ eventId });
  if (!event?.tripId) throw new NotFoundError('Safety event not found');
  await assertTripAccess(user, event.tripId.toString(), 'safety.review');
  event.review = { status: input.status, note: input.note ?? '', reviewedBy: new Types.ObjectId(user.id), reviewedAt: new Date() };
  await event.save();
  await writeAudit({ actorId: user.id, actorRole: user.role, action: 'safety.review', resourceType: 'safety_event', resourceId: event.eventId, decision: 'allow', metadata: { status: input.status } });
  return presentEvent(event);
}

export async function listIncidents(user: AuthenticatedUser) {
  const passengerIds = user.role === 'guardian'
    ? (await grantedRelationshipsForGuardian(user.id)).map((item) => item.passengerId?.toString()).filter((id): id is string => Boolean(id))
    : [];
  const trips = await TripModel.find(tripQueryFor(user, passengerIds)).select('_id');
  const incidents = await IncidentModel.find({ tripId: { $in: trips.map((trip) => trip._id) } }).sort({ occurredAt: -1 }).limit(100);
  return Promise.all(incidents.map((incident) => presentIncident(incident)));
}

export async function getIncident(user: AuthenticatedUser, incidentId: string) {
  const incident = await assertIncidentAccess(user, incidentId);
  await writeAudit({ actorId: user.id, actorRole: user.role, action: 'incident.view', resourceType: 'incident', resourceId: incidentId, decision: 'allow' });
  return presentIncident(incident);
}

export async function acknowledgeIncident(user: AuthenticatedUser, incidentId: string) {
  const incident = await assertIncidentAccess(user, incidentId);
  incident.status = 'acknowledged';
  incident.acknowledgedAt = new Date();
  incident.acknowledgedBy = new Types.ObjectId(user.id);
  await incident.save();
  if (incident.primaryEventId) await acknowledgeEvent(user, incident.primaryEventId);
  await writeAudit({ actorId: user.id, actorRole: user.role, action: 'incident.acknowledge', resourceType: 'incident', resourceId: incident.id, decision: 'allow' });
  return presentIncident(incident);
}

export async function assessTripRisk(user: AuthenticatedUser, tripId: string) {
  const trip = await assertTripAccess(user, tripId, 'safety.risk');
  return buildRisk([trip]);
}

export async function assessVisibleRisk(user: AuthenticatedUser) {
  const passengerIds = user.role === 'guardian'
    ? (await grantedRelationshipsForGuardian(user.id)).map((item) => item.passengerId?.toString()).filter((id): id is string => Boolean(id))
    : [];
  const trips = await TripModel.find({ ...tripQueryFor(user, passengerIds), status: 'active' });
  return buildRisk(trips);
}

async function buildRisk(trips: TripDocument[]) {
  const config = getConfig();
  const since = new Date(Date.now() - config.safety.windowMinutes * 60 * 1000);
  const events = trips.length
    ? await SafetyEventModel.find({ tripId: { $in: trips.map((trip) => trip._id) }, occurredAt: { $gte: since } })
    : [];
  const signals: ObservedSignal[] = events.map((event) => ({
    eventType: event.eventType as SafetyEventType,
    severity: event.severity as ObservedSignal['severity'],
    weight: weightFor(event.eventType as SafetyEventType),
    eventId: event.eventId,
  }));
  const freshest = trips.reduce<Date | null>((latest, trip) => {
    if (!trip.lastLocationAt) return latest;
    if (!latest || trip.lastLocationAt > latest) return trip.lastLocationAt;
    return latest;
  }, null);
  const stale = !freshest || Date.now() - freshest.getTime() > config.location.staleAfterSeconds * 1000;
  const deviceOffline = trips.some((trip) => trip.offlineAlertActive);
  return assessRisk({
    rulesVersion: config.safety.rulesVersion,
    threshold: config.safety.highRiskThreshold,
    signals,
    hasFreshLocation: Boolean(freshest) && !stale,
    hasAnyLocation: Boolean(freshest),
    deviceOffline,
    locationStale: Boolean(freshest) && stale,
  });
}

async function eventFilter(user: AuthenticatedUser, tripId?: string): Promise<FilterQuery<SafetyEventDocument>> {
  if (tripId) {
    await assertTripAccess(user, tripId, 'safety.list');
    return { tripId };
  }
  const passengerIds = user.role === 'guardian'
    ? (await grantedRelationshipsForGuardian(user.id)).map((item) => item.passengerId?.toString()).filter((id): id is string => Boolean(id))
    : [];
  const trips = await TripModel.find(tripQueryFor(user, passengerIds)).select('_id');
  return { tripId: { $in: trips.map((trip) => trip._id) } };
}

function assertSource(demo: boolean, source: string): void {
  const config = getConfig();
  if (demo && !config.demo.enabled) throw new AppError(403, 'DEMO_REJECTED', 'Demo safety events are disabled');
  if (demo && !['demo', 'demo_gps', 'system'].includes(source)) {
    throw new AppError(422, 'SOURCE_MISMATCH', 'Demo events must use a demo or system source');
  }
  if (!demo && (source === 'demo' || source === 'demo_gps')) {
    throw new AppError(422, 'SOURCE_MISMATCH', 'Hardware events cannot use a demo source');
  }
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...payload };
  delete clone.authToken;
  delete clone.audio;
  delete clone.rawAudio;
  delete clone.password;
  delete clone.token;
  return clone;
}

function descriptionFor(event: SafetyEventDocument): string {
  const location = event.locationUnavailable ? 'Location is unavailable.' : 'Coordinates were reported with the event.';
  if (event.eventType === 'sos') return `SOS was stored after validation. ${location} Emergency services are not contacted by this service.`;
  return `${event.eventType} was stored from ${event.source}. ${location}`;
}

export function presentEvent(event: SafetyEventDocument) {
  return {
    id: event.id,
    eventId: event.eventId,
    tripId: event.tripId?.toString() ?? null,
    vehicleId: event.vehicleId?.toString() ?? null,
    passengerId: event.passengerId?.toString() ?? null,
    eventType: event.eventType,
    kind: MOBILE_KIND[event.eventType as SafetyEventType] ?? event.eventType,
    severity: event.severity,
    source: event.source,
    demo: event.demo,
    occurredAt: event.occurredAt,
    locationUnavailable: event.locationUnavailable,
    latitude: event.locationUnavailable ? null : event.latitude,
    longitude: event.locationUnavailable ? null : event.longitude,
    acknowledgement: event.acknowledgement,
    review: event.review,
    processingStatus: event.processingStatus,
    inferenceSource: event.inferenceSource || null,
    modelName: event.modelName || null,
    modelVersion: event.modelVersion || null,
    modelConfidence: event.modelConfidence,
    payload: event.payload,
  };
}

function presentAlert(event: SafetyEventDocument, incident: IncidentDocument | null, passengerName?: string, vehicleLabel?: string) {
  const canonical = presentEvent(event);
  return {
    ...canonical,
    incidentId: incident?.id,
    title: event.eventType === 'sos' ? 'SOS alert' : `${event.eventType} signal`,
    message: descriptionFor(event),
    createdAt: event.occurredAt,
    simulated: event.demo,
    acknowledged: event.acknowledgement?.acknowledged ?? false,
    passengerName,
    vehicleLabel,
    mobileSeverity: event.severity === 'warning' ? 'watch' : event.severity,
  };
}

export async function presentIncident(incident: IncidentDocument) {
  const { MediaAssetModel } = await import('../../models/incident');
  const media = await MediaAssetModel.find({ incidentId: incident._id, uploadState: { $ne: 'deleted' } });
  return {
    id: incident.id,
    tripId: incident.tripId.toString(),
    vehicleId: incident.vehicleId?.toString() ?? null,
    passengerId: incident.passengerId.toString(),
    kind: MOBILE_KIND[incident.eventType as SafetyEventType] ?? incident.eventType,
    eventType: incident.eventType,
    severity: incident.severity,
    title: incident.eventType === 'sos' ? 'SOS alert' : `${incident.eventType} incident`,
    summary: incident.description,
    description: incident.description,
    occurredAt: incident.occurredAt,
    locationLabel: incident.locationLabel,
    coordinate: incident.locationUnavailable || incident.location?.coordinates?.length !== 2
      ? null
      : { latitude: incident.location.coordinates[1], longitude: incident.location.coordinates[0] },
    locationUnavailable: incident.locationUnavailable,
    status: incident.status === 'acknowledged' ? 'open' : incident.status,
    canonicalStatus: incident.status,
    acknowledged: incident.status !== 'open',
    simulated: incident.demo,
    demo: incident.demo,
    source: incident.source,
    evidence: media.map((item) => ({
      id: item.id,
      kind: item.mediaType,
      uri: null,
      label: item.originalFileName || item.mediaType,
      simulated: item.demo,
      capturedAt: item.capturedAt,
      durationSec: item.durationSeconds,
      uploadStatus: item.uploadState === 'uploaded' ? 'uploaded' : item.uploadState,
    })),
    eventIds: incident.eventIds,
  };
}

export async function loadTripForEvent(tripId?: string | null): Promise<TripDocument | null> {
  if (!tripId || !Types.ObjectId.isValid(tripId)) return null;
  return TripModel.findById(tripId);
}

export async function loadVehicle(vehicleId: string): Promise<VehicleDocument | null> {
  if (!Types.ObjectId.isValid(vehicleId)) return null;
  return VehicleModel.findById(vehicleId);
}
