import { Types } from 'mongoose';
import { getConfig } from '../../config/env';
import { AppError, NotFoundError, isDuplicateKey } from '../../common/errors/app-error';
import type { AuthenticatedUser } from '../../common/middleware/authenticate';
import { newId, newOpaqueToken, sha256, safeEqualHex } from '../../common/utils/crypto';
import { assessMovement } from '../../common/utils/movement';
import { DeviceCommandModel } from '../../models/notification';
import { TripModel } from '../../models/trip';
import { DeviceModel, VehicleModel, type DeviceDocument, type VehicleDocument } from '../../models/vehicle';
import { assertVehicleAccess } from '../access/access.service';
import { publishMqtt, isMqttConnected } from '../../mqtt/publisher';

const COMMAND_TYPES = ['request_status', 'display_text', 'set_brightness', 'acknowledge_alarm'] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export async function authenticateDevice(identity: string, key: string): Promise<DeviceDocument> {
  const device = await DeviceModel.findOne({ deviceIdentity: identity, status: 'active' }).select('+ingestKeyHash');
  if (!device || !safeEqualHex(sha256(key), device.ingestKeyHash)) {
    throw new AppError(401, 'DEVICE_UNAUTHORIZED', 'Device authentication failed');
  }
  return device;
}

export async function assertDeviceVehicle(device: DeviceDocument, vehicleId: string): Promise<void> {
  if (device.vehicleId.toString() !== vehicleId) {
    throw new AppError(403, 'DEVICE_TOPIC_MISMATCH', 'Authenticated device cannot publish for that vehicle');
  }
}

export function toVehicle(vehicle: VehicleDocument) {
  return {
    id: vehicle.id,
    familyGroupId: vehicle.familyGroupId.toString(),
    ownerId: vehicle.ownerId.toString(),
    displayName: vehicle.displayName,
    registrationIdentifier: vehicle.registrationIdentifier,
    assignedDriverId: vehicle.assignedDriverId ? vehicle.assignedDriverId.toString() : null,
    status: vehicle.status,
    demo: vehicle.demo,
    createdAt: vehicle.createdAt,
    updatedAt: vehicle.updatedAt,
  };
}

export function toDevice(device: DeviceDocument) {
  return {
    id: device.id,
    vehicleId: device.vehicleId.toString(),
    deviceType: device.deviceType,
    deviceIdentity: device.deviceIdentity,
    mqttUsername: device.mqttUsername,
    firmwareVersion: device.firmwareVersion,
    lastHeartbeatAt: device.lastHeartbeatAt,
    cameraConnected: device.cameraConnected,
    driverModelStatus: device.driverModelStatus,
    cabinModelStatus: device.cabinModelStatus,
    displayStatus: device.displayStatus,
    mqttConnected: device.mqttConnected,
    status: device.status,
    demo: device.demo,
  };
}

export async function createVehicle(user: AuthenticatedUser, input: {
  displayName: string;
  registrationIdentifier: string;
  assignedDriverId?: string | null;
  demo?: boolean;
}) {
  if (!user.familyGroupId || (user.role !== 'guardian' && user.role !== 'administrator')) {
    throw new AppError(403, 'FORBIDDEN', 'Only a guardian can register a vehicle');
  }
  if (input.demo && !getConfig().demo.enabled) throw new AppError(403, 'DEMO_REJECTED', 'Demo vehicles are disabled');
  try {
    const vehicle = await VehicleModel.create({
      familyGroupId: user.familyGroupId,
      ownerId: user.id,
      displayName: input.displayName,
      registrationIdentifier: input.registrationIdentifier.toUpperCase(),
      assignedDriverId: input.assignedDriverId && Types.ObjectId.isValid(input.assignedDriverId) ? input.assignedDriverId : null,
      demo: Boolean(input.demo),
      status: 'active',
    });
    return toVehicle(vehicle);
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(409, 'CONFLICT', 'A vehicle with that registration already exists in this family');
    throw error;
  }
}

