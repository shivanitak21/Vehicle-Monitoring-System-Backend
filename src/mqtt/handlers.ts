import { logger } from '../config/logger';
import { AppError } from '../common/errors/app-error';
import { CabinSnapshotModel } from '../models/safety';
import { TripModel } from '../models/trip';
import { DeviceModel } from '../models/vehicle';
import { ingestLocation } from '../modules/locations/location.service';
import { loadTripForEvent, loadVehicle, recordSafetyEvent } from '../modules/safety/safety.service';
import { authenticateDevice, assertDeviceVehicle } from '../modules/vehicles/vehicle.service';
import { publishToTrip, publishToUsers } from '../realtime/publisher';
import {
  assertPayloadVehicle,
  cabinSchema,
  deviceStatusSchema,
  driverSafetySchema,
  parseTopic,
  sosSchema,
  telemetrySchema,
} from './schemas';

const buckets = new Map<string, { tokens: number; updatedAt: number }>();

export function allowTelemetry(deviceIdentity: string, now = Date.now()): boolean {
  const rate = 5;
  const capacity = 10;
  const current = buckets.get(deviceIdentity) ?? { tokens: capacity, updatedAt: now };
  const elapsed = (now - current.updatedAt) / 1000;
  current.tokens = Math.min(capacity, current.tokens + elapsed * rate);
  current.updatedAt = now;
  if (current.tokens < 1) {
    buckets.set(deviceIdentity, current);
    return false;
  }
  current.tokens -= 1;
  buckets.set(deviceIdentity, current);
  return true;
}

export async function handleMqttMessage(topic: string, payload: Buffer): Promise<void> {
  const parsedTopic = parseTopic(topic);
  if (!parsedTopic) {
    logger.warn({ topic }, 'ignored mqtt topic outside the vehicle contract');
    return;
  }
  if (parsedTopic.kind === 'commands') {
    logger.warn({ topic }, 'ignored command publish; devices cannot inject guardian commands');
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(payload.toString('utf8'));
  } catch {
    logger.error({ topic }, 'rejected mqtt payload that was not json');
    return;
  }
  try {
    if (parsedTopic.kind === 'telemetry') await handleTelemetry(topic, parsedTopic.vehicleId, body);
    if (parsedTopic.kind === 'safety') await handleSafety(parsedTopic.vehicleId, body);
    if (parsedTopic.kind === 'cabin') await handleCabin(parsedTopic.vehicleId, body);
    if (parsedTopic.kind === 'device-status') await handleStatus(parsedTopic.vehicleId, body);
    if (parsedTopic.kind === 'sos') await handleSos(parsedTopic.vehicleId, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'mqtt handler failed';
    logger.error({ topic, code: error instanceof AppError ? error.code : 'MQTT_HANDLER', message }, 'mqtt message rejected');
  }
}

async function authorize(vehicleId: string, deviceIdentity: string, authToken: string) {
  const device = await authenticateDevice(deviceIdentity, authToken);
  await assertDeviceVehicle(device, vehicleId);
  return device;
}

async function handleTelemetry(topic: string, vehicleId: string, body: unknown): Promise<void> {
  const payload = telemetrySchema.parse(body);
  assertPayloadVehicle(vehicleId, payload.vehicleId);
  const device = await authorize(vehicleId, payload.deviceIdentity, payload.authToken);
  if (!allowTelemetry(device.deviceIdentity)) {
    logger.warn({ vehicleId, deviceIdentity: device.deviceIdentity, reason: 'telemetry_rate_limited' }, 'telemetry message was not stored');
    return;
  }
  await ingestLocation({
    vehicleId,
    tripId: payload.tripId,
    device,
    latitude: payload.latitude,
    longitude: payload.longitude,
    speedKph: payload.speedKph,
    heading: payload.heading,
    accuracyMeters: payload.accuracyMeters,
    recordedAt: new Date(payload.recordedAt),
    source: payload.source,
    demo: payload.demo,
    sequence: payload.sequence,
    eventId: payload.eventId,
  });
  void topic;
}

async function handleSafety(vehicleId: string, body: unknown): Promise<void> {
  const payload = driverSafetySchema.parse(body);
  assertPayloadVehicle(vehicleId, payload.vehicleId);
  const device = await authorize(vehicleId, payload.deviceIdentity, payload.authToken);
  if (device.demo !== payload.demo) throw new AppError(422, 'SOURCE_MISMATCH', 'Device demo flag does not match the payload');
  const trip = payload.tripId ? await loadTripForEvent(payload.tripId) : await TripModel.findOne({ vehicleId, status: 'active' });
  const vehicle = await loadVehicle(vehicleId);
  await recordSafetyEvent({
    eventId: payload.eventId,
    eventType: payload.eventType,
    severity: payload.severity,
    source: payload.demo ? 'demo' : payload.source === 'demo' ? 'demo' : 'device_inference',
    demo: payload.demo,
    occurredAt: new Date(payload.occurredAt),
    trip,
    vehicle,
    latitude: payload.latitude ?? null,
    longitude: payload.longitude ?? null,
    inferenceSource: payload.inferenceSource,
    modelName: payload.modelName,
    modelVersion: payload.modelVersion,
    modelConfidence: payload.modelConfidence ?? null,
    payload: { reportedByDevice: device.deviceIdentity },
  });
}

async function handleSos(vehicleId: string, body: unknown): Promise<void> {
  const payload = sosSchema.parse(body);
  assertPayloadVehicle(vehicleId, payload.vehicleId);
  const device = await authorize(vehicleId, payload.deviceIdentity, payload.authToken);
  const trip = payload.tripId ? await loadTripForEvent(payload.tripId) : await TripModel.findOne({ vehicleId, status: 'active' });
  const vehicle = await loadVehicle(vehicleId);
  await recordSafetyEvent({
    eventId: payload.eventId,
    eventType: 'sos',
    severity: 'critical',
    source: payload.demo ? 'demo' : 'device_button',
    demo: payload.demo,
    occurredAt: new Date(payload.occurredAt),
    trip,
    vehicle,
    latitude: payload.latitude ?? null,
    longitude: payload.longitude ?? null,
    payload: { deviceIdentity: device.deviceIdentity },
  });
}

async function handleCabin(vehicleId: string, body: unknown): Promise<void> {
  const payload = cabinSchema.parse(body);
  assertPayloadVehicle(vehicleId, payload.vehicleId);
  const device = await authorize(vehicleId, payload.deviceIdentity, payload.authToken);
  if (device.demo !== payload.demo) throw new AppError(422, 'SOURCE_MISMATCH', 'Device demo flag does not match the payload');
  const trip = payload.tripId ? await loadTripForEvent(payload.tripId) : await TripModel.findOne({ vehicleId, status: 'active' });
  await CabinSnapshotModel.create({
    tripId: trip?._id ?? null,
    vehicleId,
    eventId: payload.eventId,
    recordedAt: new Date(payload.recordedAt),
    totalSeats: payload.totalSeats,
    occupiedSeats: payload.occupiedSeats,
    seats: payload.seats ?? [],
    inferenceSource: payload.inferenceSource,
    confidence: payload.confidence ?? null,
    cameraAvailable: payload.cameraAvailable,
    modelAvailable: payload.modelAvailable,
    demo: payload.demo,
    source: payload.demo ? 'demo' : payload.source,
  }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: number }).code === 11000) return null;
    throw error;
  });
  const previous = await CabinSnapshotModel.findOne({ vehicleId, eventId: { $ne: payload.eventId } }).sort({ recordedAt: -1 });
  if (previous && previous.occupiedSeats !== payload.occupiedSeats && trip) {
    await recordSafetyEvent({
      eventId: `occupancy_${payload.eventId}`,
      eventType: 'seat_occupancy_change',
      severity: 'info',
      source: payload.demo ? 'demo' : 'device_inference',
      demo: payload.demo,
      occurredAt: new Date(payload.recordedAt),
      trip,
      vehicle: await loadVehicle(vehicleId),
      inferenceSource: payload.inferenceSource,
      modelConfidence: payload.confidence ?? null,
      payload: { totalSeats: payload.totalSeats, occupiedSeats: payload.occupiedSeats, previousOccupied: previous.occupiedSeats },
    });
  }
  const audience = trip ? [trip.passengerId.toString(), ...trip.authorizedGuardianIds.map((id) => id.toString())] : [];
  const cabinPayload = {
    tripId: trip?.id ?? null,
    vehicleId,
    simulated: payload.demo,
    updatedAt: payload.recordedAt,
    seatCount: payload.totalSeats,
    occupiedSeats: payload.occupiedSeats,
    seats: payload.seats ?? [],
    camera: payload.cameraAvailable ? 'available' : 'unavailable',
    inference: payload.modelAvailable ? 'running' : 'unavailable',
    confidence: payload.confidence ?? null,
    inferenceSource: payload.inferenceSource,
    modelGenerated: false,
  };
  publishToUsers(audience, 'cabin:status', cabinPayload);
  if (trip) publishToTrip(trip.id, 'cabin:status', cabinPayload);
  if (trip) publishToUsers(audience, 'cabin:state', cabinPayload);
}

