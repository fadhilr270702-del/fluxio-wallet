/**
 * Request-body validator middleware factory, backed by zod. Chosen over
 * hand-rolled enum/date checks scattered across controllers — the
 * announcement fields (level/status/target_platform enums, ISO date
 * strings) are exactly the fiddly-by-hand, easy-to-get-subtly-wrong kind
 * of validation a schema library is worth a dependency for.
 *
 * On success, `req.body` is replaced with the parsed (and type-coerced)
 * value, so controllers can trust its shape completely.
 */
import { HttpError } from '../utils/httpError.js';

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const detail = result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
      throw new HttpError(400, 'VALIDATION_ERROR', detail);
    }
    req.body = result.data;
    next();
  };
}
