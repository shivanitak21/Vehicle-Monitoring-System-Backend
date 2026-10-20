import fs from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer;
const uriFile = path.join(process.cwd(), '.test-mongo-uri');

export async function setup(): Promise<void> {
  mongo = await MongoMemoryServer.create();
  fs.writeFileSync(uriFile, mongo.getUri(), 'utf8');
}

export async function teardown(): Promise<void> {
  if (mongo) await mongo.stop();
  fs.rmSync(uriFile, { force: true });
}
