import { Types, type FilterQuery } from 'mongoose';
import { getConfig } from '../../config/env';
import { AppError, ConflictError, NotFoundError } from '../../common/errors/app-error';
import type { AuthenticatedUser } from '../../common/middleware/authenticate';
import { encodeCursor, parseCursor } from '../../common/validation/primitives';
import { assessMovement } from '../../common/utils/movement';
import { FamilyRelationshipModel } from '../../models/family';
import { LocationPointModel, type LocationPointDocument } from '../../models/location';
import { SafetyEventModel } from '../../models/safety';
import { TripModel, type TripDocument, type TripStatus } from '../../models/trip';
import { UserModel } from '../../models/user';
import { VehicleModel } from '../../models/vehicle';
import { IncidentModel } from '../../models/incident';
import { NotificationModel } from '../../models/notification';
import { assertTripAccess, canSeeLocation, grantedRelationshipsForGuardian, tripQueryFor } from '../access/access.service';
import { listLocations } from '../locations/location.service';
import { publishToTrip, publishToUsers } from '../../realtime/publisher';

type PlaceInput = { label: string; latitude?: number | null; longitude?: number | null };

export async function createTrip(user: AuthenticatedUser, input: {
  passengerId: string;
  vehicleId: string;
  driverId?: string | null;
  origin: PlaceInput;
  destination: PlaceInput;
  authorizedGuardianIds?: string[];
  sharing?: { shareLocation?: boolean; shareMedia?: boolean };
  demo?: boolean;
}) {
  if (!Types.ObjectId.isValid(input.passengerId) || !Types.ObjectId.isValid(input.vehicleId)) {
    throw new NotFoundError('Trip passenger or vehicle was not found');
  }
  if (input.demo && !getConfig().demo.enabled) throw new AppError(403, 'DEMO_REJECTED', 'Demo trips are disabled');
  const passenger = await UserModel.findById(input.passengerId);
  const vehicle = await VehicleModel.findById(input.vehicleId);
  if (!passenger || !vehicle || vehicle.status !== 'active') throw new NotFoundError('Trip passenger or vehicle was not found');
  if (user.role === 'passenger' && user.id !== passenger.id) throw new NotFoundError('Trip passenger or vehicle was not found');
  if (user.role === 'guardian') {
    const relationship = await FamilyRelationshipModel.findOne({
      guardianId: user.id,
      passengerId: passenger._id,
      consentStatus: 'granted',
      revokedAt: null,
      'permissions.viewTrips': true,
    });
    if (!relationship) throw new NotFoundError('Trip passenger or vehicle was not found');
  }
  if (user.familyGroupId && vehicle.familyGroupId.toString() !== user.familyGroupId && user.role !== 'administrator') {
    throw new NotFoundError('Trip passenger or vehicle was not found');
  }
  const relationships = await FamilyRelationshipModel.find({
    passengerId: passenger._id,
    consentStatus: 'granted',
    revokedAt: null,
    'permissions.viewTrips': true,
  });
  const eligible = new Set(relationships.map((item) => item.guardianId.toString()));
  const requested = input.authorizedGuardianIds?.length ? input.authorizedGuardianIds : [...eligible];
  if (requested.some((id) => !eligible.has(id))) {
    throw new AppError(403, 'GUARDIAN_NOT_AUTHORIZED', 'Every guardian on a trip needs a granted family relationship');
  }
  const relationshipLabel = relationships[0]?.relationship ?? '';
  const trip = await TripModel.create({
    familyGroupId: vehicle.familyGroupId,
    passengerId: passenger._id,
    vehicleId: vehicle._id,
    driverId: input.driverId && Types.ObjectId.isValid(input.driverId) ? input.driverId : vehicle.assignedDriverId,
    authorizedGuardianIds: requested,
    origin: place(input.origin),
    destination: place(input.destination),
    status: 'scheduled',
    sharing: {
      shareLocation: input.sharing?.shareLocation ?? true,
      shareMedia: input.sharing?.shareMedia ?? false,
    },
    demo: Boolean(input.demo) || vehicle.demo,
    source: input.demo || vehicle.demo ? 'demo' : 'user',
    relationshipLabel,
  });
  if (vehicle.demo && !getConfig().demo.enabled) {
    await trip.deleteOne();
    throw new AppError(403, 'DEMO_REJECTED', 'Demo trips are disabled');
  }
  return presentTrip(trip, user);
}

