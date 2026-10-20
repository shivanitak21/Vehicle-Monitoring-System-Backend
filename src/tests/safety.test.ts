import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { assessRisk } from '../config/risk-rules';
import { IncidentModel } from '../models/incident';
import { NotificationModel } from '../models/notification';
import { processNotificationQueue } from '../modules/notifications/notification.service';
import { app, auth, createStartedTrip, linkGrantedPassenger, registerUser } from './helpers';

describe('safety events and sos', () => {
  it('does not invent a safety score when there are no signals', () => {
    const assessment = assessRisk({
      rulesVersion: '2026.1',
      threshold: 40,
      signals: [],
      hasFreshLocation: false,
      hasAnyLocation: false,
      deviceOffline: false,
      locationStale: false,
    });
    expect(assessment.state).toBe('unknown');
    expect(assessment.observedScore).toBeNull();
    expect(assessment.explanation.toLowerCase()).toContain('not a determination');
  });

  it('stores one sos, alerts only the authorized guardian, and deduplicates', async () => {
    const guardian = await registerUser({ name: 'Alert Guardian', email: 'alert@example.com', role: 'guardian' });
    const passenger = await registerUser({ name: 'Alert Passenger', email: 'alertp@example.com', role: 'passenger' });
    const outsider = await registerUser({ name: 'Other Guardian', email: 'other@example.com', role: 'guardian' });
    await linkGrantedPassenger(guardian.token, passenger.user);
    const { trip } = await createStartedTrip(guardian.token, passenger.user.id);

    const first = await request(app).post('/api/v1/safety/sos').set(auth(passenger.token)).send({ tripId: trip.id, eventId: 'sos-001' });
    expect(first.status).toBe(201);
    expect(first.body.locationUnavailable).toBe(true);
    expect(first.body.coordinate).toBeNull();
    expect(await IncidentModel.countDocuments({ primaryEventId: 'sos-001' })).toBe(1);

    const second = await request(app).post('/api/v1/safety/sos').set(auth(passenger.token)).send({ tripId: trip.id, eventId: 'sos-001' });
    expect(second.status).toBe(200);
    expect(await IncidentModel.countDocuments({ primaryEventId: 'sos-001' })).toBe(1);

    const notes = await NotificationModel.find({ eventId: 'sos-001' });
    expect(notes.every((note) => note.recipientId.toString() === guardian.user.id)).toBe(true);
    expect(notes.some((note) => note.recipientId.toString() === outsider.user.id)).toBe(false);
    expect(notes.some((note) => note.body.includes('Location is unavailable'))).toBe(true);

    await processNotificationQueue();
    const push = await NotificationModel.findOne({ eventId: 'sos-001', channel: 'push' });
    expect(push?.status).toBe('unavailable');
    expect(push?.status).not.toBe('provider_accepted');

    const hidden = await request(app).get(`/api/v1/incidents/${first.body.id}`).set(auth(outsider.token));
    expect(hidden.status).toBe(404);
  });
});
