import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../../config/logger';
import { AppError } from './app-error';

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = req.id;

  if (error instanceof ZodError) {
    const message = error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
    res.status(422).json({
      code: 'VALIDATION_ERROR',
      message,
      details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      requestId,
    });
    return;
  }

  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      logger.error({ err: error, requestId, code: error.code }, error.message);
    }
    res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      details: error.details,
      requestId,
    });
    return;
  }

  const bodyError = error as { type?: string; status?: number; statusCode?: number };
  if (bodyError.type === 'entity.too.large' || bodyError.status === 413 || bodyError.statusCode === 413) {
    res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the configured limit', requestId });
    return;
  }

  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ code: 'INVALID_JSON', message: 'Request body must be valid JSON', requestId });
    return;
  }

  logger.error({ err: error, requestId }, 'unhandled error');
  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'The safety service could not complete that request.',
    requestId,
  });
};
