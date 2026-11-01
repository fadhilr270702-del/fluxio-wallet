/**
 * In-memory approval request queue — the "User Approval" step in the
 * signing architecture. Real (not simulated): a dApp request genuinely
 * blocks on a promise that only resolves once something calls
 * approveRequest()/rejectRequest(), which apps/extension's background
 * script wires up to an actual approval popup window.
 *
 * This module has no opinion on *how* approval UI is shown — that's the
 * caller's job (e.g. chrome.windows.create in the extension). It just
 * owns the pending-request bookkeeping so background.js doesn't need to.
 */

/** @type {Map<string, { resolve: Function, reject: Function, meta: object, createdAt: number }>} */
const pendingRequests = new Map();

/**
 * Register a new approval request and get back its id + a promise that
 * resolves/rejects once a decision is made.
 * @param {{ origin: string, type: string, summary?: object }} meta
 */
export function createApprovalRequest(meta) {
  const id = crypto.randomUUID();
  const promise = new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject, meta, createdAt: Date.now() });
  });
  return { id, promise };
}

export function approveRequest(id, result) {
  const entry = takePending(id);
  entry.resolve(result);
}

export function rejectRequest(id, reason = 'User rejected the request.') {
  const entry = takePending(id);
  entry.reject(new Error(reason));
}

export function getPendingRequest(id) {
  const entry = pendingRequests.get(id);
  return entry ? { id, ...entry.meta, createdAt: entry.createdAt } : null;
}

export function listPendingRequests() {
  return Array.from(pendingRequests.entries()).map(([id, entry]) => ({
    id,
    ...entry.meta,
    createdAt: entry.createdAt
  }));
}

function takePending(id) {
  const entry = pendingRequests.get(id);
  if (!entry) {
    throw new Error(`Unknown or already-resolved approval request: ${id}`);
  }
  pendingRequests.delete(id);
  return entry;
}
