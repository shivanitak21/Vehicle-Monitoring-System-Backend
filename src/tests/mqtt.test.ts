import { describe, expect, it } from 'vitest';
import { handleMqttMessage } from '../mqtt/handlers';
import { assertPayloadVehicle, parseTopic, telemetrySchema } from '../mqtt/schemas';
import { LocationPointModel } from '../models/location';
import { createStartedTrip, linkGrantedPassenger, registerUser } from './helpers';

describe('mqtt contracts', () => {
  it('rejects invalid telemetry and mismatched vehicle ids', () => {
    const parsed = telemetrySchema.safeParse({
      vehicleId: 'a'.repeat(24),
      deviceIdentity: 'unit-1',
      authToken: 'secret-token-value',
      latitude: 200,
      longitude: 10,
      speedKph: 10,
      heading: 1,
      accuracyMeters: 1,
      recordedAt: new Date().toISOString(),
      sequence: 1,
      eventId: 'evt-1',
      source: 'vehicle_gps',
      demo: false,
    });
    expect(parsed.success).toBe(false);
    expect(parseTopic('vehicles/aaaaaaaaaaaaaaaaaaaaaaaa/telemetry')?.kind).toBe('telemetry');
    expect(parseTopic('vehicles/aaaaaaaaaaaaaaaaaaaaaaaa/commands')?.kind).toBe('commands');
    expect(() => assertPayloadVehicle('abc', 'def')).toThrow(/topic/);
  });

  it('does not store telemetry from an unauthorized device', async () => {
    const guardian = await registerUser({ name: 'Mqtt Guardian', email: 'mqtt@example.com', role: 'guardian' });
    const passenger = await registerUser({ name: 'Mqtt Passenger', email: 'mqttp@example.com', role: 'passenger' });
    await linkGrantedPassenger(guardian.token, passenger.user);
    const started = await createStartedTrip(guardian.token, passenger.user.id);
    const vehicleId = started.vehicle.id as string;
    await handleMqttMessage(
      `vehicles/${vehicleId}/telemetry`,
      Buffer.from(JSON.stringify({
        vehicleId,
        deviceIdentity: started.device.device.deviceIdentity,
        authToken: 'wrong-token-value',
        latitude: 12.9,
        longitude: 77.5,
        speedKph: 10,
        heading: 10,
        accuracyMeters: 4,
        recordedAt: new Date().toISOString(),
        sequence: 4,
        eventId: 'mqtt-unauth',
        source: 'vehicle_gps',
        demo: false,
      })),
    );
    expect(await LocationPointModel.countDocuments({ eventId: 'mqtt-unauth' })).toBe(0);

    await handleMqttMessage(
      `vehicles/${vehicleId}/telemetry`,
      Buffer.from(JSON.stringify({
        vehicleId,
        deviceIdentity: started.device.device.deviceIdentity,
        authToken: started.ingestKey,
        latitude: 12.9,
        longitude: 77.5,
        speedKph: 10,
        heading: 10,
        accuracyMeters: 4,
        recordedAt: new Date().toISOString(),
        sequence: 5,
        eventId: 'mqtt-ok',
        source: 'vehicle_gps',
        demo: false,
      })),
    );
    expect(await LocationPointModel.countDocuments({ eventId: 'mqtt-ok' })).toBe(1);

    await handleMqttMessage(
      `vehicles/${vehicleId}/commands`,
      Buffer.from(JSON.stringify({ commandId: 'nope', type: 'display_text' })),
    );
    expect(await LocationPointModel.countDocuments()).toBe(1);
  });
});
