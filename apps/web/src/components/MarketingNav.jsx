import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from './Icon.jsx';
import { handleSlideAnchorClick } from '../utils/scrollToSlide.js';
import logo from '../assets/images/logo-fluxio-mono.png';

const LINKS = [
  { num: '01', label: 'Networks', href: '#networks' },
  { num: '02', label: 'Vault', href: '#vault' },
  { num: '03', label: 'Extension', href: '#extension' },
  { num: '04', label: 'Get started', href: '#get-started' }
];

export default function MarketingNav() {
  const [open, setOpen] = useState(false);
  const [pastHero, setPastHero] = useState(false);
  const navigate = useNavigate();

  const close = () => setOpen(false);

  // The nav is transparent while floating over the hero, then gains a
  // solid background once scrolled past it (matches the reference: nav
  // stays see-through during the pin/shrink transition, goes opaque only
  // once section 2 has taken over). rootMargin shifts the observed area up
  // by the nav's own height, so "past hero" fires right as the nav bar
  // itself would start overlapping section 2 rather than exactly at the
  // hero's literal bottom edge.
  useEffect(() => {
    const hero = document.getElementById('hero');
    if (!hero || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => setPastHero(!entry.isIntersecting),
      { rootMargin: '-80px 0px 0px 0px' }
    );
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <header className={`mkt-nav ${pastHero ? 'mkt-nav--solid' : ''}`}>
        <div className="mkt-nav__bar">
          <Link to="/" className="mkt-nav__logo" aria-label="Fluxio home">
            <img src={logo} alt="" />
            <span className="mkt-nav__wordmark">Fluxio</span>
          </Link>
          <div className="mkt-nav__actions">
            <a
              href="#get-started"
              className="mkt-nav__cta"
              onClick={(e) => handleSlideAnchorClick(e, 'get-started', navigate)}
            >
              <Icon name="download" /> Download
            </a>
            <button
              type="button"
              className="mkt-nav__menu"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
              aria-expanded={open}
            >
              <span className="mkt-nav__menu-label">Menu</span>
              <span className="mkt-nav__burger">
                <span className="mkt-nav__burger-line" />
                <span className="mkt-nav__burger-line mkt-nav__burger-line--accent" />
              </span>
            </button>
          </div>
        </div>
      </header>

      <div className={`mkt-overlay ${open ? 'mkt-overlay--open' : ''}`} role="dialog" aria-modal="true" aria-hidden={!open}>
        <div className="mkt-overlay__inner">
          <div className="mkt-overlay__top">
            <img src={logo} alt="Fluxio" className="mkt-overlay__logo" />
            <button type="button" className="mkt-overlay__close" onClick={close} aria-label="Close menu">
              <span className="mkt-overlay__close-label">Close</span>
              <span className="mkt-overlay__close-x">
                <span />
                <span />
              </span>
            </button>
          </div>
          <nav className="mkt-overlay__nav">
            {LINKS.map((link, i) =>
              link.to ? (
                <Link
                  key={link.label}
                  to={link.to}
                  className="mkt-overlay__link"
                  style={{ '--i': i }}
                  onClick={close}
                >
                  <span className="mkt-overlay__num">{link.num}</span>
                  <span className="mkt-overlay__label">{link.label}</span>
                </Link>
              ) : (
                <a
                  key={link.label}
                  href={link.href}
                  className="mkt-overlay__link"
                  style={{ '--i': i }}
                  onClick={(e) => {
                    handleSlideAnchorClick(e, link.href.slice(1), navigate);
                    close();
                  }}
                >
                  <span className="mkt-overlay__num">{link.num}</span>
                  <span className="mkt-overlay__label">{link.label}</span>
                </a>
              )
            )}
          </nav>
          <div className="mkt-overlay__foot">
            <span>Non custodial · Solana · Ethereum · BNB · Base</span>
            {/* Prompt 0165 added Telegram's masked-icon treatment here
                (see MarketingFooter's identical usage / design.css's
                .icon-mask); the plain-text GitHub link that used to sit
                alongside it was removed by prompt 0216 because the repo
                is private. The wrapper stays so justify-content:
                space-between on the parent still only ever sees two
                children. */}
            <div className="mkt-overlay__foot-links">
              <a
                href="https://t.me/FluxioWallet_bot"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Telegram"
                title="Telegram"
                className="mkt-overlay__foot-icon"
              >
                <span className="icon-mask" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