function place(input: PlaceInput) {
  return {
    label: input.label,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
  };
}

export async function listTrips(user: AuthenticatedUser, query: { cursor?: string; limit: number; status?: TripStatus }) {
  const passengerIds = user.role === 'guardian' ? (await grantedRelationshipsForGuardian(user.id)).map((item) => item.passengerId?.toString()).filter((id): id is string => Boolean(id)) : [];
  const access = tripQueryFor(user, passengerIds);
  const filter: FilterQuery<TripDocument> = {};
  const and: FilterQuery<TripDocument>[] = [];
  if (Object.keys(access).length > 0) and.push(access);
  if (query.status) filter.status = query.status;
  const cursor = parseCursor(query.cursor);
  if (query.cursor && !cursor) throw new AppError(422, 'VALIDATION_ERROR', 'cursor: is invalid');
  if (cursor && Types.ObjectId.isValid(cursor.id)) {
    and.push({
      $or: [
        { updatedAt: { $lt: cursor.recordedAt } },
        { updatedAt: cursor.recordedAt, _id: { $lt: cursor.id } },
      ],
    });
  }
  if (and.length) filter.$and = and;
  const docs = await TripModel.find(filter).sort({ updatedAt: -1, _id: -1 }).limit(query.limit + 1);
  const page = docs.slice(0, query.limit);
  const next = docs.length > query.limit ? page[page.length - 1] : null;
  const items = await Promise.all(page.map((trip) => presentTrip(trip, user)));
  return { items, nextCursor: next ? encodeCursor(next.updatedAt, next.id) : null };
}

export async function getTrip(user: AuthenticatedUser, tripId: string) {
  const trip = await assertTripAccess(user, tripId);
  return presentTrip(trip, user);
}

export async function changeStatus(user: AuthenticatedUser, tripId: string, next: 'active' | 'completed' | 'cancelled' | 'interrupted') {
  const trip = await assertTripAccess(user, tripId, 'trip.update');
  if (user.role === 'guardian') {
    const relationship = await FamilyRelationshipModel.findOne({ guardianId: user.id, passengerId: trip.passengerId, consentStatus: 'granted', revokedAt: null });
    if (!relationship) throw new NotFoundError('Trip not found');
  }
  if (next === 'active') {
    if (trip.status !== 'scheduled' && trip.status !== 'interrupted') throw new ConflictError('Only a scheduled or interrupted trip can be started');
    const vehicleBusy = await TripModel.exists({ vehicleId: trip.vehicleId, status: 'active', _id: { $ne: trip._id } });
    const passengerBusy = await TripModel.exists({ passengerId: trip.passengerId, status: 'active', _id: { $ne: trip._id } });
    if (vehicleBusy || passengerBusy) throw new ConflictError('An active trip already exists for that passenger or vehicle');
    trip.status = 'active';
    trip.startedAt = trip.startedAt ?? new Date();
    trip.endedAt = null;
  } else if (next === 'completed' || next === 'interrupted' || next === 'cancelled') {
    if (trip.status !== 'active' && !(next === 'cancelled' && trip.status === 'scheduled')) {
      throw new ConflictError('That trip cannot change to the requested status');
    }
    trip.status = next;
    trip.endedAt = new Date();
  }
  await trip.save();
  const presented = await presentTrip(trip, user);
  const users = [trip.passengerId.toString(), ...trip.authorizedGuardianIds.map((id) => id.toString())];
  const payload = {
    tripId: trip.id,
    status: mobileStatus(trip.status),
    canonicalStatus: trip.status,
    etaMinutes: null,
    progress: null,
    etaAvailability: 'not_configured',
    routingAvailability: 'not_configured',
  };
  publishToUsers(users, 'trip:status', payload);
  publishToTrip(trip.id, 'trip:status', payload);
  return presented;
}

