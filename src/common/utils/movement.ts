export type MovementAssessment = {
  movement: 'moving' | 'stationary' | 'unknown';
  stale: boolean;
  isMoving: boolean;
  ageSeconds: number | null;
};

export function assessMovement(input: {
  speedKph: number | null | undefined;
  recordedAt: Date | null | undefined;
  now?: Date;
  staleAfterSeconds: number;
  movingSpeedKph: number;
}): MovementAssessment {
  if (!input.recordedAt) {
    return { movement: 'unknown', stale: true, isMoving: false, ageSeconds: null };
  }
  const now = input.now ?? new Date();
  const ageSeconds = Math.max(0, (now.getTime() - input.recordedAt.getTime()) / 1000);
  if (ageSeconds > input.staleAfterSeconds) {
    return { movement: 'unknown', stale: true, isMoving: false, ageSeconds };
  }
  const speed = input.speedKph ?? 0;
  if (speed >= input.movingSpeedKph) {
    return { movement: 'moving', stale: false, isMoving: true, ageSeconds };
  }
  return { movement: 'stationary', stale: false, isMoving: false, ageSeconds };
}

export function assertFreshTimestamp(recordedAt: Date, now: Date, maxAgeSeconds: number, maxFutureSkewSeconds: number): void {
  const deltaSeconds = (recordedAt.getTime() - now.getTime()) / 1000;
  if (deltaSeconds > maxFutureSkewSeconds) {
    throw new Error('timestamp is too far in the future');
  }
  if (-deltaSeconds > maxAgeSeconds) {
    throw new Error('timestamp is stale for live ingestion');
  }
}