export async function listVehicles(user: AuthenticatedUser) {
  const filter = user.role === 'administrator' ? {} : { familyGroupId: user.familyGroupId ?? '__none__' };
  if (user.role === 'passenger') {
    throw new AppError(403, 'FORBIDDEN', 'Passengers can read a vehicle from an authorized trip');
  }
  const vehicles = await VehicleModel.find(filter).sort({ createdAt: -1 }).limit(100);
  return vehicles.map(toVehicle);
}

export async function getVehicle(user: AuthenticatedUser, vehicleId: string) {
  return toVehicle(await assertVehicleAccess(user, vehicleId, 'read'));
}

export async function updateVehicle(user: AuthenticatedUser, vehicleId: string, input: {
  displayName?: string;
  registrationIdentifier?: string;
  assignedDriverId?: string | null;
  status?: 'active' | 'inactive' | 'maintenance';
}) {
  const vehicle = await assertVehicleAccess(user, vehicleId, 'write');
  if (input.displayName) vehicle.displayName = input.displayName;
  if (input.registrationIdentifier) vehicle.registrationIdentifier = input.registrationIdentifier.toUpperCase();
  if (input.assignedDriverId !== undefined) {
    vehicle.assignedDriverId = input.assignedDriverId && Types.ObjectId.isValid(input.assignedDriverId)
      ? new Types.ObjectId(input.assignedDriverId)
      : null;
  }
  if (input.status) vehicle.status = input.status;
  await vehicle.save();
  return toVehicle(vehicle);
}

export async function removeVehicle(user: AuthenticatedUser, vehicleId: string) {
  const vehicle = await assertVehicleAccess(user, vehicleId, 'write');
  vehicle.status = 'inactive';
  await vehicle.save();
}

export async function createDevice(user: AuthenticatedUser, vehicleId: string, input: {
  deviceType: 'vehicle_unit' | 'driver_camera' | 'cabin_camera' | 'display' | 'combined';
  deviceIdentity: string;
  firmwareVersion?: string;
  mqttUsername?: string;
  demo?: boolean;
}) {
  const vehicle = await assertVehicleAccess(user, vehicleId, 'write');
  if ((input.demo || vehicle.demo) && !getConfig().demo.enabled && input.demo) {
    throw new AppError(403, 'DEMO_REJECTED', 'Demo devices are disabled');
  }
  const ingestKey = newOpaqueToken();
  try {
    const device = await DeviceModel.create({
      vehicleId: vehicle._id,
      familyGroupId: vehicle.familyGroupId,
      deviceType: input.deviceType,
      deviceIdentity: input.deviceIdentity,
      ingestKeyHash: sha256(ingestKey),
      mqttUsername: input.mqttUsername || input.deviceIdentity,
      firmwareVersion: input.firmwareVersion ?? '',
      demo: vehicle.demo || Boolean(input.demo),
      status: 'active',
    });
    return { device: toDevice(device), ingestKey };
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(409, 'CONFLICT', 'That device identity is already registered');
    throw error;
  }
}

export async function listDevices(user: AuthenticatedUser, vehicleId: string) {
  await assertVehicleAccess(user, vehicleId, 'read');
  const devices = await DeviceModel.find({ vehicleId });
  return devices.map(toDevice);
}

export async function rotateDeviceKey(user: AuthenticatedUser, vehicleId: string, deviceId: string) {
  await assertVehicleAccess(user, vehicleId, 'write');
  if (!Types.ObjectId.isValid(deviceId)) throw new NotFoundError('Device not found');
  const device = await DeviceModel.findOne({ _id: deviceId, vehicleId }).select('+ingestKeyHash');
  if (!device) throw new NotFoundError('Device not found');
  const ingestKey = newOpaqueToken();
  device.ingestKeyHash = sha256(ingestKey);
  await device.save();
  return { device: toDevice(device), ingestKey };
}