export async function tripLocations(user: AuthenticatedUser, tripId: string, cursorRaw: string | undefined, limit: number) {
  const trip = await assertTripAccess(user, tripId, 'trip.locations');
  if (!(await canSeeLocation(user, trip))) throw new AppError(403, 'LOCATION_NOT_SHARED', 'Location sharing is not granted for this trip');
  const cursor = parseCursor(cursorRaw);
  if (cursorRaw && !cursor) throw new AppError(422, 'VALIDATION_ERROR', 'cursor: is invalid');
  const docs = await listLocations(trip, cursor, limit);
  const page = docs.slice(0, limit);
  const last = page[0];
  const movement = assessMovement({
    speedKph: trip.lastSpeedKph,
    recordedAt: trip.lastLocationAt,
    staleAfterSeconds: getConfig().location.staleAfterSeconds,
    movingSpeedKph: getConfig().location.movingSpeedKph,
  });
  const next = docs.length > limit ? page[page.length - 1] : null;
  return {
    items: page.map(presentPoint),
    nextCursor: next ? encodeCursor(next.recordedAt, next.id) : null,
    lastLocationAt: trip.lastLocationAt,
    lastLocationSource: trip.lastLocationSource,
    stale: movement.stale,
    movement: movement.movement,
    isMoving: movement.isMoving,
    latestPointAt: last?.recordedAt ?? null,
  };
}

export async function tripEvents(user: AuthenticatedUser, tripId: string, cursorRaw: string | undefined, limit: number) {
  const trip = await assertTripAccess(user, tripId, 'trip.events');
  const cursor = parseCursor(cursorRaw);
  if (cursorRaw && !cursor) throw new AppError(422, 'VALIDATION_ERROR', 'cursor: is invalid');
  const query: FilterQuery<unknown> = { tripId: trip._id };
  if (cursor && Types.ObjectId.isValid(cursor.id)) {
    query.$or = [
      { occurredAt: { $lt: cursor.recordedAt } },
      { occurredAt: cursor.recordedAt, _id: { $lt: cursor.id } },
    ];
  }
  const docs = await SafetyEventModel.find(query).sort({ occurredAt: -1, _id: -1 }).limit(limit + 1);
  const page = docs.slice(0, limit);
  const next = docs.length > limit ? page[page.length - 1] : null;
  return {
    items: page.map((event) => ({
      id: event.id,
      eventId: event.eventId,
      tripId: event.tripId?.toString() ?? null,
      vehicleId: event.vehicleId?.toString() ?? null,
      eventType: event.eventType,
      severity: event.severity,
      source: event.source,
      demo: event.demo,
      occurredAt: event.occurredAt,
      locationUnavailable: event.locationUnavailable,
      latitude: event.latitude,
      longitude: event.longitude,
      acknowledgement: event.acknowledgement,
      review: event.review,
      processingStatus: event.processingStatus,
      inferenceSource: event.inferenceSource || null,
      modelConfidence: event.modelConfidence,
    })),
    nextCursor: next ? encodeCursor(next.occurredAt, next.id) : null,
  };
}

