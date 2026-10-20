import type { Server } from 'socket.io';

let io: Server | null = null;

export function setSocketServer(server: Server | null): void {
  io = server;
}

export function publishToUsers(userIds: string[], event: string, payload: unknown): void {
  if (!io) return;
  for (const userId of new Set(userIds)) {
    io.to(`user:${userId}`).emit(event, payload);
  }
}

export function publishToTrip(tripId: string, event: string, payload: unknown): void {
  io?.to(`trip:${tripId}`).emit(event, payload);
}

export function socketReady(): boolean {
  return io !== null;
}
