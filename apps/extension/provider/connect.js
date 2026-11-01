export function connect(sendRequest) {
  return sendRequest({ type: 'CONNECT' });
}
