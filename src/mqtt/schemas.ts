import { z } from 'zod';
import { EVENT_TYPES } from '../config/risk-rules';

const identity = {
  vehicleId: z.string().regex(/^[a-f\d]{24}$/i),
  deviceIdentity: z.string().trim().min(2).max(120),
  authToken: z.string().min(10).max(200),
  demo: z.boolean(),
};

const recordedAt = z.string().datetime({ offset: true }).or(z.string().datetime());

export const telemetrySchema = z.object({
  ...identity,
  tripId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  speedKph: z.number().min(0).max(400),
  heading: z.number().min(0).max(360),
  accuracyMeters: z.number().min(0).max(100000),
  recordedAt,
  sequence: z.number().int().nonnegative(),
  eventId: z.string().trim().min(4).max(120),
  source: z.enum(['vehicle_gps', 'mobile_gps', 'demo_gps']),
});

export const driverSafetySchema = z.object({
  ...identity,
  tripId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  eventId: z.string().trim().min(4).max(120),
  eventType: z.enum(['driver_fatigue', 'driver_distraction', 'speeding', 'harsh_braking', 'face_not_detected', 'camera_offline']),
  severity: z.enum(['info', 'warning', 'critical']),
  occurredAt: recordedAt,
  inferenceSource: z.string().trim().min(2).max(120),
  modelConfidence: z.number().min(0).max(1).optional(),
  modelName: z.string().max(120).optional(),
  modelVersion: z.string().max(64).optional(),
  latitude: z.number().gte(-90).lte(90).optional(),
  longitude: z.number().gte(-180).lte(180).optional(),
  source: z.enum(['device_inference', 'provider', 'demo']),
});

export const cabinSchema = z.object({
  ...identity,
  tripId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  eventId: z.string().trim().min(4).max(120),
  recordedAt,
  totalSeats: z.number().int().min(0).max(20),
  occupiedSeats: z.number().int().min(0).max(20),
  seats: z.array(z.object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(40),
    occupied: z.boolean(),
    role: z.enum(['driver', 'passenger', 'empty']).optional(),
  })).max(20).optional(),
  inferenceSource: z.string().trim().min(2).max(120),
  confidence: z.number().min(0).max(1).optional(),
  cameraAvailable: z.boolean(),
  modelAvailable: z.boolean(),
  source: z.enum(['device_inference', 'provider', 'demo']),
});

export const deviceStatusSchema = z.object({
  ...identity,
  eventId: z.string().trim().min(4).max(120),
  recordedAt,
  cameraConnected: z.boolean().nullable(),
  driverModelStatus: z.enum(['running', 'idle', 'unavailable', 'unknown']),
  cabinModelStatus: z.enum(['running', 'idle', 'unavailable', 'unknown']),
  displayStatus: z.enum(['online', 'offline', 'unknown']),
  firmwareVersion: z.string().max(64).optional(),
  mqttConnected: z.boolean(),
  source: z.enum(['device_status', 'demo']),
});

export const sosSchema = z.object({
  ...identity,
  eventId: z.string().trim().min(4).max(120),
  tripId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  occurredAt: recordedAt,
  latitude: z.number().gte(-90).lte(90).optional(),
  longitude: z.number().gte(-180).lte(180).optional(),
  accuracyMeters: z.number().min(0).optional(),
  source: z.enum(['device_button', 'demo']),
}).refine((value) => (value.latitude == null) === (value.longitude == null), {
  message: 'latitude and longitude must be supplied together',
});

export const topicPattern = /^vehicles\/([a-f\d]{24})\/(telemetry|safety|cabin|device-status|sos|commands)$/i;

export type MqttTopicKind = 'telemetry' | 'safety' | 'cabin' | 'device-status' | 'sos' | 'commands';

export function parseTopic(topic: string): { vehicleId: string; kind: MqttTopicKind } | null {
  const match = topicPattern.exec(topic);
  if (!match?.[1] || !match[2]) return null;
  return { vehicleId: match[1], kind: match[2].toLowerCase() as MqttTopicKind };
}

export function assertPayloadVehicle(topicVehicleId: string, payloadVehicleId: string): void {
  if (topicVehicleId.toLowerCase() !== payloadVehicleId.toLowerCase()) {
    throw new Error('payload vehicleId does not match the topic');
  }
}

export const driverEventTypes = EVENT_TYPES;