async function handleStatus(vehicleId: string, body: unknown): Promise<void> {
  const payload = deviceStatusSchema.parse(body);
  assertPayloadVehicle(vehicleId, payload.vehicleId);
  const device = await authorize(vehicleId, payload.deviceIdentity, payload.authToken);
  device.lastHeartbeatAt = new Date(payload.recordedAt);
  device.cameraConnected = payload.cameraConnected;
  device.driverModelStatus = payload.driverModelStatus;
  device.cabinModelStatus = payload.cabinModelStatus;
  device.displayStatus = payload.displayStatus;
  device.mqttConnected = payload.mqttConnected;
  if (payload.firmwareVersion) device.firmwareVersion = payload.firmwareVersion;
  await device.save();
  const trips = await TripModel.find({ vehicleId, status: 'active' });
  for (const trip of trips) {
    trip.offlineAlertActive = false;
    await trip.save();
  }
  const statusPayload = {
    vehicleId,
    deviceIdentity: device.deviceIdentity,
    recordedAt: payload.recordedAt,
    cameraConnected: payload.cameraConnected,
    driverModelStatus: payload.driverModelStatus,
    cabinModelStatus: payload.cabinModelStatus,
    displayStatus: payload.displayStatus,
    firmwareVersion: device.firmwareVersion,
    mqttConnected: payload.mqttConnected,
    demo: payload.demo,
    connectivity: 'online',
  };
  const users = trips.flatMap((trip) => [trip.passengerId.toString(), ...trip.authorizedGuardianIds.map((id) => id.toString())]);
  publishToUsers(users, 'vehicle:status', statusPayload);
  void DeviceModel;
}