export async function tripRoute(user: AuthenticatedUser, tripId: string) {
  const trip = await assertTripAccess(user, tripId, 'trip.route');
  const visible = await canSeeLocation(user, trip);
  const points = visible
    ? await LocationPointModel.find({ tripId: trip._id }).sort({ recordedAt: 1, _id: 1 }).limit(2001)
    : [];
  const truncated = points.length > 2000;
  const shown = truncated ? points.slice(0, 2000) : points;
  return {
    tripId: trip.id,
    coordinates: shown.flatMap((point) => {
      const coordinates = point.location?.coordinates;
      if (!coordinates || coordinates.length < 2) return [];
      return [{
        latitude: coordinates[1],
        longitude: coordinates[0],
        recordedAt: point.recordedAt,
        source: point.source,
        demo: point.demo,
      }];
    }),
    truncated,
    encodedPolyline: null,
    eta: null,
    etaAvailability: 'not_configured' as const,
    routingAvailability: 'not_configured' as const,
    note: 'Coordinates are recorded GPS points only. No road-snapped route or ETA is generated.',
  };
}

export async function dashboard(user: AuthenticatedUser) {
  const passengerIds = user.role === 'guardian'
    ? (await grantedRelationshipsForGuardian(user.id)).map((item) => item.passengerId?.toString()).filter((id): id is string => Boolean(id))
    : [];
  const access = tripQueryFor(user, passengerIds);
  const trips = await TripModel.find(access).select('_id status lastLocationAt');
  const active = trips.filter((trip) => trip.status === 'active');
  const tripIds = trips.map((trip) => trip._id);
  const openIncidents = tripIds.length ? await IncidentModel.countDocuments({ tripId: { $in: tripIds }, status: { $in: ['open', 'acknowledged'] } }) : 0;
  const unacknowledgedEvents = tripIds.length
    ? await SafetyEventModel.countDocuments({ tripId: { $in: tripIds }, 'acknowledgement.acknowledged': false })
    : 0;
  const notificationsPending = await NotificationModel.countDocuments({ recipientId: user.id, status: { $in: ['queued', 'retry_scheduled', 'unavailable', 'simulated'] } });
  const freshest = active.reduce<Date | null>((latest, trip) => {
    if (!trip.lastLocationAt) return latest;
    if (!latest || trip.lastLocationAt > latest) return trip.lastLocationAt;
    return latest;
  }, null);
  const movement = assessMovement({
    speedKph: null,
    recordedAt: freshest,
    staleAfterSeconds: getConfig().location.staleAfterSeconds,
    movingSpeedKph: getConfig().location.movingSpeedKph,
  });
  const vehicleFilter = user.role === 'administrator' ? {} : { familyGroupId: user.familyGroupId ?? new Types.ObjectId() };
  const vehicles = user.role === 'passenger' ? 0 : await VehicleModel.countDocuments({ ...vehicleFilter, status: 'active' });
  return {
    familyGroupId: user.familyGroupId,
    activeTrips: active.length,
    vehicles,
    openIncidents,
    unacknowledgedEvents,
    notificationsPending,
    locationFreshness: active.length === 0 ? 'unknown' : movement.stale ? 'stale' : 'fresh',
    generatedAt: new Date().toISOString(),
    movementClaim: 'unknown',
  };
}

