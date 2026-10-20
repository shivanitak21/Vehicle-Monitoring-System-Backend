import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getConfig } from '../../config/env';
import { AppError } from '../../common/errors/app-error';

export type SignedUrl = { url: string; expiresAt: string };

const STORAGE_HELP = 'Object storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY. Optional: S3_ENDPOINT, S3_REGION, S3_FORCE_PATH_STYLE.';

function client(): S3Client {
  const config = getConfig();
  return new S3Client({
    region: config.storage.region,
    endpoint: config.storage.endpoint,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
  });
}

export function assertStorageConfigured(): void {
  if (!getConfig().storage.configured) {
    throw new AppError(503, 'STORAGE_UNAVAILABLE', STORAGE_HELP);
  }
}

export async function createUploadUrl(key: string, mimeType: string): Promise<SignedUrl> {
  assertStorageConfigured();
  const config = getConfig();
  const command = new PutObjectCommand({ Bucket: config.storage.bucket, Key: key, ContentType: mimeType });
  const url = await getSignedUrl(client(), command, { expiresIn: config.media.urlTtlSeconds });
  return { url, expiresAt: new Date(Date.now() + config.media.urlTtlSeconds * 1000).toISOString() };
}

export async function createDownloadUrl(key: string): Promise<SignedUrl> {
  assertStorageConfigured();
  const config = getConfig();
  const command = new GetObjectCommand({ Bucket: config.storage.bucket, Key: key });
  const url = await getSignedUrl(client(), command, { expiresIn: config.media.urlTtlSeconds });
  return { url, expiresAt: new Date(Date.now() + config.media.urlTtlSeconds * 1000).toISOString() };
}

export async function headObject(key: string): Promise<{ contentLength: number } | null> {
  assertStorageConfigured();
  const config = getConfig();
  try {
    const result = await client().send(new HeadObjectCommand({ Bucket: config.storage.bucket, Key: key }));
    return { contentLength: result.ContentLength ?? 0 };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotFound' || name === 'NoSuchKey') return null;
    throw error;
  }
}

export async function deleteObject(key: string): Promise<void> {
  if (!getConfig().storage.configured) return;
  const config = getConfig();
  await client().send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: key }));
}

export { STORAGE_HELP };
