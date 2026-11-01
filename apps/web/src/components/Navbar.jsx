import React from 'react';
import Icon from './Icon.jsx';
import ConnectButton from './ConnectButton.jsx';
import logoBlue from '../assets/images/logo-fluxio-mono.png';

export default function Navbar() {
  return (
    <header className="navbar topbar">
      <div className="nav-left">
        <button className="logo"><img src={logoBlue} alt="Fluxio" style={{height:26}}/></button>
      </div>
      <div className="nav-right">
        <div className="nav-actions">
          <button className="icon-btn"><Icon name="search"/></button>
          <button className="icon-btn"><Icon name="bell"/></button>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
