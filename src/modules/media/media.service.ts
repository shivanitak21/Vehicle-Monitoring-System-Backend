import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { getConfig } from '../../config/env';
import { AppError, NotFoundError } from '../../common/errors/app-error';
import type { AuthenticatedUser } from '../../common/middleware/authenticate';
import { MediaAssetModel, type MediaAssetDocument } from '../../models/incident';
import { UserModel } from '../../models/user';
import { assertIncidentAccess, assertMediaAccess, relationshipBetween } from '../access/access.service';
import { writeAudit } from '../audit/audit.service';
import { createDownloadUrl, createUploadUrl, deleteObject, headObject, assertStorageConfigured } from '../../integrations/storage/storage-provider';
import { reviewCabinStill } from '../../integrations/inference/providers';
import { TripModel } from '../../models/trip';

const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']);

export async function requestUploadUrl(user: AuthenticatedUser, incidentId: string, input: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  mediaType: 'photo' | 'video';
  capturedAt: Date;
  durationSeconds?: number;
  eventId?: string;
}) {
  const incident = await assertIncidentAccess(user, incidentId);
  await assertMediaConsent(user, incident.passengerId.toString(), incident.tripId.toString());
  if (!MIME_TYPES.has(input.mimeType)) throw new AppError(422, 'VALIDATION_ERROR', 'mimeType: is not an allowed photo or video type');
  if ((input.mediaType === 'photo' && !input.mimeType.startsWith('image/')) || (input.mediaType === 'video' && !input.mimeType.startsWith('video/'))) {
    throw new AppError(422, 'VALIDATION_ERROR', 'mediaType does not match mimeType');
  }
  if (input.sizeBytes > getConfig().media.maxBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'File exceeds the configured upload limit');
  assertStorageConfigured();
  const mediaId = new Types.ObjectId();
  const storageKey = `families/${incident.familyGroupId.toString()}/incidents/${incident.id}/${mediaId.toString()}`;
  const retentionExpiresAt = new Date(Date.now() + getConfig().media.retentionDays * 24 * 60 * 60 * 1000);
  const media = await MediaAssetModel.create({
    _id: mediaId,
    incidentId: incident._id,
    tripId: incident.tripId,
    eventId: input.eventId ?? '',
    familyGroupId: incident.familyGroupId,
    storageKey,
    mediaType: input.mediaType,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    originalFileName: input.fileName,
    capturedAt: input.capturedAt,
    durationSeconds: input.durationSeconds ?? null,
    uploadState: 'pending',
    consentContext: 'camera_evidence_granted',
    retentionExpiresAt,
    demo: incident.demo,
  });
  const signed = await createUploadUrl(storageKey, input.mimeType);
  return {
    mediaId: media.id,
    uploadUrl: signed.url,
    expiresAt: signed.expiresAt,
    headers: { 'Content-Type': input.mimeType },
    storage: 's3',
    uploadState: media.uploadState,
  };
}

export async function completeUpload(user: AuthenticatedUser, incidentId: string, mediaId: string) {
  const media = await assertMediaAccess(user, mediaId);
  if (media.incidentId.toString() !== incidentId) throw new NotFoundError('Media not found');
  if (media.uploadState === 'expired' || media.uploadState === 'deleted') throw new AppError(409, 'UPLOAD_CLOSED', 'This upload can no longer be completed');
  const head = await headObject(media.storageKey);
  if (!head) {
    media.uploadState = 'failed';
    await media.save();
    throw new AppError(409, 'UPLOAD_INCOMPLETE', 'The object was not found in storage');
  }
  media.uploadState = 'uploaded';
  media.uploadedAt = new Date();
  media.sizeBytes = head.contentLength || media.sizeBytes;
  await media.save();
  return { mediaId: media.id, uploadState: media.uploadState, uploadedAt: media.uploadedAt };
}

export async function listMedia(user: AuthenticatedUser, incidentId: string) {
  const incident = await assertIncidentAccess(user, incidentId);
  await assertMediaConsent(user, incident.passengerId.toString(), incident.tripId.toString());
  const items = await MediaAssetModel.find({ incidentId: incident._id, uploadState: { $ne: 'deleted' } }).sort({ capturedAt: -1 });
  return items.map(presentMedia);
}

export async function accessUrl(user: AuthenticatedUser, mediaId: string) {
  const media = await assertMediaAccess(user, mediaId);
  if (media.uploadState !== 'uploaded') throw new AppError(409, 'MEDIA_NOT_READY', 'The file is not available');
  if (media.retentionExpiresAt.getTime() <= Date.now()) {
    media.uploadState = 'expired';
    await media.save();
    throw new AppError(410, 'MEDIA_EXPIRED', 'The retention period for this file has ended');
  }
  const signed = await createDownloadUrl(media.storageKey);
  return { mediaId: media.id, accessUrl: signed.url, expiresAt: signed.expiresAt, mimeType: media.mimeType, mediaType: media.mediaType };
}

export async function deleteMedia(user: AuthenticatedUser, mediaId: string) {
  const media = await assertMediaAccess(user, mediaId);
  await deleteObject(media.storageKey);
  media.uploadState = 'deleted';
  await media.save();
  await writeAudit({ actorId: user.id, actorRole: user.role, action: 'media.delete', resourceType: 'media', resourceId: media.id, decision: 'allow' });
}

export async function reviewMedia(user: AuthenticatedUser, mediaId: string) {
  const media = await assertMediaAccess(user, mediaId);
  if (media.mediaType !== 'photo' || media.uploadState !== 'uploaded') {
    throw new AppError(409, 'MEDIA_NOT_READY', 'Cabin review requires an uploaded photo');
  }
  const signed = await createDownloadUrl(media.storageKey);
  try {
    const review = await reviewCabinStill({ imageUrl: signed.url });
    media.modelReview = {
      status: 'completed',
      provider: review.provider,
      summary: review.summary,
      modelGenerated: true,
      completedAt: new Date(),
    };
    await media.save();
    return { ...review, mediaId: media.id };
  } catch (error) {
    if (error instanceof AppError && error.code === 'PROVIDER_NOT_CONFIGURED') {
      media.modelReview = { status: 'unavailable', provider: '', summary: '', modelGenerated: false, completedAt: null };
      await media.save();
    }
    throw error;
  }
}

async function assertMediaConsent(user: AuthenticatedUser, passengerId: string, tripId: string): Promise<void> {
  const passenger = await UserModel.findById(passengerId);
  if (!passenger?.privacy.cameraEvidence) throw new AppError(409, 'CONSENT_REQUIRED', 'Camera evidence consent is not granted');
  if (user.role === 'administrator' || user.id === passengerId) return;
  const relationship = await relationshipBetween(user.id, passengerId);
  const trip = await TripModel.findById(tripId);
  if (!relationship?.permissions.viewMedia || !trip?.sharing?.shareMedia) throw new NotFoundError('Incident not found');
}

function presentMedia(media: MediaAssetDocument) {
  return {
    id: media.id,
    mediaType: media.mediaType,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    capturedAt: media.capturedAt,
    durationSeconds: media.durationSeconds ?? null,
    uploadState: media.uploadState,
    retentionExpiresAt: media.retentionExpiresAt,
    demo: media.demo,
    fileName: media.originalFileName ?? '',
    uri: null,
  };
}

export function newMediaKey(): string {
  return randomUUID();
}
