export function signTransaction(sendRequest, transactionPayload) {
  return sendRequest({ type: 'SIGN_TRANSACTION', payload: transactionPayload });
}
