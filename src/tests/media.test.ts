import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { reloadConfig } from '../config/env';
import { MediaAssetModel } from '../models/incident';
import { TripModel } from '../models/trip';
import { VehicleModel } from '../models/vehicle';
import { ingestLocation } from '../modules/locations/location.service';
import { app, auth, createStartedTrip, linkGrantedPassenger, registerUser } from './helpers';

describe('media, push configuration, and demo separation', () => {
  it('blocks other families and reports storage as unavailable', async () => {
    const guardian = await registerUser({ name: 'Media Guardian', email: 'media@example.com', role: 'guardian' });
    const passenger = await registerUser({ name: 'Media Passenger', email: 'mediap@example.com', role: 'passenger' });
    const outsider = await registerUser({ name: 'Media Outsider', email: 'mediao@example.com', role: 'guardian' });
    await linkGrantedPassenger(guardian.token, passenger.user);
    const { trip } = await createStartedTrip(guardian.token, passenger.user.id);
    const sos = await request(app).post('/api/v1/safety/sos').set(auth(passenger.token)).send({ tripId: trip.id, eventId: 'sos-media' });
    expect(sos.status).toBe(201);

    const denied = await request(app).post(`/api/v1/incidents/${sos.body.id}/media/upload-url`).set(auth(outsider.token)).send(uploadBody());
    expect(denied.status).toBe(404);

    const unavailable = await request(app).post(`/api/v1/incidents/${sos.body.id}/media/upload-url`).set(auth(passenger.token)).send(uploadBody());
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.code).toBe('STORAGE_UNAVAILABLE');
    expect(await MediaAssetModel.countDocuments()).toBe(0);
  });

  it('keeps demo locations off hardware trips', async () => {
    const guardian = await registerUser({ name: 'Demo Guardian', email: 'demo@example.com', role: 'guardian' });
    const passenger = await registerUser({ name: 'Demo Passenger', email: 'demop@example.com', role: 'passenger' });
    await linkGrantedPassenger(guardian.token, passenger.user);
    const started = await createStartedTrip(guardian.token, passenger.user.id);
    process.env.DEMO_ENABLED = 'true';
    reloadConfig();
    await expect(ingestLocation({
      vehicleId: started.vehicle.id,
      tripId: started.trip.id,
      latitude: 1,
      longitude: 2,
      speedKph: 10,
      heading: 10,
      accuracyMeters: 5,
      recordedAt: new Date(),
      source: 'demo_gps',
      demo: true,
      sequence: 1,
      eventId: 'demo-on-real',
    })).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
    process.env.DEMO_ENABLED = 'false';
    reloadConfig();

    const vehicle = await VehicleModel.findById(started.vehicle.id);
    const trip = await TripModel.findById(started.trip.id);
    expect(vehicle?.demo).toBe(false);
    expect(trip?.demo).toBe(false);
    expect(trip?.source).not.toBe('demo');
  });
});

function uploadBody() {
  return {
    fileName: 'cabin.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1200,
    mediaType: 'photo',
    capturedAt: new Date().toISOString(),
  };
}
