import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import MarketingNav from '../../components/MarketingNav.jsx';
import FeatureShowcase from '../../components/FeatureShowcase.jsx';
import HowItWorks from '../../components/HowItWorks.jsx';
import Networks from '../../components/Networks.jsx';
import Vault from '../../components/Vault.jsx';
import ExtensionFlow from '../../components/ExtensionFlow.jsx';
import StatsSpotlight from '../../components/StatsSpotlight.jsx';
import Faq from '../../components/Faq.jsx';
import ClosingCta from '../../components/ClosingCta.jsx';
import Marquee from '../../components/Marquee.jsx';
import MarketingFooter from '../../components/MarketingFooter.jsx';
import Icon from '../../components/Icon.jsx';
import useHeadingSweep from '../../hooks/useHeadingSweep.js';
import { handleSlideAnchorClick, scrollToSlideId } from '../../utils/scrollToSlide.js';
import { CHROME_WEB_STORE_URL } from '../../constants/links.js';
import solana from '../../assets/vendor/images/chains/solana.png';
import ethereum from '../../assets/vendor/images/chains/ethereum.png';
import bnb from '../../assets/vendor/images/chains/bnb.png';
import base from '../../assets/vendor/images/chains/base.png';

// Served straight from apps/web/public/ — large (68MB) autoplaying loop, see
// the hero-rebuild plan for the loading/fallback handling around it.
const HERO_VIDEO_SRC = '/hero-video.mp4';

// Reverted from the real fluxio-wordmark.svg logotype mask back to a
// font-rendered mask — the SVG version looked bad once sized up dominant
// (per user feedback), so back to approximating the shape with text
// instead of using the vector artwork. The SVG file itself is left in
// place in public/, just no longer referenced.
//
// The video is clipped to "FLUXIO"'s letterforms via CSS mask-image, using
// a small self-contained SVG (its own viewBox, not tied to the page's own
// coordinate system) rather than referencing an in-page <mask> element —
// far more predictable geometry across browsers, since it's resolved as a
// normal image resource (mask-size/position/repeat apply cleanly) instead
// of going through SVG's separate, fiddlier maskContentUnits pathway. The
// mask's own font choice doesn't need to PIXEL-match the fallback <h1>
// below — only one of the two is ever visible at a time, and a data-URI
// SVG can't reliably load a webfont anyway — but the shape should still
// be in the same family (serif, not sans) so the reveal doesn't visibly
// swap letterform styles the instant the video takes over. Georgia is a
// universally available system serif, close enough in weight/shape to
// Fraunces (the fallback's actual font, see .hero-cinema__title in
// design.css) for this purpose without needing font loading here.
// letter-spacing here is an absolute SVG unit (not em-relative like CSS),
// set to roughly the same proportion of font-size as .hero-cinema__title's
// 0.1em tracking, so the mask's letterforms sit at the same spacing as
// the fallback text instead of visibly tightening up once the video
// takes over. viewBox widened from 1000 to 1200 alongside it — the wider
// tracking pushes "FLUXIO"'s total width out further, and mask-size:contain
// (see .hero-cinema__video in design.css) clips to this SVG's own bounds,
// so too-narrow a viewBox would crop the outer letters instead of just
// letterboxing around them.
const FLUXIO_MASK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 260"><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="800" font-size="230" letter-spacing="23">FLUXIO</text></svg>`;
const FLUXIO_MASK_URL = `url("data:image/svg+xml,${encodeURIComponent(FLUXIO_MASK_SVG)}")`;

const CHAINS = [
  { name: 'Solana', logo: solana },
  { name: 'Ethereum', logo: ethereum },
  { name: 'BNB', logo: bnb },
  { name: 'Base', logo: base }
];

// Features section heading (prompt 0127) — per-word fade+rise, staggered
// left-to-right, once as it enters the viewport. Revision 2 removed the
// "does." accent word entirely — every word now shares the exact same
// className/style, since the shimmer that used to be teal-and-separate
// on just that one word is now the SAME single continuous sweep painted
// on the parent <h2> and shown through every word identically (see
// design.css's own comment on .heading-accent's removal). Kept local
// rather than a shared component, per this codebase's own established
// convention of each section owning its per-word-reveal logic
// independently (see Vault.jsx/ExtensionFlow.jsx's duplicated reveal()
// helpers, and ClosingCta.jsx's own per-word map) — this is that same
// pattern's first appearance directly inside Landing.jsx.
const FEATURES_HEADLINE = 'Built like it matters, because it does.';
const FEATURES_HEADLINE_WORDS = FEATURES_HEADLINE.split(' ');

