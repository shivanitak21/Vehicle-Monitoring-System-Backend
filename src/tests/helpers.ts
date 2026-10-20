import request from 'supertest';
import { createApp } from '../app';
import type { AuthenticatedUser } from '../common/middleware/authenticate';
import { FamilyRelationshipModel } from '../models/family';
import { UserModel } from '../models/user';

export const app = createApp();

export async function registerUser(input: { name: string; email: string; password?: string; role: 'guardian' | 'passenger' }) {
  const response = await request(app).post('/api/v1/auth/register').send({
    name: input.name,
    email: input.email,
    password: input.password ?? 'password123',
    role: input.role,
  });
  if (response.status !== 201) {
    throw new Error(`register failed ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body as {
    token: string;
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string; role: string; familyGroupId: string | null; name: string };
  };
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export async function asUser(userId: string): Promise<AuthenticatedUser> {
  const user = await UserModel.findById(userId);
  if (!user) throw new Error('user missing');
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
    familyGroupId: user.familyGroupId ? user.familyGroupId.toString() : null,
  };
}

export async function linkGrantedPassenger(guardianToken: string, passenger: { id: string; email: string; name: string }) {
  const created = await request(app)
    .post('/api/v1/family/members')
    .set(auth(guardianToken))
    .send({ name: passenger.name, relationship: 'child', phone: '5551234567', role: 'passenger', email: passenger.email });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const passengerUser = await asUser(passenger.id);
  const { setConsent } = await import('../modules/family/family.service');
  await setConsent(passengerUser, created.body.id, { status: 'granted', sharingLocation: true });
  await UserModel.updateOne({ _id: passenger.id }, { $set: { 'privacy.cameraEvidence': true, 'privacy.speechMonitoring': true } });
  return created.body.id as string;
}

export async function createStartedTrip(guardianToken: string, passengerId: string) {
  const vehicle = await request(app).post('/api/v1/vehicles').set(auth(guardianToken)).send({
    displayName: 'Family Van',
    registrationIdentifier: `VAN${Math.floor(Math.random() * 9000 + 1000)}`,
  });
  if (vehicle.status !== 201) throw new Error(JSON.stringify(vehicle.body));
  const device = await request(app).post(`/api/v1/vehicles/${vehicle.body.id}/devices`).set(auth(guardianToken)).send({
    deviceType: 'combined',
    deviceIdentity: `device-${vehicle.body.id}`,
  });
  if (device.status !== 201) throw new Error(JSON.stringify(device.body));
  const trip = await request(app).post('/api/v1/trips').set(auth(guardianToken)).send({
    passengerId,
    vehicleId: vehicle.body.id,
    origin: { label: 'Home' },
    destination: { label: 'School' },
    sharing: { shareLocation: true, shareMedia: true },
  });
  if (trip.status !== 201) throw new Error(JSON.stringify(trip.body));
  const started = await request(app).post(`/api/v1/trips/${trip.body.id}/start`).set(auth(guardianToken));
  if (started.status !== 200) throw new Error(JSON.stringify(started.body));
  return { vehicle: vehicle.body, device: device.body, ingestKey: device.body.ingestKey as string, trip: started.body };
}

export async function grantedCount() {
  return FamilyRelationshipModel.countDocuments({ consentStatus: 'granted' });
}
