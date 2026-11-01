export function signMessage(sendRequest, messagePayload) {
  return sendRequest({ type: 'SIGN_MESSAGE', payload: messagePayload });
}
