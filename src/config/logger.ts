import pino from 'pino';
import { getConfig } from './env';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-device-key"]',
      'req.body.password',
      'req.body.refreshToken',
      'req.body.authToken',
      'req.body.ingestKey',
      'req.body.token',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.refreshToken',
      '*.accessToken',
      '*.authToken',
      '*.ingestKey',
      '*.token',
      '*.uploadUrl',
      '*.accessUrl',
      '*.storageKey',
    ],
    censor: '[redacted]',
  },
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
});

export function logStartup(): void {
  const config = getConfig();
  logger.info(
    {
      env: config.env,
      port: config.port,
      mqttEnabled: config.mqtt.enabled,
      pushConfigured: config.push.configured,
      storageConfigured: config.storage.configured,
      visionConfigured: config.vision.configured,
      speechConfigured: config.speech.configured,
      demoEnabled: config.demo.enabled,
    },
    'configuration loaded',
  );
}
