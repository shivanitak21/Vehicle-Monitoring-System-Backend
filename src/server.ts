import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { loadConfig } from './config/env';
import { logger, logStartup } from './config/logger';
import { startJobs, stopJobs } from './jobs/scheduler';
import { startMqtt, stopMqtt } from './mqtt/client';
import { attachSocketServer, } from './realtime/socket-server';
import { setSocketServer } from './realtime/publisher';

async function main(): Promise<void> {
  const config = loadConfig();
  logStartup();
  await connectDatabase();
  const app = createApp();
  const server = createServer(app);
  attachSocketServer(server);
  await startMqtt();
  startJobs();
  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => resolve());
  });
  logger.info({ host: config.host, port: config.port }, 'server listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopJobs();
    setSocketServer(null);
    server.close();
    await stopMqtt();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error({ err: error }, 'server failed to start');
  process.exit(1);
});
