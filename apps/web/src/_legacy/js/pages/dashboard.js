import { formatAddress } from '../../../../packages/utils/formatAddress.js';

const connectButton = document.getElementById('connectButton');
const walletAddressEl = document.getElementById('walletAddress');
const walletBalanceEl = document.getElementById('walletBalance');
const transactionList = document.getElementById('transactionList');

const mockBalance = '1.23 SOL';
const mockTransactions = [
  { id: '1', type: 'Send', amount: '-0.25 SOL', status: 'Confirmed' },
  { id: '2', type: 'Receive', amount: '+0.36 SOL', status: 'Confirmed' }
];

function renderTransactions(items) {
  transactionList.innerHTML = items.length ? items.map(tx => `
    <li class="transaction-item">
      <span>${tx.type}</span>
      <span>${tx.amount}</span>
      <span>${tx.status}</span>
    </li>
  `).join('') : '<li class="transaction-empty">No transactions yet.</li>';
}

function updateWalletInfo(address) {
  walletAddressEl.textContent = address ? formatAddress(address) : 'Not connected';
  walletBalanceEl.textContent = address ? mockBalance : '-- SOL';
  renderTransactions(address ? mockTransactions : []);
}

if (connectButton) {
  connectButton.addEventListener('click', async () => {
    const storedAddress = localStorage.getItem('fluxioAddress');

    if (storedAddress) {
      updateWalletInfo(storedAddress);
      return;
    }

    const newAddress = 'F4X1Oqwerty12345DemoAddress67890';
    localStorage.setItem('fluxioAddress', newAddress);
    updateWalletInfo(newAddress);
    showMessage(document.body, 'Wallet connected successfully.');
  });
}

updateWalletInfo(localStorage.getItem('fluxioAddress'));
