/**
 * Wraps an async Express handler so a rejected promise reaches
 * `next(err)` (and therefore errorHandler.js) instead of becoming an
 * unhandled rejection. Express 4 doesn't do this automatically — Express 5
 * does, but this repo is on 4.
 */
export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
