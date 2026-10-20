import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { assessMovement } from '../common/utils/movement';
import { TripModel } from '../models/trip';
import { app, auth, createStartedTrip, linkGrantedPassenger, registerUser } from './helpers';

describe('gps validation and staleness', () => {
  it('does not treat stale coordinates as current movement', () => {
    const result = assessMovement({
      speedKph: 88,
      recordedAt: new Date(Date.now() - 120_000),
      staleAfterSeconds: 45,
      movingSpeedKph: 3,
    });
    expect(result.isMoving).toBe(false);
    expect(result.movement).toBe('unknown');
    expect(result.stale).toBe(true);
  });

  it('rejects invalid and stale live points and reports stale vehicle status', async () => {
    const guardian = await registerUser({ name: 'Geo Guardian', email: 'geo@example.com', role: 'guardian' });
    const passenger = await registerUser({ name: 'Geo Passenger', email: 'geop@example.com', role: 'passenger' });
    await linkGrantedPassenger(guardian.token, passenger.user);
    const { vehicle, device, ingestKey, trip } = await createStartedTrip(guardian.token, passenger.user.id);
    const headers = { 'x-device-identity': device.device.deviceIdentity, 'x-device-key': ingestKey };
    const base = {
      vehicleId: vehicle.id,
      tripId: trip.id,
      latitude: 12.97,
      longitude: 77.59,
      speedKph: 40,
      heading: 90,
      accuracyMeters: 5,
      sequence: 1,
      eventId: 'gps-1',
      source: 'vehicle_gps',
      demo: false,
      recordedAt: new Date().toISOString(),
    };

    const invalid = await request(app).post('/api/v1/devices/telemetry').set(headers).send({ ...base, latitude: 123 });
    expect(invalid.status).toBe(422);

    const stale = await request(app).post('/api/v1/devices/telemetry').set(headers).send({
      ...base,
      eventId: 'gps-old',
      recordedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    expect(stale.status).toBe(422);

    const stored = await request(app).post('/api/v1/devices/telemetry').set(headers).send(base);
    expect(stored.status).toBe(201);

    await TripModel.updateOne({ _id: trip.id }, { $set: { lastLocationAt: new Date(Date.now() - 5 * 60 * 1000), lastSpeedKph: 70 } });
    const status = await request(app).get(`/api/v1/vehicles/${vehicle.id}/status`).set(auth(guardian.token));
    expect(status.status).toBe(200);
    expect(status.body.isMoving).toBe(false);
    expect(status.body.movement).toBe('unknown');
    expect(status.body.locationStale).toBe(true);
    expect(status.body.speedKph).toBeNull();

    const route = await request(app).get(`/api/v1/trips/${trip.id}/route`).set(auth(guardian.token));
    expect(route.body.eta).toBeNull();
    expect(route.body.routingAvailability).toBe('not_configured');
    expect(route.body.coordinates).toHaveLength(1);
  });
});
