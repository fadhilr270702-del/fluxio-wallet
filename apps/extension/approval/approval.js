/**
 * Approval window controller.
 *
 * Talks to background.js ONLY via the FLUXIO_INTERNAL_* message types,
 * which background.js only accepts from senders whose URL is under this
 * extension's own chrome-extension:// origin (see background.js's
 * isTrustedInternalSender). This file never touches the vault or signer
 * directly — it only ever forwards the user's typed password and
 * approve/reject decision, and the background service worker performs
 * the actual unlock/sign.
 */
const app = document.getElementById('app');
const requestId = new URLSearchParams(window.location.search).get('id');

function sendInternal(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, requestId, ...extra }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (result?.error) {
        reject(new Error(result.error));
        return;
      }
      resolve(result?.response);
    });
  });
}

function renderError(target, message) {
  target.textContent = message || '';
}

function typeLabel(type) {
  switch (type) {
    case 'CONNECT':
      return 'Connect to your wallet';
    case 'SIGN_MESSAGE':
      return 'Sign message';
    case 'SIGN_TRANSACTION':
      return 'Sign transaction';
    default:
      return 'Approve request';
  }
}

async function main() {
  if (!requestId) {
    app.innerHTML = '<h1>Invalid request</h1>';
    return;
  }

  let state;
  try {
    state = await sendInternal('FLUXIO_INTERNAL_GET_APPROVAL');
  } catch (error) {
    app.innerHTML = `<h1>Request unavailable</h1><div class="origin">${escapeHtml(error.message)}</div>`;
    return;
  }

  const { request, hasWallet, isUnlocked } = state;
  render(request, hasWallet, isUnlocked);
}

function render(request, hasWallet, isUnlocked) {
  const summaryRows = [];
  // Multi-account: shows which account will actually connect/sign, since
  // that's no longer always "the only one" — background.js snapshots this
  // fresh at request time (see its own currentAccountSummary()), so it's
  // absent only while locked (nothing is "active" yet to show).
  if (request.summary?.accountName) {
    const account = request.summary.address
      ? `${request.summary.accountName} (${shortenAddress(request.summary.address)})`
      : request.summary.accountName;
    summaryRows.push(field('Account', account));
  }
  if (request.type === 'SIGN_MESSAGE' && request.summary?.message) {
    summaryRows.push(field('Message', request.summary.message));
  }
  if (request.summary?.network) {
    summaryRows.push(field('Network', request.summary.network));
  }

  app.innerHTML = `
    <h1>${escapeHtml(typeLabel(request.type))}</h1>
    <div class="origin">${escapeHtml(request.origin)}</div>
    ${summaryRows.join('')}
    ${!hasWallet ? '<p class="hint">No Fluxio wallet found on this device. Create or import one first.</p>' : ''}
    ${hasWallet && !isUnlocked ? '<input type="password" id="password" placeholder="Wallet password" autocomplete="current-password" />' : ''}
    <div class="actions">
      ${hasWallet ? `<button class="approve" id="approveBtn">${isUnlocked ? 'Approve' : 'Unlock & Approve'}</button>` : ''}
      <button class="reject" id="rejectBtn">Reject</button>
    </div>
    <div class="error" id="errorMsg"></div>
  `;

  const errorMsg = document.getElementById('errorMsg');
  document.getElementById('rejectBtn').addEventListener('click', async () => {
    await sendInternal('FLUXIO_INTERNAL_REJECT').catch(() => {});
    window.close();
  });

  const approveBtn = document.getElementById('approveBtn');
  if (approveBtn) {
    approveBtn.addEventListener('click', async () => {
      renderError(errorMsg, '');
      approveBtn.disabled = true;
      try {
        if (!isUnlocked) {
          const password = document.getElementById('password')?.value || '';
          if (!password) throw new Error('Enter your wallet password.');
          await sendInternal('FLUXIO_INTERNAL_UNLOCK', { password });
        }
        await sendInternal('FLUXIO_INTERNAL_APPROVE');
        window.close();
      } catch (error) {
        renderError(errorMsg, error.message);
        approveBtn.disabled = false;
      }
    });
  }
}

function field(label, value) {
  return `<div class="field"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(
    String(value)
  )}</div></div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/** Display-only truncation ("HM2t…6TFy") — never used anywhere secrets/full-value-accuracy matters; the field's own value is still the full account name, just the address half is shortened for space. */
function shortenAddress(address, front = 4, back = 4) {
  if (!address || address.length <= front + back + 1) return address || '';
  return `${address.slice(0, front)}…${address.slice(-back)}`;
}

main();
