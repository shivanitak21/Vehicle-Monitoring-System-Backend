import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { getConfig } from '../../config/env';

function disabled(): RequestHandler {
  return (_req, _res, next) => next();
}

export function globalRateLimit(): RequestHandler {
  const config = getConfig();
  if (config.rateLimit.disabled) return disabled();
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
  });
}

export function authRateLimit(): RequestHandler {
  const config = getConfig();
  if (config.rateLimit.disabled) return disabled();
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.authMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: 'Too many authentication attempts. Try again shortly.' },
  });
}
