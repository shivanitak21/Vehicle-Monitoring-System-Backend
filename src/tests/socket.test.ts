import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createApp } from '../app';
import { attachSocketServer } from '../realtime/socket-server';
import { setSocketServer } from '../realtime/publisher';
import { createStartedTrip, linkGrantedPassenger, registerUser } from './helpers';

const sockets: Socket[] = [];
let closeServer: (() => Promise<void>) | null = null;

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  if (closeServer) await closeServer();
  closeServer = null;
  setSocketServer(null);
});

describe('socket authorization', () => {
  it('rejects an unauthorized trip subscription and delivers location only to the authorized user', async () => {
    const app = createApp();
    const server = createServer(app);
    attachSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing port');
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));

    const guardian = await registerUser({ name: 'Live Guardian', email: 'live@example.com', role: 'guardian' });
    const passenger = await registerUser({ name: 'Live Passenger', email: 'livep@example.com', role: 'passenger' });
    const outsider = await registerUser({ name: 'Live Outsider', email: 'liveo@example.com', role: 'guardian' });
    await linkGrantedPassenger(guardian.token, passenger.user);
    const started = await createStartedTrip(guardian.token, passenger.user.id);

    const outsiderSocket = await connect(address.port, outsider.token);
    const denied = await emitAck(outsiderSocket, 'room:join', { tripId: started.trip.id });
    expect(denied).toMatchObject({ ok: false, code: 'FORBIDDEN' });

    const guardianSocket = await connect(address.port, guardian.token);
    const allowed = await emitAck(guardianSocket, 'room:join', { tripId: started.trip.id });
    expect(allowed).toMatchObject({ ok: true });

    let outsiderSawLocation = false;
    outsiderSocket.on('location:update', () => {
      outsiderSawLocation = true;
    });
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('location was not delivered')), 5000);
      guardianSocket.on('location:update', (payload: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    const post = await request(app).post('/api/v1/devices/telemetry').set({
      'x-device-identity': started.device.device.deviceIdentity,
      'x-device-key': started.ingestKey,
    }).send({
      vehicleId: started.vehicle.id,
      tripId: started.trip.id,
      latitude: 13.01,
      longitude: 77.61,
      speedKph: 22,
      heading: 15,
      accuracyMeters: 6,
      recordedAt: new Date().toISOString(),
      sequence: 9,
      eventId: 'socket-gps-1',
      source: 'vehicle_gps',
      demo: false,
    });
    expect(post.status).toBe(201);
    const payload = await received;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(payload.demo).toBe(false);
    expect(payload.source).toBe('vehicle_gps');
    expect(payload.tripId).toBe(started.trip.id);
    expect(outsiderSawLocation).toBe(false);
  });
});

function connect(port: number, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'] });
    sockets.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (error) => reject(error));
  });
}

function emitAck(socket: Socket, event: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response: Record<string, unknown>) => resolve(response));
  });
}
