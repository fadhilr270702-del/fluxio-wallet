import React from 'react';
import sol from '../assets/vendor/images/chains/solana.png';
import eth from '../assets/vendor/images/chains/ethereum.png';
import bnb from '../assets/vendor/images/chains/bnb.png';
import base from '../assets/vendor/images/chains/base.png';

export default function Footer(){
  return (
    <footer className="app-footer">
      <div className="footer-inner">
        <div className="chains">
          <img src={sol} alt="Solana" />
          <img src={eth} alt="Ethereum" />
          <img src={bnb} alt="BNB" />
          <img src={base} alt="Base" />
        </div>
        <div className="footer-note">Supports Solana, BNB Chain, Ethereum, and Base networks.</div>
      </div>
    </footer>
  );
}

