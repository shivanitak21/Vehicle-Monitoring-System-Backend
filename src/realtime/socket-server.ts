import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import { getConfig } from '../config/env';
import { logger } from '../config/logger';
import type { AuthenticatedUser } from '../common/middleware/authenticate';
import { readAccessToken } from '../common/middleware/authenticate';
import { assertTripAccess } from '../modules/access/access.service';
import { ingestLocation } from '../modules/locations/location.service';
import { setSocketServer } from './publisher';

const joinSchema = z.object({ tripId: z.string().regex(/^[a-f\d]{24}$/i) });

const locationSchema = z.object({
  tripId: z.string().regex(/^[a-f\d]{24}$/i),
  vehicleId: z.string().regex(/^[a-f\d]{24}$/i),
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  speedKph: z.number().min(0).max(400),
  heading: z.number().min(0).max(360),
  accuracyMeters: z.number().min(0).max(100000),
  recordedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  sequence: z.number().int().nonnegative(),
  eventId: z.string().min(4).max(120),
});

export function attachSocketServer(server: HttpServer): Server {
  const config = getConfig();
  const io = new Server(server, {
    cors: { origin: config.corsOrigins, credentials: true },
  });
  io.use((socket, next) => {
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
    if (!token) {
      next(new Error('UNAUTHORIZED'));
      return;
    }
    try {
      socket.data.user = readAccessToken(token);
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });
  io.on('connection', (socket) => {
    const user = socket.data.user as AuthenticatedUser;
    void socket.join(`user:${user.id}`);
    socket.on('room:join', async (payload: unknown, ack?: (response: unknown) => void) => {
      const parsed = joinSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, code: 'VALIDATION_ERROR' });
        return;
      }
      try {
        await assertTripAccess(user, parsed.data.tripId, 'socket.join');
        await socket.join(`trip:${parsed.data.tripId}`);
        ack?.({ ok: true, room: `trip:${parsed.data.tripId}` });
      } catch {
        ack?.({ ok: false, code: 'FORBIDDEN' });
      }
    });
    socket.on('location:update', async (payload: unknown, ack?: (response: unknown) => void) => {
      const parsed = locationSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, code: 'VALIDATION_ERROR' });
        return;
      }
      try {
        const trip = await assertTripAccess(user, parsed.data.tripId, 'socket.location');
        if (trip.passengerId.toString() !== user.id && user.role !== 'administrator') {
          ack?.({ ok: false, code: 'FORBIDDEN' });
          return;
        }
        if (trip.vehicleId.toString() !== parsed.data.vehicleId) {
          ack?.({ ok: false, code: 'TRIP_VEHICLE_MISMATCH' });
          return;
        }
        const age = Date.now() - new Date(parsed.data.recordedAt).getTime();
        if (age > 120_000) {
          ack?.({ ok: false, code: 'STALE_MESSAGE' });
          return;
        }
        await ingestLocation({
          vehicleId: parsed.data.vehicleId,
          tripId: parsed.data.tripId,
          latitude: parsed.data.latitude,
          longitude: parsed.data.longitude,
          speedKph: parsed.data.speedKph,
          heading: parsed.data.heading,
          accuracyMeters: parsed.data.accuracyMeters,
          recordedAt: new Date(parsed.data.recordedAt),
          source: 'mobile_gps',
          demo: false,
          sequence: parsed.data.sequence,
          eventId: parsed.data.eventId,
        });
        ack?.({ ok: true });
      } catch (error) {
        logger.warn({ err: error, userId: user.id }, 'rejected socket location');
        ack?.({ ok: false, code: 'REJECTED' });
      }
    });
  });
  setSocketServer(io);
  return io;
}
