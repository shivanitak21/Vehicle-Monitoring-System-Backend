import 'dotenv/config';
import mqtt from 'mqtt';
import { loadConfig } from '../config/env';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { TripModel } from '../models/trip';
import { DeviceModel, VehicleModel } from '../models/vehicle';

const ROUTE = [
  [37.7749, -122.4194],
  [37.7756, -122.4182],
  [37.7764, -122.4171],
  [37.7771, -122.416],
  [37.7764, -122.4148],
  [37.7752, -122.4156],
  [37.7749, -122.4194],
];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.isProduction || !config.demo.enabled) {
    throw new Error('The vehicle simulator is disabled. Set NODE_ENV=development and DEMO_ENABLED=true.');
  }
  if (!config.mqtt.enabled) throw new Error('MQTT_ENABLED must be true to publish simulated telemetry');
  if (!config.demo.deviceIngestKey) throw new Error('Set DEMO_DEVICE_INGEST_KEY to the seeded device ingest key');
  const speedKph = Number(arg('speed', '42'));
  const intervalMs = Number(arg('interval', '2000'));
  const sendSos = process.argv.includes('--sos');
  await connectDatabase();
  const vehicle = await VehicleModel.findOne({ registrationIdentifier: 'DEMO-001', demo: true });
  const trip = vehicle ? await TripModel.findOne({ vehicleId: vehicle._id, status: 'active', demo: true }) : null;
  const device = vehicle ? await DeviceModel.findOne({ vehicleId: vehicle._id, deviceIdentity: 'demo-device', demo: true }) : null;
  if (!vehicle || !trip || !device) {
    throw new Error('No active demo trip found. Run npm run seed first.');
  }
  const username = process.env.MQTT_DEVICE_USERNAME || 'demo-device';
  const password = process.env.MQTT_DEVICE_PASSWORD || '';
  const client = mqtt.connect(config.mqtt.url, { username, password, reconnectPeriod: 1000 });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });

  let index = 0;
  let sequence = 1;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  const publish = (topic: string, payload: unknown) => {
    client.publish(`vehicles/${vehicle.id}/${topic}`, JSON.stringify(payload), { qos: 1 });
  };

  const timer = setInterval(() => {
    const [latitude, longitude] = ROUTE[index % ROUTE.length]!;
    index += 1;
    const recordedAt = new Date().toISOString();
    publish('telemetry', {
      vehicleId: vehicle.id,
      deviceIdentity: device.deviceIdentity,
      authToken: config.demo.deviceIngestKey,
      tripId: trip.id,
      latitude,
      longitude,
      speedKph,
      heading: (index * 40) % 360,
      accuracyMeters: 8,
      recordedAt,
      sequence,
      eventId: `demo-gps-${trip.id}-${sequence}`,
      source: 'demo_gps',
      demo: true,
    });
    if (sequence % 5 === 0) {
      publish('device-status', {
        vehicleId: vehicle.id,
        deviceIdentity: device.deviceIdentity,
        authToken: config.demo.deviceIngestKey,
        eventId: `demo-heartbeat-${trip.id}-${sequence}`,
        recordedAt,
        cameraConnected: true,
        driverModelStatus: 'unavailable',
        cabinModelStatus: 'unavailable',
        displayStatus: 'unknown',
        firmwareVersion: 'demo-0',
        mqttConnected: true,
        source: 'demo',
        demo: true,
      });
      publish('cabin', {
        vehicleId: vehicle.id,
        deviceIdentity: device.deviceIdentity,
        authToken: config.demo.deviceIngestKey,
        tripId: trip.id,
        eventId: `demo-cabin-${trip.id}-${sequence}`,
        recordedAt,
        totalSeats: 4,
        occupiedSeats: 2,
        seats: [
          { id: 'driver', label: 'Driver', occupied: true, role: 'driver' },
          { id: 'front', label: 'Front passenger', occupied: true, role: 'passenger' },
          { id: 'rear-left', label: 'Rear left', occupied: false, role: 'empty' },
          { id: 'rear-right', label: 'Rear right', occupied: false, role: 'empty' },
        ],
        inferenceSource: 'simulated_cabin_model',
        confidence: 0.5,
        cameraAvailable: false,
        modelAvailable: false,
        source: 'demo',
        demo: true,
      });
      publish('safety', {
        vehicleId: vehicle.id,
        deviceIdentity: device.deviceIdentity,
        authToken: config.demo.deviceIngestKey,
        tripId: trip.id,
        eventId: `demo-fatigue-${trip.id}-${sequence}`,
        eventType: 'driver_fatigue',
        severity: 'warning',
        occurredAt: recordedAt,
        inferenceSource: 'simulated_driver_model',
        modelConfidence: 0.42,
        modelName: 'demo-driver-monitor',
        modelVersion: '0',
        source: 'demo',
        demo: true,
      });
    }
    if (sendSos && sequence === 3) {
      publish('sos', {
        vehicleId: vehicle.id,
        deviceIdentity: device.deviceIdentity,
        authToken: config.demo.deviceIngestKey,
        tripId: trip.id,
        eventId: `demo-sos-${trip.id}`,
        occurredAt: recordedAt,
        latitude,
        longitude,
        accuracyMeters: 8,
        source: 'demo',
        demo: true,
      });
    }
    sequence += 1;
    console.log(`published simulated point ${sequence - 1} demo=true`);
  }, intervalMs);

  console.log('Simulated vehicle publisher running. Press Ctrl+C to stop. Every event is marked demo=true.');
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
