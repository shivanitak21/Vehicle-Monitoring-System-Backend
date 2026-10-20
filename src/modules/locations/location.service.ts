import { Types } from 'mongoose';
import { getConfig } from '../../config/env';
import { AppError, isDuplicateKey } from '../../common/errors/app-error';
import { assertFreshTimestamp } from '../../common/utils/movement';
import { FamilyRelationshipModel } from '../../models/family';
import { LocationPointModel } from '../../models/location';
import { TripModel, type TripDocument } from '../../models/trip';
import type { DeviceDocument } from '../../models/vehicle';
import { publishToTrip, publishToUsers } from '../../realtime/publisher';

export type LocationSource = 'vehicle_gps' | 'mobile_gps' | 'demo_gps';

export type IngestLocationInput = {
  vehicleId: string;
  tripId?: string;
  device?: DeviceDocument;
  latitude: number;
  longitude: number;
  speedKph: number;
  heading: number;
  accuracyMeters: number;
  recordedAt: Date;
  source: LocationSource;
  demo: boolean;
  sequence: number;
  eventId: string;
};

function assertDemoPairing(demo: boolean, source: string): void {
  const config = getConfig();
  if (demo && !config.demo.enabled) throw new AppError(403, 'DEMO_REJECTED', 'Demo location data is disabled');
  if (demo && source !== 'demo_gps') throw new AppError(422, 'SOURCE_MISMATCH', 'Demo locations must use source demo_gps');
  if (!demo && source === 'demo_gps') throw new AppError(422, 'SOURCE_MISMATCH', 'Hardware locations cannot use a demo source');
}

export async function ingestLocation(input: IngestLocationInput) {
  assertDemoPairing(input.demo, input.source);
  try {
    assertFreshTimestamp(input.recordedAt, new Date(), getConfig().location.maxAgeSeconds, getConfig().location.maxFutureSkewSeconds);
  } catch (error) {
    throw new AppError(422, 'STALE_TIMESTAMP', error instanceof Error ? error.message : 'Invalid timestamp');
  }
  const trip = await resolveTrip(input.vehicleId, input.tripId);
  if (trip.demo !== input.demo) {
    throw new AppError(409, 'SOURCE_MISMATCH', 'Demo and hardware locations cannot be written to the same trip');
  }
  if (input.device && input.device.vehicleId.toString() !== trip.vehicleId.toString()) {
    throw new AppError(403, 'DEVICE_TOPIC_MISMATCH', 'Authenticated device cannot publish for that vehicle');
  }
  try {
    const point = await LocationPointModel.create({
      tripId: trip._id,
      vehicleId: trip.vehicleId,
      deviceId: input.device?._id,
      location: { type: 'Point', coordinates: [input.longitude, input.latitude] },
      speedKph: input.speedKph,
      heading: input.heading,
      accuracyMeters: input.accuracyMeters,
      recordedAt: input.recordedAt,
      receivedAt: new Date(),
      source: input.source,
      demo: input.demo,
      sequence: input.sequence,
      eventId: input.eventId,
    });
    await applyLatest(trip, input);
    await broadcast(trip, input);
    return { duplicate: false, point, trip };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const point = await LocationPointModel.findOne({ eventId: input.eventId });
    return { duplicate: true, point, trip };
  }
}

async function resolveTrip(vehicleId: string, tripId?: string): Promise<TripDocument> {
  if (!Types.ObjectId.isValid(vehicleId)) throw new AppError(404, 'NOT_FOUND', 'Vehicle not found');
  if (tripId) {
    if (!Types.ObjectId.isValid(tripId)) throw new AppError(404, 'NOT_FOUND', 'Trip not found');
    const trip = await TripModel.findById(tripId);
    if (!trip) throw new AppError(404, 'NOT_FOUND', 'Trip not found');
    if (trip.vehicleId.toString() !== vehicleId) throw new AppError(409, 'TRIP_VEHICLE_MISMATCH', 'Trip does not belong to that vehicle');
    if (trip.status !== 'active') throw new AppError(409, 'TRIP_NOT_ACTIVE', 'Location can only be recorded for an active trip');
    return trip;
  }
  const trip = await TripModel.findOne({ vehicleId, status: 'active' });
  if (!trip) throw new AppError(409, 'NO_ACTIVE_TRIP', 'No active trip is available for that vehicle');
  return trip;
}

async function applyLatest(trip: TripDocument, input: IngestLocationInput): Promise<void> {
  if (trip.lastLocationAt && trip.lastLocationAt.getTime() > input.recordedAt.getTime()) return;
  trip.lastLocationAt = input.recordedAt;
  trip.lastLocationSource = input.source;
  trip.lastSpeedKph = input.speedKph;
  trip.lastHeading = input.heading;
  trip.lastAccuracyMeters = input.accuracyMeters;
  trip.lastLatitude = input.latitude;
  trip.lastLongitude = input.longitude;
  trip.staleAlertActive = false;
  await trip.save();
}

async function audience(trip: TripDocument): Promise<string[]> {
  const ids = new Set<string>([trip.passengerId.toString()]);
  if (trip.driverId) ids.add(trip.driverId.toString());
  if (!trip.sharing?.shareLocation) return [...ids];
  const relationships = await FamilyRelationshipModel.find({
    passengerId: trip.passengerId,
    consentStatus: 'granted',
    revokedAt: null,
  });
  for (const relationship of relationships) {
    const guardianId = relationship.guardianId.toString();
    const listed = trip.authorizedGuardianIds.some((id) => id.toString() === guardianId);
    if (listed && relationship.permissions.viewLocation && relationship.sharingLocation) ids.add(guardianId);
  }
  return [...ids];
}

async function broadcast(trip: TripDocument, input: IngestLocationInput): Promise<void> {
  const payload = {
    vehicleId: trip.vehicleId.toString(),
    tripId: trip.id,
    latitude: input.latitude,
    longitude: input.longitude,
    speedKph: input.speedKph,
    heading: input.heading,
    accuracyMeters: input.accuracyMeters,
    recordedAt: input.recordedAt.toISOString(),
    source: input.source,
    demo: input.demo,
  };
  const mobile = {
    tripId: trip.id,
    latitude: input.latitude,
    longitude: input.longitude,
    speedKph: input.speedKph,
    heading: input.heading,
    updatedAt: input.recordedAt.toISOString(),
    source: input.source,
    demo: input.demo,
  };
  const users = await audience(trip);
  publishToUsers(users, 'location:update', payload);
  publishToUsers(users, 'trip:location', mobile);
  publishToTrip(trip.id, 'location:update', payload);
  publishToTrip(trip.id, 'trip:location', mobile);
}

export async function listLocations(trip: TripDocument, cursor: { recordedAt: Date; id: string } | null, limit: number) {
  const query: Record<string, unknown> = { tripId: trip._id };
  if (cursor && Types.ObjectId.isValid(cursor.id)) {
    query.$or = [
      { recordedAt: { $lt: cursor.recordedAt } },
      { recordedAt: cursor.recordedAt, _id: { $lt: cursor.id } },
    ];
  }
  const docs = await LocationPointModel.find(query).sort({ recordedAt: -1, _id: -1 }).limit(limit + 1);
  return docs;
}
