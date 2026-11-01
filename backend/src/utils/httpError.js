/**
 * A small typed error so route handlers/middleware can `throw` with an
 * intended HTTP status + a stable machine-readable code, and
 * errorHandler.js can turn that into the `{ error: { code, message } }`
 * shape consistently instead of every call site hand-rolling `res.status()`.
 */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
