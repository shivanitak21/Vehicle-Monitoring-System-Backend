import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, auth, createStartedTrip, linkGrantedPassenger, registerUser } from './helpers';
import { setConsent } from '../modules/family/family.service';
import { asUser } from './helpers';

describe('trip authorization', () => {
  it('hides another family trip and honors consent revocation', async () => {
    const guardian = await registerUser({ name: 'Guardian A', email: 'a@example.com', role: 'guardian' });
    const passenger = await registerUser({ name: 'Passenger A', email: 'pa@example.com', role: 'passenger' });
    const other = await registerUser({ name: 'Guardian B', email: 'b@example.com', role: 'guardian' });
    const relationshipId = await linkGrantedPassenger(guardian.token, passenger.user);
    const { trip } = await createStartedTrip(guardian.token, passenger.user.id);

    const allowed = await request(app).get(`/api/v1/trips/${trip.id}`).set(auth(guardian.token));
    expect(allowed.status).toBe(200);

    const denied = await request(app).get(`/api/v1/trips/${trip.id}`).set(auth(other.token));
    expect(denied.status).toBe(404);

    await setConsent(await asUser(guardian.user.id), relationshipId, { status: 'revoked' });
    const revoked = await request(app).get(`/api/v1/trips/${trip.id}`).set(auth(guardian.token));
    expect(revoked.status).toBe(404);

    const passengerView = await request(app).get(`/api/v1/trips/${trip.id}`).set(auth(passenger.token));
    expect(passengerView.status).toBe(200);
  });
});
