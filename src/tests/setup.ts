import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { reloadConfig } from '../config/env';

const uri = fs.readFileSync(path.join(process.cwd(), '.test-mongo-uri'), 'utf8').trim();
process.env.MONGODB_URI = uri;
reloadConfig();

beforeAll(async () => {
  process.env.MONGODB_URI = uri;
  reloadConfig();
  await mongoose.connect(uri);
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const collection of Object.values(collections)) {
    await collection.deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
});
