export const RISK_RULES_VERSION = '2026.1';

export const EVENT_TYPES = [
  'sos',
  'driver_fatigue',
  'driver_distraction',
  'speeding',
  'harsh_braking',
  'route_deviation',
  'seat_occupancy_change',
  'abusive_language',
  'face_not_detected',
  'camera_offline',
  'device_offline',
  'gps_stale',
] as const;

export type SafetyEventType = (typeof EVENT_TYPES)[number];

export type RiskState = 'normal' | 'warning' | 'critical' | 'unknown' | 'stale' | 'offline';

/**
 * Points are additive signals inside the configured window.
 * They are not a probability and they are not a safety percentage.
 * SOS always alerts even when the numeric total would be ignored.
 */
export const RISK_WEIGHTS: Record<SafetyEventType, number> = {
  sos: 100,
  driver_fatigue: 40,
  driver_distraction: 30,
  speeding: 25,
  harsh_braking: 20,
  route_deviation: 35,
  seat_occupancy_change: 10,
  abusive_language: 45,
  face_not_detected: 20,
  camera_offline: 15,
  device_offline: 30,
  gps_stale: 15,
};

export type ObservedSignal = {
  eventType: SafetyEventType;
  severity: 'info' | 'warning' | 'critical';
  weight: number;
  eventId: string;
};

export type RiskAssessment = {
  rulesVersion: string;
  state: RiskState;
  threshold: number;
  observedScore: number | null;
  sufficientData: boolean;
  highRisk: boolean;
  signals: ObservedSignal[];
  explanation: string;
};

export function assessRisk(input: {
  rulesVersion: string;
  threshold: number;
  signals: ObservedSignal[];
  hasFreshLocation: boolean;
  hasAnyLocation: boolean;
  deviceOffline: boolean;
  locationStale: boolean;
}): RiskAssessment {
  const observedScore = input.signals.reduce((sum, signal) => sum + signal.weight, 0);
  const hasCritical = input.signals.some((signal) => signal.severity === 'critical' || signal.eventType === 'sos');
  const hasWarning = input.signals.some((signal) => signal.severity === 'warning' || signal.weight >= 20);
  const highRisk = hasCritical || observedScore >= input.threshold;

  let state: RiskState = 'unknown';
  if (input.deviceOffline) state = 'offline';
  else if (input.locationStale) state = 'stale';
  else if (hasCritical) state = 'critical';
  else if (hasWarning) state = 'warning';
  else if (input.hasFreshLocation) state = 'normal';
  else state = 'unknown';

  const sufficientData = input.hasAnyLocation || input.signals.length > 0 || input.deviceOffline;
  const explanation = buildExplanation(state, sufficientData);

  return {
    rulesVersion: input.rulesVersion,
    state,
    threshold: input.threshold,
    observedScore: input.signals.length > 0 ? observedScore : null,
    sufficientData,
    highRisk,
    signals: input.signals,
    explanation,
  };
}

function buildExplanation(state: RiskState, sufficientData: boolean): string {
  if (!sufficientData || state === 'unknown') {
    return 'No recent location or safety signals were observed. This is not a determination that the passenger is safe.';
  }
  if (state === 'normal') {
    return 'Fresh location data is available and no warning or critical signals were observed in the current window. This is not a determination that the passenger is safe.';
  }
  if (state === 'stale') {
    return 'The latest location is older than the staleness threshold. Movement is unknown.';
  }
  if (state === 'offline') {
    return 'The vehicle device has missed its heartbeat threshold.';
  }
  if (state === 'critical') {
    return 'A critical signal or SOS was observed in the current window.';
  }
  return 'A warning-level signal was observed in the current window.';
}

export function weightFor(eventType: SafetyEventType): number {
  return RISK_WEIGHTS[eventType];
}
