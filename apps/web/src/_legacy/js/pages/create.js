import { generateMnemonic } from '../../../../packages/crypto/mnemonic.js';
import { encryptPrivateKey } from '../../../../packages/crypto/encryption.js';

const form = document.getElementById('createWalletForm');
const recoveryEl = document.getElementById('recoverPhrase');

if (form) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const password = document.getElementById('password').value.trim();
    const confirm = document.getElementById('passwordConfirm').value.trim();

    if (!password || password !== confirm) {
      showMessage(recoveryEl, 'Passwords must match and cannot be empty.');
      return;
    }

    const mnemonic = generateMnemonic();
    const encryptionResult = encryptPrivateKey(mnemonic, password);
    localStorage.setItem('fluxioWallet', JSON.stringify(encryptionResult));
    recoveryEl.textContent = mnemonic;
    showMessage(recoveryEl, 'Wallet created. Store your recovery phrase safely.');
  });
}
