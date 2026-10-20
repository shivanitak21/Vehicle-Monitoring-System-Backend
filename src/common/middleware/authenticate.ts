import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getConfig } from '../../config/env';
import { ForbiddenError, UnauthorizedError } from '../errors/app-error';
import type { UserRole } from '../../models/user';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  email: string;
  name: string;
  familyGroupId: string | null;
}

interface AccessClaims extends jwt.JwtPayload {
  role: UserRole;
  email: string;
  name: string;
  familyGroupId?: string | null;
  typ?: string;
}

export function signAccessToken(user: AuthenticatedUser): string {
  const config = getConfig();
  return jwt.sign(
    {
      role: user.role,
      email: user.email,
      name: user.name,
      familyGroupId: user.familyGroupId,
      typ: 'access',
    },
    config.jwt.accessSecret,
    {
      subject: user.id,
      issuer: config.jwt.issuer,
      expiresIn: config.jwt.accessTtlSeconds,
    },
  );
}

export function readAccessToken(token: string): AuthenticatedUser {
  const config = getConfig();
  try {
    const claims = jwt.verify(token, config.jwt.accessSecret, { issuer: config.jwt.issuer }) as AccessClaims;
    if (claims.typ !== 'access' || !claims.sub || !claims.role) {
      throw new UnauthorizedError('Your session expired. Sign in again.');
    }
    return {
      id: claims.sub,
      role: claims.role,
      email: claims.email,
      name: claims.name,
      familyGroupId: claims.familyGroupId ?? null,
    };
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error;
    throw new UnauthorizedError('Your session expired. Sign in again.');
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) {
    next(new UnauthorizedError('Your session expired. Sign in again.'));
    return;
  }
  try {
    req.user = readAccessToken(match[1]);
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRoles(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Your session expired. Sign in again.'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError('Your account cannot perform that action.'));
      return;
    }
    next();
  };
}
