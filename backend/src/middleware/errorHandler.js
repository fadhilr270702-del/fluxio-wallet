/**
 * Central error handler — every route's errors (thrown HttpErrors,
 * anything else) funnel through here to a single consistent JSON shape.
 * Must be registered LAST in app.js, after all routes.
 */
import { HttpError } from '../utils/httpError.js';
import { config } from '../config/env.js';

// `next` is unused but must stay in the signature — Express only treats a
// handler as error-handling middleware if it declares exactly 4 params.
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  console.error('[unhandled error]', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: config.isProduction ? 'Something went wrong.' : err?.message || 'Something went wrong.'
    }
  });
}