const FEATURES = [
  {
    icon: 'sprout',
    title: 'Real BIP-39 mnemonics',
    label: 'Generation',
    accent: 'gold',
    desc: 'Cryptographically secure 12 or 24-word recovery phrases with full checksum validation, generated with your platform CSPRNG, never a hardcoded word list.',
    variant: 'seed-blocks'
  },
  {
    icon: 'layers',
    title: 'One seed, four chains',
    label: 'Derivation',
    accent: 'teal',
    desc: 'SLIP-0010 for Solana, BIP-44 for every EVM chain. Ethereum, BNB and Base share a single derived account, nothing duplicated.',
    variant: 'node-diagram',
    nodes: ['Solana', 'Ethereum', 'BNB', 'Base']
  },
  {
    icon: 'lock',
    title: 'AES-256-GCM vault',
    label: 'Encryption',
    accent: 'gold',
    desc: 'PBKDF2 with 600,000 iterations, a unique salt and nonce every time. Wrong password or tampered ciphertext fails loudly, not silently.',
    variant: 'node-diagram',
    nodes: ['PBKDF2', 'salt', 'nonce', 'ciphertext', 'auth tag']
  },
  {
    icon: 'puzzle',
    title: 'Origin checked extension',
    label: 'Isolation',
    accent: 'teal',
    desc: 'Manifest V3, content script message validation, and scoped request/response types. Every webpage is treated as untrusted by default.',
    variant: 'gated-request'
  },
  {
    icon: 'check-shield',
    title: 'Approval gated signing',
    label: 'Approval',
    accent: 'gold',
    desc: 'A real pending request queue blocks every signature behind explicit user approval. No auto approve, no simulated responses.',
    variant: 'approval-pipeline'
  },
  {
    icon: 'eye-off',
    title: 'Nothing leaves your device',
    label: 'Privacy',
    accent: 'teal',
    desc: 'No custodial servers, no seed phrases over the network, no key material in webpage contexts. Private keys are derived on demand and scrubbed after use.',
    variant: 'contained-data'
  }
];

