import express, { type Request } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { getConfig } from './config/env';
import { logger } from './config/logger';
import { mongoReady } from './config/database';
import { errorHandler } from './common/errors/error-handler';
import { requestContext } from './common/middleware/request-context';
import { globalRateLimit } from './common/middleware/rate-limit';
import { authRouter, profileRouter } from './modules/auth/auth.controller';
import { familyRouter } from './modules/family/family.controller';
import { vehicleRouter } from './modules/vehicles/vehicle.controller';
import { tripRouter } from './modules/trips/trip.controller';
import { incidentRouter, mediaRouter, safetyRouter } from './modules/safety/safety.controller';
import { mobileRouter } from './modules/compatibility/mobile.controller';
import { deviceIngestRouter } from './modules/devices/device.controller';
import { dashboardRouter } from './modules/dashboard/dashboard.controller';
import { notificationRouter } from './modules/notifications/notification.controller';
import { openApiDocument } from './docs/openapi';
import { isMqttConnected } from './mqtt/publisher';

export function createApp() {
  const config = getConfig();
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(requestContext);
  app.use(pinoHttp({
    logger,
    genReqId: (req) => (req as Request).id,
    autoLogging: config.isTest ? false : { ignore: (req) => req.url?.startsWith('/health') ?? false },
  }));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed'));
    },
    credentials: true,
  }));
  app.use(globalRateLimit());
  app.use(express.json({ limit: config.bodyLimit }));

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'live' });
  });
  app.get('/health/ready', (_req, res) => {
    const mqtt = config.mqtt.enabled ? (isMqttConnected() ? 'up' : 'down') : 'disabled';
    const mongodb = mongoReady() ? 'up' : 'down';
    const ready = mongodb === 'up' && mqtt !== 'down';
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        mongodb,
        mqtt,
        push: config.push.configured ? 'configured' : 'not_configured',
        storage: config.storage.configured ? 'configured' : 'not_configured',
        vision: config.vision.configured ? 'configured' : 'not_configured',
        speech: config.speech.configured ? 'configured' : 'not_configured',
      },
    });
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/profile', profileRouter);
  app.use('/api/v1/family', familyRouter);
  app.use('/api/v1/vehicles', vehicleRouter);
  app.use('/api/v1/trips', tripRouter);
  app.use('/api/v1/safety', safetyRouter);
  app.use('/api/v1/incidents', incidentRouter);
  app.use('/api/v1/media', mediaRouter);
  app.use('/api/v1/devices', deviceIngestRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use('/api/v1/notifications', notificationRouter);

  app.use('/v1/auth', authRouter);
  app.use('/v1/profile', profileRouter);
  app.use('/v1/family', familyRouter);
  app.use('/v1', mobileRouter);

  app.get('/docs/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use((req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found', requestId: req.id });
  });
  app.use(errorHandler);
  return app;
}
