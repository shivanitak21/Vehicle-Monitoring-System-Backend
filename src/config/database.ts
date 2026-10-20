import mongoose from 'mongoose';
import { getConfig } from './env';
import { logger } from './logger';

export async function connectDatabase(): Promise<void> {
  const { mongodbUri } = getConfig();
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 8000 });
  logger.info('mongodb connected');
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}

export function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}
