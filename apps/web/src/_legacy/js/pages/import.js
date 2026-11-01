import { validateMnemonic } from '../../../../packages/crypto/mnemonic.js';
import { encryptPrivateKey } from '../../../../packages/crypto/encryption.js';

const form = document.getElementById('importWalletForm');
const recoveryText = document.getElementById('recoveryPhrase');

if (form) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const recoveryPhrase = recoveryText.value.trim();
    const password = document.getElementById('importPassword').value.trim();

    if (!validateMnemonic(recoveryPhrase)) {
      showMessage(recoveryText, 'Recovery phrase is invalid. Please check your words.');
      return;
    }

    if (!password) {
      showMessage(recoveryText, 'A password is required to import the wallet.');
      return;
    }

    const encryptionResult = encryptPrivateKey(recoveryPhrase, password);
    localStorage.setItem('fluxioWallet', JSON.stringify(encryptionResult));
    showMessage(recoveryText, 'Wallet imported successfully.');
  });
}
