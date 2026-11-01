import React from 'react';
import Icon from './Icon.jsx';
import logoMono from '../assets/images/logo-fluxio-mono.png';

export default function Sidebar({ collapsed = false, onToggle = () => {} }) {
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-top">
        <button className="brand"><img src={logoMono} alt="Fluxio" className="brand-logo" /></button>
      </div>
      <nav className="sidebar-nav">
        <a href="/" className="nav-item"><Icon name="wallet"/><span>Wallet</span></a>
        <a href="/" className="nav-item"><Icon name="swap"/><span>Swap</span></a>
        <a href="/" className="nav-item"><Icon name="nft"/><span>NFTs</span></a>
      </nav>
      <button className="sidebar-toggle" onClick={onToggle} aria-label="Toggle sidebar">{collapsed ? '▶' : '◀'}</button>
    </aside>
  );
}