export async function vehicleStatus(user: AuthenticatedUser, vehicleId: string) {
  const vehicle = await assertVehicleAccess(user, vehicleId, 'read');
  return buildStatus(vehicle);
}

export async function vehicleTelemetry(user: AuthenticatedUser, vehicleId: string) {
  const vehicle = await assertVehicleAccess(user, vehicleId, 'read');
  const devices = await DeviceModel.find({ vehicleId: vehicle._id });
  const status = await buildStatus(vehicle);
  return { ...status, devices: devices.map(toDevice) };
}

async function buildStatus(vehicle: VehicleDocument) {
  const config = getConfig();
  const trip = await TripModel.findOne({ vehicleId: vehicle._id, status: 'active' }).sort({ startedAt: -1 });
  const device = await DeviceModel.findOne({ vehicleId: vehicle._id, status: 'active' }).sort({ lastHeartbeatAt: -1 });
  const movement = assessMovement({
    speedKph: trip?.lastSpeedKph,
    recordedAt: trip?.lastLocationAt,
    staleAfterSeconds: config.location.staleAfterSeconds,
    movingSpeedKph: config.location.movingSpeedKph,
  });
  const heartbeatAge = device?.lastHeartbeatAt ? (Date.now() - device.lastHeartbeatAt.getTime()) / 1000 : null;
  const offline = heartbeatAge === null || heartbeatAge > config.location.deviceOfflineAfterSeconds;
  return {
    vehicleId: vehicle.id,
    displayName: vehicle.displayName,
    registrationIdentifier: vehicle.registrationIdentifier,
    vehicleStatus: vehicle.status,
    connectivity: !device?.lastHeartbeatAt ? 'unknown' : offline ? 'offline' : movement.stale ? 'stale' : 'online',
    movement: movement.movement,
    isMoving: movement.isMoving,
    locationStale: movement.stale,
    lastLocationAt: trip?.lastLocationAt ?? null,
    lastLocationSource: trip?.lastLocationSource ?? null,
    speedKph: movement.stale ? null : trip?.lastSpeedKph ?? null,
    heading: movement.stale ? null : trip?.lastHeading ?? null,
    latitude: movement.stale ? trip?.lastLatitude ?? null : trip?.lastLatitude ?? null,
    longitude: trip?.lastLongitude ?? null,
    coordinatesCurrent: movement.stale ? false : trip?.lastLatitude != null,
    activeTripId: trip?.id ?? null,
    device: device ? toDevice(device) : null,
    demo: vehicle.demo,
  };
}

export async function issueCommand(user: AuthenticatedUser, vehicleId: string, input: { type: CommandType; payload: Record<string, unknown> }) {
  const vehicle = await assertVehicleAccess(user, vehicleId, 'write');
  const commandId = newId('cmd');
  const message = {
    commandId,
    vehicleId: vehicle.id,
    type: input.type,
    payload: input.payload,
    issuedAt: new Date().toISOString(),
    demo: vehicle.demo,
  };
  const record = await DeviceCommandModel.create({
    vehicleId: vehicle._id,
    commandId,
    type: input.type,
    payload: input.payload,
    issuedBy: user.id,
    status: 'queued',
    demo: vehicle.demo,
  });
  if (!isMqttConnected()) {
    record.status = 'failed';
    record.lastError = 'MQTT broker is not connected';
    await record.save();
    throw new AppError(503, 'MQTT_UNAVAILABLE', 'Command was stored as failed because the MQTT broker is not connected');
  }
  try {
    await publishMqtt(`vehicles/${vehicle.id}/commands`, message);
    record.status = 'published';
    await record.save();
  } catch (error) {
    record.status = 'failed';
    record.lastError = error instanceof Error ? error.message : 'publish failed';
    await record.save();
    throw new AppError(503, 'MQTT_UNAVAILABLE', 'Command could not be published to the vehicle');
  }
  return { commandId, status: record.status, type: record.type, demo: record.demo };
}

export { COMMAND_TYPES };
