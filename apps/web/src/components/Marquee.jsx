import React from 'react';
import Icon from './Icon.jsx';
import solana from '../assets/vendor/images/chains/solana.png';
import ethereum from '../assets/vendor/images/chains/ethereum.png';
import bnb from '../assets/vendor/images/chains/bnb.png';
import base from '../assets/vendor/images/chains/base.png';
import alchemy from '../assets/vendor/images/ecosystem/alchemy.png';
import dexscreener from '../assets/vendor/images/ecosystem/dexscreener.png';
import helius from '../assets/vendor/images/ecosystem/helius.png';
import infura from '../assets/vendor/images/ecosystem/infura.png';
import jupiter from '../assets/vendor/images/ecosystem/jupiter.png';
import pancakeswap from '../assets/vendor/images/ecosystem/pancakeswap.png';
import quicknode from '../assets/vendor/images/ecosystem/quicknode.png';
import raydium from '../assets/vendor/images/ecosystem/raydium.png';
import uniswap from '../assets/vendor/images/ecosystem/uniswap.png';
import walletconnect from '../assets/vendor/images/ecosystem/walletconnect.png';

// Top row (moves left) — chains this wallet actually derives for (real PNG
// logos, same assets used in the Networks section) plus the real
// cryptographic/technical building blocks named throughout the page
// (Vault/Extension sections, this FAQ's own answers).
const ROW1_ITEMS = [
  { logo: solana, label: 'Solana' },
  { logo: ethereum, label: 'Ethereum' },
  { logo: bnb, label: 'BNB' },
  { logo: base, label: 'Base' },
  { icon: 'key', label: 'BIP-39' },
  { icon: 'layers', label: 'SLIP-0010' },
  { icon: 'lock', label: 'AES-256-GCM' },
  { icon: 'shield', label: 'PBKDF2' },
  { icon: 'puzzle', label: 'Manifest V3' },
  { icon: 'github', label: 'Open source' }
];

// Bottom row (moves right) — decorative "technologies & ecosystem" only,
// not a partnership claim (see Marquee's own component comment below).
// Real logos wired in as of prompt/0088 — `icon` stays on each item as
// the documented fallback the `item.logo ? <img/> : <Icon/>` pattern
// already used, not because it's still rendered once `logo` is set.
// JSON-RPC deliberately keeps `logo` unset — it's a protocol, not a
// company with a mark to show, so it stays on the generic `globe` icon.
const ROW2_ITEMS = [
  { logo: jupiter, icon: 'swap', label: 'Jupiter', boostDefault: true },
  { logo: raydium, icon: 'swap', label: 'Raydium' },
  { logo: uniswap, icon: 'swap', label: 'Uniswap' },
  { logo: pancakeswap, icon: 'swap', label: 'PancakeSwap' },
  { logo: dexscreener, icon: 'swap', label: 'DEX Screener' },
  { logo: helius, icon: 'zap', label: 'Helius' },
  { logo: quicknode, icon: 'zap', label: 'QuickNode' },
  { logo: alchemy, icon: 'zap', label: 'Alchemy' },
  { logo: infura, icon: 'zap', label: 'Infura' },
  { logo: walletconnect, icon: 'link', label: 'WalletConnect' },
  { icon: 'globe', label: 'JSON-RPC' }
];

function Pill({ item }) {
  // boostDefault (Jupiter only, see prompt/0088) — its logo is a dark
  // navy circular badge; grayscale(1) + the shared 0.6 default opacity
  // would leave it nearly invisible against this dark strip, so it gets
  // extra brightness in its own default (non-hover) state specifically.
  const mediaClass = `marquee__item-media${item.boostDefault ? ' marquee__item-media--boost' : ''}`;
  return (
    <span className="marquee__item">
      {item.logo ? (
        <img src={item.logo} alt="" className={mediaClass} />
      ) : (
        // Icon.jsx's className prop *replaces* its own 'icon' default
        // rather than appending to it — 'icon' has to be included here
        // explicitly or the shared width/height/color rule keyed off
        // .marquee__item .icon would stop applying.
        <Icon name={item.icon} className={`icon ${mediaClass}`} />
      )}
      {item.label}
    </span>
  );
}

// Duplicate-track seamless-loop technique, unchanged from before this
// rebuild — a track is rendered twice back to back, and the keyframe
// animates exactly -50% (or 0% -> -50% reversed), so the moment the first
// copy has fully scrolled past, the second copy is sitting in exactly the
// position the first one started in — no visible seam or jump.
function Track({ items }) {
  return (
    <div className="marquee__track">
      {items.map((item, i) => (
        <Pill item={item} key={i} />
      ))}
    </div>
  );
}

/**
 * Marquee — two independent, endless rows of pill-shaped chips, moving in
 * opposite directions at slightly different (deliberately non-synced)
 * speeds, styled as a dark-mode take on irisventure.com's own light pill
 * marquee. Purely decorative "technologies & ecosystem" — aria-hidden,
 * and never framed as a partnership/integration claim; it's the same
 * spirit as the existing badge-row elsewhere on the page, just in motion.
 *
 * Every logo/icon defaults to a dim, desaturated state (grayscale(1) +
 * reduced opacity) and snaps to full color only on its own pill's hover
 * (prompt/0088) — the track itself never pauses on hover anymore (it did
 * before this round; removed per the prompt's own instruction), so the
 * only thing hover changes is which one pill's media is lit up as it
 * drifts past the cursor.
 */
export default function Marquee() {
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee__row marquee__row--left">
        <Track items={ROW1_ITEMS} />
        <Track items={ROW1_ITEMS} />
      </div>
      <div className="marquee__row marquee__row--right">
        <Track items={ROW2_ITEMS} />
        <Track items={ROW2_ITEMS} />
      </div>
    </div>
  );
}
