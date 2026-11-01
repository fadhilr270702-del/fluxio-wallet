import { describe, it, expect } from 'vitest';
import {
  createApprovalRequest,
  approveRequest,
  rejectRequest,
  getPendingRequest,
  listPendingRequests
} from '../approvalService.js';

describe('approvalService', () => {
  it('resolves the request promise when approved', async () => {
    const { id, promise } = createApprovalRequest({ origin: 'https://dapp.example', type: 'CONNECT' });
    approveRequest(id, { address: '0xabc' });
    await expect(promise).resolves.toEqual({ address: '0xabc' });
  });

  it('rejects the request promise when rejected', async () => {
    const { id, promise } = createApprovalRequest({ origin: 'https://dapp.example', type: 'CONNECT' });
    rejectRequest(id, 'user said no');
    await expect(promise).rejects.toThrow('user said no');
  });

  it('a request blocks until a decision is made (no auto-approval)', async () => {
    const { id, promise } = createApprovalRequest({ origin: 'https://dapp.example', type: 'SIGN_MESSAGE' });
    let settled = false;
    promise.then(() => (settled = true), () => (settled = true));

    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    approveRequest(id, {});
    await promise;
    expect(settled).toBe(true);
  });

  it('getPendingRequest exposes metadata while pending, and null after resolution', () => {
    const { id } = createApprovalRequest({ origin: 'https://dapp.example', type: 'SIGN_TRANSACTION' });
    expect(getPendingRequest(id)).toMatchObject({ origin: 'https://dapp.example', type: 'SIGN_TRANSACTION' });
    approveRequest(id, {});
    expect(getPendingRequest(id)).toBeNull();
  });

  it('throws when approving/rejecting an unknown or already-resolved request', () => {
    const { id } = createApprovalRequest({ origin: 'https://dapp.example', type: 'CONNECT' });
    approveRequest(id, {});
    expect(() => approveRequest(id, {})).toThrow();
    expect(() => rejectRequest('not-a-real-id')).toThrow();
  });

  it('listPendingRequests only lists unresolved requests', () => {
    const before = listPendingRequests().length;
    const { id } = createApprovalRequest({ origin: 'https://dapp.example', type: 'CONNECT' });
    expect(listPendingRequests().length).toBe(before + 1);
    approveRequest(id, {});
    expect(listPendingRequests().length).toBe(before);
  });
});
