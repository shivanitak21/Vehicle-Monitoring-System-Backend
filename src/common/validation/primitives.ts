import { z } from 'zod';

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());

export const passwordSchema = z.string().min(8).max(128);

export const coordinateSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
});

export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const isoDateSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

export function parseCursor(cursor?: string): { recordedAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: string; id?: string };
    if (!json.t || !json.id) return null;
    const recordedAt = new Date(json.t);
    if (Number.isNaN(recordedAt.getTime())) return null;
    return { recordedAt, id: json.id };
  } catch {
    return null;
  }
}

export function encodeCursor(recordedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: recordedAt.toISOString(), id })).toString('base64url');
}
