import { connect } from './connect.js';
import { signTransaction } from './signTransaction.js';
import { signMessage } from './signMessage.js';

const createRequest = (type, payload) => {
  return {
    source: 'fluxio-provider',
    type,
    // crypto.randomUUID() (not Math.random) — unguessable, so a page
    // script can't spoof another in-flight request's id.
    requestId: crypto.randomUUID(),
    payload
  };
};

const sendRequest = (message) => {
  return new Promise((resolve, reject) => {
    const request = createRequest(message.type, message.payload);
    const onMessage = (event) => {
      if (event.source !== window) return; // ignore other frames
      if (event.origin !== window.location.origin) return; // ignore cross-origin senders
      if (!event.data || event.data.source !== 'fluxio-extension') return;
      if (event.data.requestId !== request.requestId) return;
      window.removeEventListener('message', onMessage);

      if (event.data.response) {
        resolve(event.data.response);
      } else {
        reject(new Error(event.data.error || 'Unknown extension response'));
      }
    };

    window.addEventListener('message', onMessage, false);
    window.postMessage(request, window.location.origin);
  });
};

window.fluxio = {
  connect: () => connect(sendRequest),
  signTransaction: (transactionPayload) => signTransaction(sendRequest, transactionPayload),
  signMessage: (messagePayload) => signMessage(sendRequest, messagePayload)
};

window.dispatchEvent(new CustomEvent('fluxio:ready'));
