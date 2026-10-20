import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../../config/env';
import { AppError, ConflictError, isDuplicateKey, UnauthorizedError } from '../../common/errors/app-error';
import { signAccessToken, type AuthenticatedUser } from '../../common/middleware/authenticate';
import { newOpaqueToken, sha256 } from '../../common/utils/crypto';
import { FamilyGroupModel, FamilyRelationshipModel } from '../../models/family';
import { RefreshTokenModel } from '../../models/refresh-token';
import { UserModel, type UserDocument, type UserRole } from '../../models/user';
import { writeAudit } from '../audit/audit.service';

const BCRYPT_COST = 12;

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: UserRole;
  accountStatus: string;
  familyGroupId: string | null;
};

export type AuthResult = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  token: string;
  user: PublicUser;
};

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone || undefined,
    role: user.role as UserRole,
    accountStatus: user.accountStatus,
    familyGroupId: user.familyGroupId ? user.familyGroupId.toString() : null,
  };
}

function toAuthContext(user: UserDocument): AuthenticatedUser {
  return {
    id: user._id.toString(),
    role: user.role as UserRole,
    email: user.email,
    name: user.name,
    familyGroupId: user.familyGroupId ? user.familyGroupId.toString() : null,
  };
}

async function issueTokens(user: UserDocument, userAgent: string, familyId: string = randomUUID()): Promise<AuthResult> {
  const config = getConfig();
  const refreshToken = newOpaqueToken();
  const expiresAt = new Date(Date.now() + config.jwt.refreshTtlSeconds * 1000);
  await RefreshTokenModel.create({
    userId: user._id,
    familyId,
    tokenHash: sha256(refreshToken),
    expiresAt,
    userAgent: userAgent.slice(0, 300),
  });
  const accessToken = signAccessToken(toAuthContext(user));
  return {
    accessToken,
    refreshToken,
    expiresIn: config.jwt.accessTtlSeconds,
    token: accessToken,
    user: toPublicUser(user),
  };
}

async function linkInvites(user: UserDocument): Promise<void> {
  await FamilyRelationshipModel.updateMany(
    { inviteEmail: user.email, passengerId: null },
    { $set: { passengerId: user._id } },
  );
  if (!user.familyGroupId) {
    const relationship = await FamilyRelationshipModel.findOne({ passengerId: user._id, consentStatus: { $ne: 'revoked' } });
    if (relationship) {
      user.familyGroupId = relationship.familyGroupId;
      await user.save();
    }
  }
}

export async function register(input: {
  name: string;
  email: string;
  password: string;
  role: 'guardian' | 'passenger';
  phone?: string;
}): Promise<AuthResult> {
  if ((input.role as string) === 'administrator') {
    throw new AppError(403, 'FORBIDDEN', 'Administrator accounts cannot be self-registered');
  }
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  try {
    const user = await UserModel.create({
      name: input.name,
      email: input.email,
      phone: input.phone ?? '',
      passwordHash,
      role: input.role,
      accountStatus: 'active',
    });
    if (input.role === 'guardian') {
      const group = await FamilyGroupModel.create({
        name: `${input.name}'s family`,
        ownerId: user._id,
        memberIds: [user._id],
      });
      user.familyGroupId = group._id;
      await user.save();
    }
    await linkInvites(user);
    await writeAudit({ actorId: user.id, actorRole: user.role, action: 'auth.register', resourceType: 'user', resourceId: user.id, decision: 'allow' });
    return issueTokens(user, '');
  } catch (error) {
    if (isDuplicateKey(error)) throw new ConflictError('An account with that email already exists');
    throw error;
  }
}

export async function createAdministrator(input: { name: string; email: string; password: string }): Promise<PublicUser> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const user = await UserModel.create({
    name: input.name,
    email: input.email,
    passwordHash,
    role: 'administrator',
    accountStatus: 'active',
  });
  return toPublicUser(user);
}

export async function login(input: { email: string; password: string }, userAgent = ''): Promise<AuthResult> {
  const user = await UserModel.findOne({ email: input.email }).select('+passwordHash');
  const matches = user ? await bcrypt.compare(input.password, user.passwordHash) : false;
  if (!user || !matches) {
    await writeAudit({ action: 'auth.login', resourceType: 'user', resourceId: input.email, decision: 'deny' });
    throw new UnauthorizedError('Email or password is incorrect');
  }
  if (user.accountStatus !== 'active') {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account cannot sign in');
  }
  await writeAudit({ actorId: user.id, actorRole: user.role, action: 'auth.login', resourceType: 'user', resourceId: user.id, decision: 'allow' });
  return issueTokens(user, userAgent);
}

export async function refresh(refreshToken: string, userAgent = ''): Promise<AuthResult> {
  const tokenHash = sha256(refreshToken);
  const existing = await RefreshTokenModel.findOne({ tokenHash });
  if (!existing) throw new UnauthorizedError('Your session expired. Sign in again.');
  if (existing.revokedAt) {
    await RefreshTokenModel.updateMany({ familyId: existing.familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await writeAudit({
      actorId: existing.userId.toString(),
      action: 'auth.refresh_reuse',
      resourceType: 'refresh_token',
      resourceId: existing.id,
      decision: 'deny',
    });
    throw new UnauthorizedError('Your session expired. Sign in again.');
  }
  if (existing.expiresAt.getTime() <= Date.now()) {
    existing.revokedAt = new Date();
    await existing.save();
    throw new UnauthorizedError('Your session expired. Sign in again.');
  }
  const user = await UserModel.findById(existing.userId);
  if (!user || user.accountStatus !== 'active') throw new UnauthorizedError('Your session expired. Sign in again.');
  const issued = await issueTokens(user, userAgent, existing.familyId);
  const replacement = await RefreshTokenModel.findOne({ tokenHash: sha256(issued.refreshToken) });
  existing.revokedAt = new Date();
  existing.replacedById = replacement?._id ?? null;
  await existing.save();
  return issued;
}

export async function logout(userId: string): Promise<void> {
  await RefreshTokenModel.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await writeAudit({ actorId: userId, action: 'auth.logout', resourceType: 'user', resourceId: userId, decision: 'allow' });
}

export async function me(userId: string): Promise<PublicUser> {
  const user = await UserModel.findById(userId);
  if (!user || user.accountStatus !== 'active') throw new UnauthorizedError('Your session expired. Sign in again.');
  return toPublicUser(user);
}

export async function updateProfile(userId: string, input: { name?: string; phone?: string }): Promise<PublicUser> {
  const user = await UserModel.findById(userId);
  if (!user) throw new UnauthorizedError('Your session expired. Sign in again.');
  if (input.name) user.name = input.name;
  if (input.phone !== undefined) user.phone = input.phone;
  await user.save();
  return toPublicUser(user);
}

export async function updateNotificationPrefs(userId: string, prefs: Record<string, boolean>) {
  const user = await UserModel.findById(userId);
  if (!user) throw new UnauthorizedError('Your session expired. Sign in again.');
  user.notificationPrefs = { ...user.notificationPrefs, ...prefs };
  await user.save();
  return user.notificationPrefs;
}

export async function updatePrivacy(userId: string, privacy: Record<string, boolean>) {
  const user = await UserModel.findById(userId);
  if (!user) throw new UnauthorizedError('Your session expired. Sign in again.');
  user.privacy = { ...user.privacy, ...privacy };
  await user.save();
  return user.privacy;
}

export async function getSettings(userId: string) {
  const user = await UserModel.findById(userId);
  if (!user) throw new UnauthorizedError('Your session expired. Sign in again.');
  return { privacy: user.privacy, notificationPrefs: user.notificationPrefs };
}
