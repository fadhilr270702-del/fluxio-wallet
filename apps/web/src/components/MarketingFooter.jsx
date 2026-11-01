import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { handleSlideAnchorClick } from '../utils/scrollToSlide.js';
import logo from '../assets/images/logo-fluxio-mono.png';
import solana from '../assets/vendor/images/chains/solana.png';
import ethereum from '../assets/vendor/images/chains/ethereum.png';
import bnb from '../assets/vendor/images/chains/bnb.png';
import base from '../assets/vendor/images/chains/base.png';

const NETWORKS = [
  { name: 'Solana', logo: solana },
  { name: 'Ethereum', logo: ethereum },
  { name: 'BNB', logo: bnb },
  { name: 'Base', logo: base }
];

export default function MarketingFooter() {
  const year = new Date().getFullYear();
  const navigate = useNavigate();
  return (
    <footer className="mkt-footer">
      <div className="mkt-footer__top">
        <div className="mkt-footer__brand">
          <div className="mkt-footer__brand-mark">
            <img src={logo} alt="" />
            <span>Fluxio</span>
          </div>
          <p className="mkt-footer__tag">
            A non custodial wallet core, real BIP-39 mnemonics, SLIP-10/BIP-44 derivation,
            and an AES-256-GCM encrypted vault. Built to be inspected, not just trusted.
          </p>
        </div>
        <div className="mkt-footer__col">
          <h4>Product</h4>
          <a href="#networks" onClick={(e) => handleSlideAnchorClick(e, 'networks', navigate)}>Networks</a>
          <a href="#vault" onClick={(e) => handleSlideAnchorClick(e, 'vault', navigate)}>Vault</a>
          <a href="#extension" onClick={(e) => handleSlideAnchorClick(e, 'extension', navigate)}>Extension</a>
        </div>
        <div className="mkt-footer__col">
          <h4>Networks</h4>
          {NETWORKS.map((n) => (
            <a
              href="#networks"
              key={n.name}
              onClick={(e) => handleSlideAnchorClick(e, 'networks', navigate)}
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <img src={n.logo} alt="" style={{ width: 16, height: 16, borderRadius: '50%' }} />
              {n.name}
            </a>
          ))}
        </div>
        <div className="mkt-footer__col">
          <h4>Security</h4>
          <a href="#vault" onClick={(e) => handleSlideAnchorClick(e, 'vault', navigate)}>AES-256-GCM vault</a>
          <a href="#extension" onClick={(e) => handleSlideAnchorClick(e, 'extension', navigate)}>Origin checked messaging</a>
          <a href="#vault" onClick={(e) => handleSlideAnchorClick(e, 'vault', navigate)}>Non custodial by design</a>
          <Link to="/privacy">Privacy</Link>
        </div>
      </div>
      <div className="mkt-footer__bottom">
        <span>© {year} Fluxio. Non custodial, your keys stay on your device.</span>
        <div className="mkt-footer__socials">
          {/* Prompt 0165 listed the official channel before GitHub; the
              GitHub link was removed by prompt 0216 because the repo is
              private. Telegram has no Icon.jsx entry (it's a bitmap logo,
              not a hand-drawn SVG) — rendered as a masked span instead, see
              design.css's own .icon-mask comment for how it picks up
              currentColor the same way Icon's inline SVGs do. */}
          <a href="https://t.me/FluxioWallet_bot" target="_blank" rel="noreferrer noopener" aria-label="Telegram" title="Telegram">
            <span className="icon-mask" aria-hidden="true" />
          </a>
        </div>
      </div>
    </footer>
  );
}
