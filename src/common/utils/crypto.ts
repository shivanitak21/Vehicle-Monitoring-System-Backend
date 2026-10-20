import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqualHex(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, 'utf8');
  const right = Buffer.from(rightHex, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function newOpaqueToken(): string {
  return randomBytes(48).toString('base64url');
}

export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