export async function presentTrip(trip: TripDocument, user: AuthenticatedUser) {
  const movement = assessMovement({
    speedKph: trip.lastSpeedKph,
    recordedAt: trip.lastLocationAt,
    staleAfterSeconds: getConfig().location.staleAfterSeconds,
    movingSpeedKph: getConfig().location.movingSpeedKph,
  });
  const visible = await canSeeLocation(user, trip);
  const [passenger, driver, vehicle] = await Promise.all([
    UserModel.findById(trip.passengerId),
    trip.driverId ? UserModel.findById(trip.driverId) : null,
    VehicleModel.findById(trip.vehicleId),
  ]);
  return {
    id: trip.id,
    passengerId: trip.passengerId.toString(),
    passengerName: passenger?.name ?? 'Unknown passenger',
    relationship: trip.relationshipLabel,
    vehicleId: trip.vehicleId.toString(),
    driverId: trip.driverId ? trip.driverId.toString() : null,
    authorizedGuardianIds: trip.authorizedGuardianIds.map((id) => id.toString()),
    origin: trip.origin,
    destination: trip.destination,
    status: trip.status,
    startedAt: trip.startedAt,
    endedAt: trip.endedAt,
    sharing: trip.sharing,
    demo: trip.demo,
    source: trip.source,
    lastLocationAt: visible ? trip.lastLocationAt : null,
    lastLocationSource: visible ? trip.lastLocationSource : null,
    movement: visible ? movement.movement : 'unknown',
    isMoving: visible ? movement.isMoving : false,
    locationStale: visible ? movement.stale : true,
    speedKph: visible && !movement.stale ? trip.lastSpeedKph : null,
    heading: visible && !movement.stale ? trip.lastHeading : null,
    latitude: visible ? trip.lastLatitude : null,
    longitude: visible ? trip.lastLongitude : null,
    coordinatesAreCurrent: Boolean(visible && !movement.stale && trip.lastLatitude != null),
    eta: null,
    etaAvailability: 'not_configured',
    routingAvailability: 'not_configured',
    driver: {
      id: driver?.id ?? null,
      name: driver?.name ?? 'Unassigned driver',
      vehicle: vehicle?.displayName ?? 'Unknown vehicle',
      plate: vehicle?.registrationIdentifier ?? '',
      rating: null,
    },
    updatedAt: trip.updatedAt,
  };
}

function presentPoint(point: LocationPointDocument) {
  const coordinates = point.location?.coordinates ?? [];
  return {
    id: point.id,
    latitude: coordinates[1],
    longitude: coordinates[0],
    speedKph: point.speedKph,
    heading: point.heading,
    accuracyMeters: point.accuracyMeters,
    recordedAt: point.recordedAt,
    source: point.source,
    demo: point.demo,
    sequence: point.sequence,
    eventId: point.eventId,
  };
}

export function mobileStatus(status: TripStatus): 'scheduled' | 'en_route' | 'paused' | 'arrived' | 'cancelled' {
  if (status === 'active') return 'en_route';
  if (status === 'completed') return 'arrived';
  if (status === 'interrupted') return 'paused';
  if (status === 'cancelled') return 'cancelled';
  return 'scheduled';
}

export async function toMobileTrip(trip: TripDocument, user: AuthenticatedUser) {
  const canonical = await presentTrip(trip, user);
  const route = canonical.coordinatesAreCurrent || canonical.lastLocationAt
    ? await LocationPointModel.find({ tripId: trip._id }).sort({ recordedAt: 1 }).limit(500)
    : [];
  return {
    id: canonical.id,
    passengerId: canonical.passengerId,
    passengerName: canonical.passengerName,
    relationship: canonical.relationship,
    origin: canonical.origin?.label ?? '',
    destination: canonical.destination?.label ?? '',
    status: mobileStatus(trip.status),
    canonicalStatus: trip.status,
    startedAt: (trip.startedAt ?? trip.createdAt).toISOString(),
    endedAt: trip.endedAt ? trip.endedAt.toISOString() : undefined,
    etaMinutes: null,
    progress: null,
    etaAvailability: 'not_configured',
    routingAvailability: 'not_configured',
    route: route.flatMap((point) => {
      const coordinates = point.location?.coordinates;
      if (!coordinates || coordinates.length < 2) return [];
      return [{ latitude: coordinates[1], longitude: coordinates[0] }];
    }),
    current: canonical.latitude != null && canonical.longitude != null
      ? { latitude: canonical.latitude, longitude: canonical.longitude }
      : null,
    speedKph: canonical.speedKph ?? 0,
    heading: canonical.heading ?? 0,
    locationStale: canonical.locationStale,
    isMoving: canonical.isMoving,
    driver: canonical.driver,
    consent: 'granted',
    simulated: canonical.demo,
    updatedAt: canonical.updatedAt,
    vehicleId: canonical.vehicleId,
  };
}