export default function Landing() {
  const videoRef = useRef(null);
  const [videoLive, setVideoLive] = useState(false);
  const heroPinRef = useRef(null);
  const reduceMotion = useReducedMotion();
  const location = useLocation();
  const navigate = useNavigate();
  // Continuous color sweep (prompt 0127 Revision 1) — see useHeadingSweep's
  // own comment. 1100ms covers this heading's own entrance in full (7
  // words, last delay 6*0.06=0.36s + its own 0.7s transition).
  const featuresSweep = useHeadingSweep({ entranceMs: 1100, reduceMotion });

  // Cross-page section links (prompt 0123 Revision 1): MarketingNav's MENU
  // overlay and MarketingFooter render on /privacy too, where these
  // section ids don't exist — their click handler now navigates here to
  // "/#id" instead (see scrollToSlide.js's handleSlideAnchorClick). Landing
  // remounts fresh every time (Shell() swaps it in/out of the tree), so a
  // plain mount effect reading the hash handles both that case and a
  // direct deep link to "/#id". Two rAFs, not zero: this component's own
  // children (Networks/Vault/ExtensionFlow) do their own pin/measurement
  // setup in their first effect pass, and jumping the scroll position
  // before that has run risks reading stale layout — the same category of
  // Lenis/timing fragility prompts 0066-0071 hit while building these
  // sections' scroll-pin mechanics, just on the "arrival" side instead of
  // the "already there" side. On-page anchor clicks (unchanged, instant)
  // never touch the URL hash at all, so they never re-trigger this.
  useEffect(() => {
    if (!location.hash) return undefined;
    const id = location.hash.slice(1);
    let secondFrame;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        scrollToSlideId(id);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [location.hash]);

  // Pinned hero → Stats transition: .hero-cinema sticks to the viewport top
  // (plain CSS position:sticky, see .hero-pin-wrap in design.css) while the
  // page scrolls through the wrapper's extra height below it; this reads
  // scroll progress through exactly that range and drives the transform
  // below. Stats itself needs no special handling, it just scrolls up
  // underneath in normal flow and reveals itself via its own existing
  // whileInView entrance. Disabled under reduced motion (see the JSX
  // below) rather than only skipped visually, so scroll-tied transform
  // math never runs for those users.
  //
  // The wordmark/copy visibly shrinks and moves up (scale + y), with
  // opacity only kicking in late as a finishing touch. (An earlier version
  // of this also drove a separate, slower-detaching transform for an
  // ambient glow orb near the wordmark — that orb was removed as a
  // decorative section-background element per prompt/0058, so only this
  // one output group remains.)
  const { scrollYProgress: heroProgress } = useScroll({
    target: heroPinRef,
    offset: ['start start', 'end start']
  });
  const heroScale = useTransform(heroProgress, [0, 1], [1, 0.55]);
  const heroY = useTransform(heroProgress, [0, 1], [0, -180]);
  const heroOpacity = useTransform(heroProgress, [0, 0.75, 1], [1, 1, 0]);
  const heroPointerEvents = useTransform(heroProgress, (v) => (v > 0.85 ? 'none' : 'auto'));

  useEffect(() => {
    const maskSupported =
      typeof CSS !== 'undefined' &&
      CSS.supports &&
      (CSS.supports('mask-image', 'none') || CSS.supports('-webkit-mask-image', 'none'));
    if (!maskSupported) return undefined;

    const video = videoRef.current;
    if (!video) return undefined;

    // If the browser already has it buffered (e.g. bfcache), canplay may
    // never fire again — check readyState up front too.
    if (video.readyState >= 3) {
      setVideoLive(true);
      return undefined;
    }
    const onCanPlay = () => setVideoLive(true);
    video.addEventListener('canplay', onCanPlay);
    return () => video.removeEventListener('canplay', onCanPlay);
  }, []);

  return (
    <div className="mkt-page">
      <MarketingNav />

      <a
        href="#get-started"
        className="side-badge"
        onClick={(e) => handleSlideAnchorClick(e, 'get-started', navigate)}
        aria-label="Non custodial, jump to Get started"
      >
        <span className="side-badge__icon">
          <Icon name="shield" />
        </span>
        <span className="side-badge__label">Non custodial</span>
      </a>

      <div
        ref={heroPinRef}
        className={`hero-pin-wrap ${reduceMotion ? 'hero-pin-wrap--static' : ''}`}
        id="hero"
      >
        <section className="hero-cinema">
          <motion.div
            className="hero-cinema__content"
            style={
              reduceMotion
                ? undefined
                : { scale: heroScale, y: heroY, opacity: heroOpacity, pointerEvents: heroPointerEvents }
            }
          >
            <div className={`hero-cinema__wordmark ${videoLive ? 'hero-cinema__wordmark--live' : ''}`}>
              <video
                ref={videoRef}
                className="hero-cinema__video"
                src={HERO_VIDEO_SRC}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                aria-hidden="true"
                style={{ WebkitMaskImage: FLUXIO_MASK_URL, maskImage: FLUXIO_MASK_URL }}
              />
              <h1 className="hero-cinema__title" aria-hidden={videoLive || undefined}>
                FLUXIO
              </h1>
            </div>

            <p className="hero-cinema__eyebrow-line">
              Non custodial wallet · Solana · Ethereum · BNB · Base
            </p>

            <p className="hero-cinema__tagline">
              Secure. <em>Send</em>. Explore.
            </p>

            <div className="cta-panel__actions hero-cinema__actions">
              <a
                className="btn btn-primary btn-lg"
                href={CHROME_WEB_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="download" /> Download Now
              </a>
              <a
                className="btn btn-outline btn-lg"
                href="#extension"
                onClick={(e) => handleSlideAnchorClick(e, 'extension', navigate)}
              >
                <Icon name="puzzle" /> Get Extension
              </a>
            </div>
          </motion.div>

          <p className="hero-cinema__hint">
            Scroll to explore <span aria-hidden="true">↓</span>
          </p>
        </section>
      </div>

        <div className="h-scroll__slide h-scroll__slide--spotlight" id="stats">
          <StatsSpotlight />
        </div>

        <div className="h-scroll__slide" id="features">
          <div className="h-scroll__stack">
            <div className="section-head">
              <span className="eyebrow">Everything a wallet should be</span>
              <h2
                className="section-head__title"
                ref={featuresSweep.ref}
                style={reduceMotion ? undefined : { animationPlayState: featuresSweep.sweeping ? 'running' : 'paused' }}
              >
                {reduceMotion ? (
                  FEATURES_HEADLINE
                ) : (
                  FEATURES_HEADLINE_WORDS.map((word, i) => {
                    const isLast = i === FEATURES_HEADLINE_WORDS.length - 1;
                    return (
                      <motion.span
                        key={word + i}
                        className="section-head__word"
                        initial={{ opacity: 0, y: 22 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true, amount: 0.6 }}
                        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: i * 0.06 }}
                      >
                        {word}
                        {isLast ? '' : ' '}
                      </motion.span>
                    );
                  })
                )}
              </h2>
              <p className="section-head__desc">
                Every module below is real, tested code, not a placeholder. See the Phase 1 audit
                in the project README for what's implemented and what's still scaffolding.
              </p>
            </div>
            <FeatureShowcase features={FEATURES} />
          </div>
        </div>

        <HowItWorks />

        <Networks />

        <Vault />

        <ExtensionFlow />

        <div className="h-scroll__slide" id="faq">
          <Faq />
        </div>

        <div className="h-scroll__slide" id="get-started">
          <ClosingCta />
        </div>

        <Marquee />

      <MarketingFooter />
    </div>
  );
}
