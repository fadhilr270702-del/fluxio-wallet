/**
 * Action-icon popup. Deliberately thin: this is the one surface a user can
 * lose mid-flow (Chrome closes the popup the instant it loses focus), so it
 * only ever does two things — a quick unlock, or handing off to the full
 * onboarding tab for anything that takes more than one screen (create /
 * import). It never runs create/import itself.
 *
 * Like onboarding.js, this file never touches @fluxio/crypto or
 * @fluxio/services directly — only background/background.js does. This
 * extends to the Send flow below too: every amount shown here (balance,
 * fee, total, max-sendable) is a decimal *string* computed by
 * background.js's FLUXIO_INTERNAL_ESTIMATE_TRANSFER — this file never does
 * lamports/SOL or wei/ETH arithmetic itself, since it can't import
 * @fluxio/utils/{solAmount,ethAmount} (unbundled, same rule as everywhere
 * else here). The Send flow is fully chain-agnostic (Tahap D): it branches
 * only on each network's `accountType` ('solana' | 'evm'), the one thing
 * this file has to know locally about a network's shape, mirroring the
 * same split background.js's own handlers make.
 *
 * Presentation (this redesign): the wallet-ready screen is a two-zone
 * "bottom sheet" layout (deep-teal account zone + near-black scrollable
 * network panel — see popup.css). Every other screen (unlock, no-wallet,
 * Send form/confirm/result, Receive, network picker) is a single padded
 * `.screen` — same flat stack these all already were, just re-tokenized
 * via ../shared/theme.css. None of the message calls, validation, or
 * error handling below changed to build this — only the HTML strings did.
 */
import {
  sendInternal,
  escapeHtml,
  DEV_NETWORKS_STORAGE_KEY,
  SWAP_SLIPPAGE_STORAGE_KEY,
  PORTFOLIO_TOTAL_CACHE_STORAGE_KEY,
  CARD_BACKGROUND_STORAGE_KEY,
  NOTIFICATIONS_STATE_STORAGE_KEY
} from '../shared/messaging.js';
// The password->seed reveal flow (Settings' "Reveal Secret Phrase") is
// security-sensitive enough that it has exactly one implementation,
// shared with settings/settings.js's own full-tab page — see that
// module's header comment for the invariants it guarantees regardless of
// which page embeds it.
import { renderRevealPasswordPrompt } from '../shared/revealSeed.js';
// Pure decision logic for the Swap screen's data-loading resilience
// (prompt 0116) — kept in its own module (not inline here) specifically
// so it's unit-testable without a DOM/chrome-API mock harness; see that
// module's own header comment for the full reasoning and
// apps/extension/test/swapAssetSources.test.js for its tests.
import { resolveSwapAssetSources } from '../shared/swapAssetSources.js';
// MAX-button field cosmetics (prompt 0214): drops only trailing zeros —
// never rounds, never truncates a significant digit (the 0213-proven
// "MAX leaves exactly 0" guarantee depends on that); see that module's
// header for why trimAmount() is NOT legal here.
import { stripTrailingZeros } from '../shared/amountStrings.js';
// Price-impact display clamp (0219 Revisi 2) — pure, unit-tested in
// test/priceImpact.test.js; see that module's header for why the EVM
// value can be negative and why the clamp lives in display only.
import { formatPriceImpact } from '../shared/priceImpact.js';
// Review-button balance gate (0220 keputusan 4 / opsi D1) — pure, one
// decision point for BOTH chains; see that module's header for the 0219
// finding (Review used to stay active with 0 balance) it closes.
import { decimalToRaw, rawToDecimal, hasSufficientPayBalance } from '../shared/swapBalanceGate.js';
// 0227 (0225 K1/K3): the EVM swap network list + per-network reserves —
// shared/ because popup.js cannot import @fluxio/* (locked equal to
// evmSwapService's own list by test/swapNetworks.test.js).
import { EVM_SWAP_NETWORK_KEYS, SWAP_EVM_FEE_RESERVES_WEI, isEvmSwapNetworkKey, normalizeSwapNetworkKey } from '../shared/swapNetworks.js';
// "Forgot password?" / Reset wallet (prompt 0124) — same "extract the
// decision, keep the side effects here" pattern as the two imports
// above; see that module's own header comment.
import { isResetConfirmationValid } from '../shared/resetConfirmation.js';
// Embedded token icons (prompt 0206) — mint-keyed lookup over the bundled
// PNGs under ../assets/tokens/; null for any unlisted mint, and the
// caller then renders the colored-letter placeholder unchanged. Never a
// network image (see that module's header + test/tokenIcons.test.js).
import { tokenIconSrc } from '../shared/tokenIcons.js';
// Notifications inbox (prompt 0170) — countUnread() drives the header
// bell's dot (read directly from NOTIFICATIONS_STATE_STORAGE_KEY, no
// message round trip needed for that — see this file's own
// renderWalletReady() comment); the parser/DOM-builder pair is what
// turns a `'html'`-format announcement into real, safely-built DOM nodes
// — never innerHTML — see either module's own header comment.
import { countUnread } from '../shared/notificationBadge.js';
import { parseRestrictedHtmlToNodes } from '../shared/richTextParse.js';
import { renderRestrictedHtmlNodes } from '../shared/renderRestrictedHtml.js';
// Same pure module background.js's alarm logic uses (prompt 0117) — here
// only for its two plain constants (building the Settings screen's
// <select> options and formatting the current-value label), never for
// shouldAutoLock() itself, which only ever needs to run in background.js
// (the one place that actually knows "now" relative to a real lastActivityAt
// and can call walletService.lock()).
import { AUTO_LOCK_NEVER, AUTO_LOCK_OPTIONS_MINUTES } from '../shared/autoLockDecision.js';
// Portfolio fiat total (prompt 0118) — same pattern as autoLockDecision.js
// above: this file never computes a total itself (that's background.js's
// job, via FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE), only builds the Currency
// <select>'s options from the same one list Settings' currency picker and
// background.js's own validation both derive from. Deliberately imports
// shared/portfolioDisplay.js, NOT its sibling shared/portfolioValue.js —
// that one needs @fluxio/constants and must never be imported from an
// unbundled page (see its own header comment for the real bug this
// exact mistake caused, fixed in a Revision 1 to prompt 0118).
import { SUPPORTED_CURRENCIES } from '../shared/portfolioDisplay.js';
// Two-step "Add custom token" form (prompt 0119) — see that module's own
// header comment for the one hard rule it protects (Solana decimals is
// never user-editable). Everything else about this form (which HTML to
// show, wiring click handlers, the lookup-status state machine) stays
// inline below, same as every other screen in this file.
import { LOOKUP_STATUS, isDecimalsEditable, canOfferManualFallback } from '../shared/addTokenFlow.js';
// "Card background" setting (prompt 0121) — same pure-default-resolution
// pattern as autoLockDecision.js above, here only for the two value
// constants + the <select> options list; resolveCardBackground() is the
// one bit of real logic (unset/corrupt storage -> the Accent default),
// see that module's own header comment for why it's this small.
import { CARD_BACKGROUND_ACCENT, CARD_BACKGROUND_OPTIONS, resolveCardBackground } from '../shared/cardBackground.js';

const app = document.getElementById('app');

// Small, consistent stroke-icon set (Feather-style), inlined as raw SVG
// strings — no icon font/sprite/new dependency, just markup. `currentColor`
// so each usage site controls color via CSS.
const ICONS = {
  // Paper plane (Send) — swapped from a plain diagonal arrow for a clearer
  // "sending" metaphor; same viewBox/stroke-width/size as every other icon
  // here so it reads at the same optical weight.
  send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>',
  // Download-style arrow-into-tray (Receive) — the deliberate visual pair
  // to Send's paper plane (an outbound glyph vs. an inbound one), not just
  // a mirrored arrow.
  receive: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0114.13-3.36L23 10M1 14l5.36 4.36A9 9 0 0020.49 15"></path></svg>',
  settings: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"></path></svg>',
  lock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V7a4 4 0 018 0v4"></path></svg>',
  copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>',
  check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>',
  back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>',
  // Card + centered plus (Buy) — placeholder action, common "buy crypto"
  // wallet glyph. The outer rect's bounding box is exactly centered on the
  // 24x24 viewBox; the plus sits centered within the card's body (below
  // the magstripe line), not the whole card, which reads better than
  // dead-centering it against the stripe.
  buy: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"></rect><line x1="2" y1="9" x2="22" y2="9"></line><line x1="12" y1="12" x2="12" y2="17"></line><line x1="9.5" y1="14.5" x2="14.5" y2="14.5"></line></svg>',
  // Two opposing arrows forming a cycle (Swap) — placeholder action, the
  // classic "repeat/exchange" glyph; rotationally symmetric by
  // construction, so no optical-centering correction needed.
  swap: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 014-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 01-4 4H3"></path></svg>',
  // Multi-account: chevron-down affordance on the account card's clickable
  // label, pencil for inline rename, plus for "add account".
  chevronDown: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>',
  pencil: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
  // Clock face (Activity) — same viewBox/stroke-width/size as Refresh/
  // Settings, its two header-row neighbors, so it reads at the same
  // optical weight; a plain, unambiguous "history/time" glyph.
  activity: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
  // Bell (Notifications, prompt 0170) — same viewBox/stroke-width/size as
  // Refresh/Activity/Settings, its header-row neighbors.
  bell: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 01-3.46 0"></path></svg>'
};

// Cosmetic labels + iteration order only — the actual RPC endpoint,
// decimals, and symbol always come from @fluxio/constants via
// background.js's FLUXIO_INTERNAL_GET_BALANCE/FLUXIO_INTERNAL_ESTIMATE_TRANSFER
// responses. This file can't import @fluxio/constants itself (unbundled,
// same rule as everywhere else in this extension), so the known network
// keys/labels/accountType/logoChain are the one thing that has to live
// here — `accountType` drives which address field, address-format check
// and decimal precision the Send flow below uses for a given network;
// `logoChain` drives which chain-logo image a network's row shows (a
// devnet/sepolia/local network shares its parent chain's logo — a badge,
// not a distinct logo, marks it as non-mainnet). Nothing precision- or
// RPC-related is decided here.
const NATIVE_NETWORKS = [
  { key: 'solana', label: 'Solana', accountType: 'solana', logoChain: 'solana' },
  { key: 'ethereum', label: 'Ethereum', accountType: 'evm', logoChain: 'ethereum' },
  { key: 'bnb', label: 'BNB Chain', accountType: 'evm', logoChain: 'bnb' },
  { key: 'base', label: 'Base', accountType: 'evm', logoChain: 'base' }
];

// Only rendered when Settings' "Developer networks" toggle is ON (see
// shared/messaging.js's DEV_NETWORKS_STORAGE_KEY) — same cosmetic-only
// key/label list as NATIVE_NETWORKS above, each marked with a badge so they
// can't be mistaken for the mainnet rows above them. `badge` is 'TEST' for
// a hosted public testnet and 'LOCAL' for a locally-run dev node
// (solana-local, ethereum-local) — a developer's own machine isn't a "test
// network" in the same sense as a shared public cluster, so it gets a
// visually distinct badge rather than being lumped in under TEST.
// There is no "active network" selection anywhere in this popup — every
// row is always fetched independently and shown at once — so the "fall
// back to mainnet if the active network is a test one" requirement is
// trivially satisfied by construction: a hidden test network can never be
// "active" when nothing tracks a single current network in the first place.
const DEV_NETWORKS = [
  { key: 'solana-devnet', label: 'Solana Devnet', badge: 'TEST', accountType: 'solana', logoChain: 'solana' },
  { key: 'ethereum-sepolia', label: 'Ethereum Sepolia', badge: 'TEST', accountType: 'evm', logoChain: 'ethereum' },
  { key: 'solana-local', label: 'Solana Local', badge: 'LOCAL', accountType: 'solana', logoChain: 'solana' },
  { key: 'ethereum-local', label: 'Ethereum Local', badge: 'LOCAL', accountType: 'evm', logoChain: 'ethereum' }
];

// Tahap D: Send UI covers every Solana AND EVM test network the transfer
// services support, PLUS every mainnet network as of prompt 0173.
//
// CORRECTION (prompt 0173): this array used to be testnet/local keys only,
// with a comment claiming "mainnet sending isn't enabled yet either way
// (background.js hard-rejects it regardless of accountType — this array
// only controls whether the UI entry point shows up, it isn't the real
// guard)". That was true right up until it wasn't: this array was never
// actually a no-op UI-only decision — it's the one thing that puts a
// "Send" action row/network-picker entry in front of a user at all, so
// leaving it testnet-only here would have SILENTLY kept every mainnet
// network unreachable through the Send flow even after background.js's
// own `network.isTestnet !== true` guard was removed — caught live during
// this exact prompt's own VERIFIKASI (mainnet Solana never appeared in the
// Send network picker at all), not assumed from reading source alone. Now
// includes every NATIVE_NETWORKS key too, so mainnet is reachable exactly
// like every other configured network, matching this prompt's own stated
// goal (no new path, the same one testnet already used, minus the brake).
const SENDABLE_NETWORK_KEYS = [
  'solana',
  'ethereum',
  'bnb',
  'base',
  'solana-devnet',
  'solana-local',
  'ethereum-sepolia',
  'ethereum-local'
];

// Placeholder amount used only for a fee-only MAX-button estimate (see
// renderSendForm's maxBtn handler, native assets only — a token's own MAX
// button never round-trips through ESTIMATE_TRANSFER at all, see that
// handler's own comment) — a plain native transfer's fee doesn't depend on
// the amount being sent on either chain (Solana's flat SystemProgram.transfer
// fee, or EVM's fixed 21000-gas plain transfer), so any small valid amount
// works here regardless of which chain the network belongs to. A WHOLE
// number ("1", not "0.000000001") specifically: prompt 0113 originally used
// a 9-decimal-precision placeholder here, which is only valid for assets
// with at least 9 decimals — harmless for native SOL/ETH (always 9/18
// decimals) but would have broken outright for a 6-decimal token (USDC) had
// this same placeholder ever been reused for a token estimate. A whole
// number carries no fractional precision at all, so it stays valid
// regardless of decimals — decimals-agnostic by construction, not by luck.
const FEE_ESTIMATE_PLACEHOLDER_AMOUNT = '1';

// ---- Swap (prompt 0115 quotes; prompt 0200 real execution — Solana mainnet only) ----

// Wrapped SOL's mint address — Jupiter's canonical stand-in for "native
// SOL" as an input/output mint (SPL instructions can only ever move an
// SPL token account, never the native lamports balance directly).
// Duplicated from @fluxio/services/swapService.js's own NATIVE_SOL_MINT
// constant rather than imported — popup.js can't import @fluxio/services
// at all (unbundled, same rule as everywhere else in this file); this is
// the same "small cross-cutting constant lives in both places" tradeoff
// NATIVE_NETWORKS/DEV_NETWORKS below already make for network keys.
const SWAP_NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

const SWAP_SLIPPAGE_PRESETS_BPS = [10, 50, 100]; // 0.1% / 0.5% / 1%
const SWAP_DEFAULT_SLIPPAGE_BPS = 50; // 0.5% — this feature's own specified default
const SWAP_MIN_SLIPPAGE_BPS = 1; // 0.01%
const SWAP_MAX_SLIPPAGE_BPS = 5000; // 50% — same sanity ceiling swapService.js's own requireValidSlippageBps enforces server-side
const SWAP_QUOTE_REFRESH_MS = 15000;
// Prompt 0200 fase 2 — the Review screen's "Network fee" is a REAL number
// now: entering Review calls FLUXIO_INTERNAL_PREVIEW_SWAP_FEES (a real
// Jupiter /swap build, quote not consumed) and shows base + prioritization
// from that response. These constants only back the MAX-reserve formula
// below and the display fallback while the preview is in flight.
const SWAP_BASE_FEE_LAMPORTS = 5000; // Solana's per-signature base fee
// SAFETY UPPER BOUND for one token account's rent, prompt 0205 (dated
// 18 September 2026): the chain's LIVE getMinimumBalanceForRentExemption(165)
// answered 1,488,440 lamports on two independent keyless endpoints that
// day, while this figure (2,039,280 — the pre-reduction value this file
// used to hardcode as SWAP_WSOL_WRAP_RENT_LAMPORTS) is deliberately KEPT
// as the conservative fallback the MAX reserve uses until a live value
// has arrived via PREVIEW_SWAP_FEES. It is a reserve ceiling ONLY —
// never a display value: everything shown to the user comes from the
// live RPC number.
const SWAP_TOKEN_ACCOUNT_RENT_FALLBACK_LAMPORTS = 2039280;
// LIVE one-token-account rent from the last PREVIEW_SWAP_FEES response
// (background fetches it once per worker life and passes it along).
let lastTokenAccountRentLamports = 0;
// Prompt 0206 butir 5: mirrors @fluxio/services/swapService.js's
// SWAP_PRIORITY_FEE_CAP_LAMPORTS (popup.js is unbundled and cannot import
// it — same mirrored-constant pattern as SWAP_BASE_FEE_LAMPORTS above).
// Every Jupiter build request, preview and execute alike, caps its
// prioritization fee at this many lamports (priorityLevel 'high'), and
// swapService rejects any response above it pre-sign — so Review's
// "Network fee (max)" (base + this cap) is a true ceiling, not an
// estimate, and carries no "~".
const SWAP_PRIORITY_FEE_CAP_LAMPORTS = 150000;
// Priority-fee headroom for the MAX reserve: the real prioritization fee
// is only known after a build (0199 measured 56k-100k lamports), so MAX
// reserves max(this floor, 2x the last preview's own real number).
const SWAP_PRIORITY_FEE_HEADROOM_LAMPORTS = SWAP_PRIORITY_FEE_CAP_LAMPORTS;
// The last PREVIEW_SWAP_FEES response's real prioritization fee — feeds
// the MAX formula above once a Review has been visited this session.
let lastSwapPriorityFeeLamports = 0;
// 0241 Opsi A — one counter per Review render: a PREVIEW response whose
// epoch is no longer current belongs to an OLD render and writes nothing
// (the 22 Oktober incident's on-screen number was a stale late write).
let swapReviewRenderEpoch = 0;

/**
 * MAX-button reserve (lamports) when "You pay" is native SOL. Prompt
 * 0205 (owner decision, opsi 3): TWO token-account rents are reserved —
 * the temporary wrapped-SOL account (created and closed in the same
 * transaction, rent refunded, but the balance must COVER it at
 * execution time) AND one possibly-new output token account (rent
 * permanent when the ATA doesn't exist yet — the real incident: a MAX
 * swap into a token without its ATA failed at simulation because the
 * old formula reserved nothing for it). Both use the LIVE rent when
 * known, else the conservative fallback above — deliberately no RPC
 * existence check on MAX click; when the ATA turns out to exist, the
 * unreserved sliver simply stays unswapped.
 */
function swapNativeMaxReserveLamports() {
  const rent = lastTokenAccountRentLamports > 0 ? lastTokenAccountRentLamports : SWAP_TOKEN_ACCOUNT_RENT_FALLBACK_LAMPORTS;
  return 2 * rent + SWAP_BASE_FEE_LAMPORTS + Math.max(SWAP_PRIORITY_FEE_HEADROOM_LAMPORTS, 2 * lastSwapPriorityFeeLamports);
}

// EVM native gas reserves for MAX and for the Review balance gate — PER
// NETWORK since 0227 (owner keputusan 0225 K3; the single bnb-tuned pair
// did not cover Ethereum, measured in the 0225 spike). The map itself
// lives in shared/swapNetworks.js (one place, locked against
// evmSwapService's own network list by unit test); this helper is the one
// popup-side access point. The authoritative checks stay server side with
// LIVE figures (EXECUTE pagar e, the approve legs' combined ceilings).
function evmSwapReserves(networkKey) {
  return SWAP_EVM_FEE_RESERVES_WEI[networkKey] || SWAP_EVM_FEE_RESERVES_WEI.bnb;
}

function networkEntry(key) {
  return [...NATIVE_NETWORKS, ...DEV_NETWORKS].find((n) => n.key === key);
}

function isSendableNetwork(key) {
  return SENDABLE_NETWORK_KEYS.includes(key);
}

function networkLabel(key) {
  return networkEntry(key)?.label || key;
}

function networkAccountType(key) {
  return networkEntry(key)?.accountType || null;
}

/** Relative path (from popup/popup.html) to a network's chain logo — assets/chains/{solana,ethereum,bnb,base}.png, copied from apps/web/src/assets/vendor/images/chains/. A devnet/sepolia/local network reuses its parent chain's logo (see DEV_NETWORKS' own comment above) — its badge is what marks it as non-mainnet, not a distinct icon. */
function chainLogoSrc(key) {
  return `../assets/chains/${networkEntry(key)?.logoChain}.png`;
}

/** Full display precision per chain — Solana's lamport (9 decimals) vs EVM's wei (18 decimals) — used for the Send flow's "Available"/amount/fee/total rows, where truncating too aggressively could hide a meaningful digit. The general balances-list row (trimAmount's own default of 6) stays cosmetic-only and unrelated to this. */
function amountPrecisionFor(key) {
  return networkAccountType(key) === 'evm' ? 18 : 9;
}

/** 'TEST' | 'LOCAL' | null — see DEV_NETWORKS' own comment above. NATIVE_NETWORKS entries have no `badge` property, so a mainnet row correctly gets none. */
function networkBadge(key) {
  return networkEntry(key)?.badge || null;
}

/** Renders the badge span for a network, or '' for a mainnet row (no badge). */
function badgeMarkup(key) {
  const badge = networkBadge(key);
  return badge ? ` <span class="badge-${badge.toLowerCase()}">${badge}</span>` : '';
}

function getDevNetworksEnabled() {
  return new Promise((resolve) => {
    chrome.storage.local.get([DEV_NETWORKS_STORAGE_KEY], (result) => {
      resolve(result?.[DEV_NETWORKS_STORAGE_KEY] === true);
    });
  });
}

/** Same shape/reasoning as getDevNetworksEnabled() above — a plain chrome.storage.local read, defaulted via resolveCardBackground() (shared/cardBackground.js) rather than a bare `=== true` check, since this setting's real value is a two-option string, not a boolean. */
function getCardBackground() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CARD_BACKGROUND_STORAGE_KEY], (result) => {
      resolve(resolveCardBackground(result?.[CARD_BACKGROUND_STORAGE_KEY]));
    });
  });
}

/** The last computed portfolio total, read directly (see PORTFOLIO_TOTAL_CACHE_STORAGE_KEY's own comment) — a neutral placeholder on a genuinely fresh install/first-ever unlock, when nothing has ever been cached yet. */
function getCachedPortfolioTotal() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PORTFOLIO_TOTAL_CACHE_STORAGE_KEY], (result) => {
      const cached = result?.[PORTFOLIO_TOTAL_CACHE_STORAGE_KEY];
      resolve(cached && typeof cached.totalFormatted === 'string' ? cached : { totalFormatted: '—', hasExcludedAssets: false });
    });
  });
}

/**
 * The last-known notifications state, read directly from chrome.storage.local
 * (see NOTIFICATIONS_STATE_STORAGE_KEY's own comment in shared/messaging.js)
 * — same "instant last-known display, no round trip" pattern as
 * getCachedPortfolioTotal() above, used here for the header bell icon's
 * unread dot specifically so it shows correctly the instant this screen
 * paints, before this open's own throttled background refresh (fired
 * separately, see renderWalletReady()) has any chance to resolve.
 */
function getCachedNotificationsState() {
  return new Promise((resolve) => {
    chrome.storage.local.get([NOTIFICATIONS_STATE_STORAGE_KEY], (result) => {
      const stored = result?.[NOTIFICATIONS_STATE_STORAGE_KEY];
      resolve({
        announcements: Array.isArray(stored?.announcements) ? stored.announcements : [],
        readIds: Array.isArray(stored?.readIds) ? stored.readIds : []
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Matches the exact message background.js throws when a wallet-state check fails — every Send-flow step checks for this specifically so it can recover via unlock-and-resume instead of just showing a dead-end error. */
function isLockedError(error) {
  return error?.message === 'Wallet is locked.';
}

/**
 * Fast, non-authoritative "does this look like a valid address for this
 * network's chain" check for live form feedback only. NOT the real
 * validator — that's transactionService's/evmTransactionService's own
 * address check, which runs authoritatively in the background on every
 * estimate/send call and is what actually decides. This is just a charset/
 * length heuristic, purely to give the user quick feedback while typing.
 */
function looksLikeAddress(networkKey, value) {
  return networkAccountType(networkKey) === 'evm'
    ? /^0x[0-9a-fA-F]{40}$/.test(value)
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/** The current session's own address for this network's chain — Ethereum/BNB/Base/Sepolia/Ethereum Local all share the one EVM account, Solana's networks all share the one Solana account. */
function senderAddressFor(networkKey, wallet) {
  return networkAccountType(networkKey) === 'evm' ? wallet.accounts.evm.address : wallet.accounts.solana.address;
}

/** Truncates an address for display only ("HM2t…6TFy") — never used for anything but a label; every copy action and every Send confirmation screen always uses the full untruncated address. */
function shortenAddress(address, front = 4, back = 4) {
  if (!address || address.length <= front + back + 1) return address || '—';
  return `${address.slice(0, front)}…${address.slice(-back)}`;
}

/** Deterministic HSL background color from an address (or any stable string) — the same account always gets the same color across popup opens, with nothing stored anywhere to make that true. Pure/cheap string hash, not cryptographic. */
function avatarColorFor(seedString) {
  let hash = 0;
  for (let i = 0; i < seedString.length; i++) {
    hash = (hash * 31 + seedString.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360}, 55%, 42%)`;
}

/** First letter of an account name, uppercased, for the drawer's circular avatars. Falls back to "?" only if given an empty string — shouldn't happen in practice since renameAccountEntry rejects empty names server-side, but a display-layer fallback costs nothing. */
function avatarInitial(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

/** Copies text to the clipboard, falling back to a hidden-textarea + execCommand('copy') if the async Clipboard API isn't available/permitted in this context. Never throws — callers just check the resolved boolean. */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      return true;
    } catch {
      return false;
    }
  }
}

/** Wires a chip/button's click to copy `text` and show brief "Copied ✓" feedback (a swapped label + a CSS class, reverted after ~1.2s) — shared by the account card's address chips and the Receive screen's big copy button. */
function wireCopyButton(button, text, { labelEl } = {}) {
  let resetTimer = null;
  button.addEventListener('click', async () => {
    const ok = await copyToClipboard(text);
    if (!ok) return;
    button.classList.add('chip--copied');
    const original = labelEl ? labelEl.textContent : null;
    if (labelEl) labelEl.textContent = 'Copied ✓';
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      button.classList.remove('chip--copied');
      if (labelEl && original !== null) labelEl.textContent = original;
    }, 1200);
  });
}

let toastHideTimer = null;

/**
 * Brief, self-dismissing message (currently only Buy/Swap's "Coming
 * soon") — appended to `document.body`, not `#app`, specifically so a
 * screen navigation mid-fade (app.innerHTML getting reassigned) can't rip
 * the toast out from under its own fade-out transition.
 */
function showToast(message) {
  let toastEl = document.getElementById('flxToast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'flxToast';
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  // Restart the show transition even if a toast is already visible (rapid
  // re-clicks) — force a reflow between removing and re-adding the class
  // so the browser actually registers the state change.
  toastEl.classList.remove('toast--visible');
  void toastEl.offsetWidth;
  toastEl.classList.add('toast--visible');

  clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => {
    toastEl.classList.remove('toast--visible');
  }, 1500);
}

async function main() {
  // Resume nudge (prompt 0203 Revisi 1): opening the popup wakes the MV3
  // service worker; this fire-and-forget call makes the worker resume an
  // interrupted swap re-broadcast loop (the handler restarts it when
  // active state exists in chrome.storage.session). Nothing here awaits
  // or renders it — it exists purely so a worker restart mid-swap can't
  // strand the loop until the next alarm tick.
  sendInternal('FLUXIO_INTERNAL_GET_ACTIVE_SWAP').catch(() => {});

  let status;
  try {
    status = await sendInternal('FLUXIO_INTERNAL_GET_STATUS');
  } catch (error) {
    renderError(error.message);
    return;
  }

  if (!status.hasWallet) {
    renderNoWallet();
    return;
  }

  if (!status.isUnlocked) {
    renderLocked();
    return;
  }

  renderWalletReady(status.wallet);
}

function renderError(message) {
  app.innerHTML = `
    <div class="screen">
      <h1>Fluxio Wallet</h1>
      <div class="error">${escapeHtml(message)}</div>
    </div>
  `;
}

function renderNoWallet() {
  app.innerHTML = `
    <div class="screen screen--center">
      <img class="brand-logo" src="../assets/logo-fluxio-mono.png" alt="Fluxio" />
      <p class="desc">No wallet on this device yet. Set one up in a full tab so you don't lose your recovery phrase if this popup closes.</p>
      <button class="primary" id="setupBtn">Create or import wallet</button>
    </div>
  `;
  document.getElementById('setupBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
    window.close();
  });
}

/**
 * Shared unlock form — used both for the top-level "wallet is locked"
 * screen (renderLocked, no cancel option — there's nowhere else to go)
 * and, mid-Send-flow, whenever background.js reports the wallet locked
 * partway through (an inline resume, with a cancel option back to the
 * main screen). Deliberately the ONE unlock mechanism in this file, per
 * the standing instruction not to build a second one — every caller just
 * supplies what happens next.
 *
 * Wrapped in a real <form> (submit, not just a button click) so pressing
 * Enter in the password field submits it — this didn't exist before this
 * redesign; it's wired to the exact same handler a click already used, no
 * new validation/logic, just a second way to trigger it.
 * @param {(wallet: object) => void} onUnlocked
 * @param {{ onCancel?: () => void }} [opts]
 */
function renderUnlockPrompt(onUnlocked, { onCancel } = {}) {
  app.innerHTML = `
    <div class="screen screen--center">
      <img class="brand-logo" src="../assets/logo-fluxio-mono.png" alt="Fluxio" />
      <div class="brand-wordmark">Fluxio</div>
      <h1 class="unlock-heading">Enter your password</h1>
      <form id="unlockForm" class="unlock-form" novalidate>
        <input type="password" id="password" placeholder="Password" autocomplete="current-password" autofocus />
        <div class="error" id="errorMsg"></div>
        <button type="submit" class="primary" id="unlockBtn">Unlock</button>
        ${onCancel ? '<button type="button" class="secondary" id="cancelUnlockBtn">Cancel</button>' : ''}
        <button type="button" class="secondary" id="forgotPasswordBtn">Forgot password?</button>
      </form>
    </div>
  `;

  const passwordInput = document.getElementById('password');
  passwordInput.focus();

  if (onCancel) {
    document.getElementById('cancelUnlockBtn').addEventListener('click', onCancel);
  }

  // "Forgot password?" (prompt 0124, restyled to button.secondary in
  // Revision 3 — was a plain .link, unified with the same "primary button
  // + secondary button below it, no more bare text links" pass prompt
  // 0125 Revision 1 already applied across onboarding.js) — every one of
  // this function's many callers (see this repo's own prompt archive for
  // the full list) gets this button for free, since it's part of the one
  // shared unlock form rather than duplicated per call site. "Back" from
  // the reset screen re-renders this exact same prompt with the SAME
  // onUnlocked/onCancel it was originally given, so returning from
  // "Forgot password?" always lands back wherever the user actually was,
  // not a hardcoded screen.
  document.getElementById('forgotPasswordBtn').addEventListener('click', () => {
    renderResetWalletWarning(() => renderUnlockPrompt(onUnlocked, { onCancel }));
  });

  const unlockForm = document.getElementById('unlockForm');
  const unlockBtn = document.getElementById('unlockBtn');
  const errorMsg = document.getElementById('errorMsg');
  unlockForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = passwordInput.value;
    if (!password) {
      errorMsg.textContent = 'Enter your wallet password.';
      return;
    }
    errorMsg.textContent = '';
    unlockBtn.disabled = true;
    try {
      const { wallet } = await sendInternal('FLUXIO_INTERNAL_UNLOCK', { password });
      onUnlocked(wallet);
    } catch (error) {
      errorMsg.textContent = error.message || 'Incorrect password.';
      unlockBtn.disabled = false;
    }
  });
}

/**
 * "Forgot password?" destructive reset screen (prompt 0124). This wallet
 * is non-custodial: there is no password to reset, only a full local
 * start-over, so this is deliberately presented as a conscious decision
 * (an educational warning + a type-to-confirm gate), not a plain button —
 * same "confirm before anything destructive happens" spirit as
 * wireTokenManageRemoveButtons()'s two-click pattern elsewhere in this
 * file, just a stronger gate for a stronger action (erasing the entire
 * wallet, not one token).
 *
 * isResetConfirmationValid() (shared/resetConfirmation.js) is the single
 * source of truth for "does the typed text match RESET exactly" — this
 * function never re-implements that comparison inline.
 * @param {() => void} onBack
 */
function renderResetWalletWarning(onBack) {
  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Reset wallet</h1>
      <p class="desc">
        This erases the encrypted wallet stored in this browser. There is no password reset for a
        non-custodial wallet &mdash; this is the only way back in if you've forgotten your password.
      </p>
      <div class="warning">
        <ul>
          <li>Your assets are not affected &mdash; they stay exactly where they are on the blockchain.</li>
          <li>Recovery is only possible with your recovery (seed) phrase. Importing it re-derives this
            same wallet and every balance reappears.</li>
          <li>Without that seed phrase, access is gone for good &mdash; no one, including us, can get it back for you.</li>
        </ul>
      </div>
      <p class="desc">Type <strong>RESET</strong> to continue.</p>
      <input type="text" id="resetConfirmInput" placeholder="RESET" autocomplete="off" spellcheck="false" autocapitalize="off" />
      <div class="error" id="resetError"></div>
      <button type="button" class="danger" id="resetConfirmBtn" disabled>Reset wallet</button>
    </div>
  `;

  document.getElementById('backBtn').addEventListener('click', onBack);

  const input = document.getElementById('resetConfirmInput');
  const confirmBtn = document.getElementById('resetConfirmBtn');
  const errorMsg = document.getElementById('resetError');

  input.focus();
  input.addEventListener('input', () => {
    confirmBtn.disabled = !isResetConfirmationValid(input.value);
  });

  confirmBtn.addEventListener('click', async () => {
    if (!isResetConfirmationValid(input.value)) return; // defense in depth — the button should already be disabled
    confirmBtn.disabled = true;
    errorMsg.textContent = '';
    try {
      await sendInternal('FLUXIO_INTERNAL_RESET_WALLET');
      renderNoWallet();
    } catch (error) {
      errorMsg.textContent = error.message || 'Reset failed. Try again.';
      confirmBtn.disabled = !isResetConfirmationValid(input.value);
    }
  });
}

function renderLocked() {
  renderUnlockPrompt((wallet) => renderWalletReady(wallet));
}

// ---- Wallet-ready screen: pure-black account zone (prompt 0120) + near-black network panel ----

/**
 * Account-card accent (prompt 0120 Revision 2, replacing 0097's small
 * corner-triangle ornament) — THIRD approach for this ornament, after
 * TWO hand-built SVG chevron reconstructions were both rejected by the
 * user for not matching a supplied reference image
 * (assets/reference-card-accent.png) closely enough on inspection (see
 * the prompt archive entry for the full history of both attempts, what
 * was wrong with each, and why). Rather than attempt a third from-scratch
 * SVG reconstruction, this revision uses the reference image itself,
 * cropped down to just the accent region: apps/extension/assets/
 * card-accent.png. That crop was verified pixel-by-pixel (via the
 * source PNG's own alpha channel, not eyeballed) to fall entirely
 * within the reference mockup's own opaque card area — no white
 * background bleed, no rounded-corner arc — so every edge of the
 * cropped asset is already plain, uniform card-black; see the prompt
 * archive entry for the exact crop rectangle. The image is flattened
 * onto black at crop time (no alpha channel needed) since this card is
 * already pure #000000 (this feature's own Original change) — the two
 * blacks meet with nothing to blend.
 *
 * MARKUP: a single `<img class="account-card__ornament" src="../assets/
 * card-accent.png">`, replacing the old inline SVG entirely (no <defs>,
 * no <mask>, no path data — genuinely simpler markup, not just a visual
 * change). All positioning/cropping/fade behavior lives in popup.css's
 * own `.account-card__ornament` rule now (object-fit: cover +
 * object-position: right center to crop-to-fill without ever stretching
 * the chevrons, plus a `mask-image` linear-gradient for the left fade —
 * see that rule's own comment for the full reasoning, including why the
 * fade is still needed even though the source crop already fades to
 * black on its own).
 *
 * POSITION: full card height (top:0; bottom:0; no fixed height, same as
 * both prior SVG attempts) via popup.css's own .account-card__ornament
 * rule, right-aligned, clipped by .account-card's pre-existing
 * `overflow: hidden` (unchanged mechanism across all three attempts).
 *
 * SELF-VERIFICATION: rendered via a locally-installed headless Chromium
 * (Edge) against the real production theme.css/popup.css and the actual
 * account-card markup, screenshot saved to
 * assets/accent-render-preview.png (overwriting the prior attempt's) and
 * visually compared side-by-side against assets/reference-card-accent.png
 * before this was considered done — see the prompt archive entry for the
 * honest closeness assessment.
 *
 * OPTIONAL (prompt 0121): a Settings item ("Card background") lets the
 * user hide this ornament entirely for a plain black card. The <img> tag
 * itself is ALWAYS emitted below regardless of that choice — only an
 * `account-card__ornament--hidden` modifier class (display:none, see
 * popup.css) is conditional — deliberately not an `if`/ternary that omits
 * the whole tag, so switching back to Accent never needs the browser to
 * re-fetch/re-decode card-accent.png; it was already loaded and simply
 * becomes visible again. See shared/cardBackground.js for the value
 * constants + default-resolution logic (unset storage -> Accent, this
 * feature's own specified default).
 */
async function renderWalletReady(wallet) {
  const solAddress = wallet?.accounts?.solana?.address || '—';
  const evmAddress = wallet?.accounts?.evm?.address || '—';
  const devNetworksEnabled = await getDevNetworksEnabled();
  const visibleNetworks = devNetworksEnabled ? [...NATIVE_NETWORKS, ...DEV_NETWORKS] : NATIVE_NETWORKS;
  const sendableVisible = visibleNetworks.filter((n) => isSendableNetwork(n.key));

  // Card background (prompt 0121): read fresh on every render, same
  // "no live listener, Back navigation re-renders and re-reads" reactivity
  // as devNetworksEnabled above — Settings' own change handler only ever
  // writes chrome.storage.local, this is where that value actually takes
  // visual effect.
  const cardBackground = await getCardBackground();

  // Portfolio total (prompt 0118): the LAST computed total, read directly
  // from chrome.storage.local (see PORTFOLIO_TOTAL_CACHE_STORAGE_KEY's own
  // comment in shared/messaging.js) so the card shows a real number the
  // instant this screen paints, never a blank/zero flash while the fresh
  // FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE round trip below is still in
  // flight. loadPortfolioTotal() (fired at the end of this function,
  // alongside loadAllBalances) replaces it with a fresh value once that
  // resolves.
  const cachedTotal = await getCachedPortfolioTotal();

  // Notifications inbox (prompt 0170): same "last-known cache, read
  // directly, instant paint" reasoning as cachedTotal above — the bell
  // icon's dot must never wait on a round trip just to know whether
  // there's anything unread. loadNotificationsBadge() (fired at the end
  // of this function, alongside loadAllBalances/loadPortfolioTotal) fires
  // this screen's own throttled background refresh and updates just the
  // dot if the count changed.
  const cachedNotifications = await getCachedNotificationsState();
  const hasUnreadNotifications = countUnread(cachedNotifications.announcements, cachedNotifications.readIds) > 0;

  // Multi-account: fetched here (not lazily when the drawer opens) so the
  // account card's own label always shows the real active-account name
  // instead of a hardcoded "Account 1", and so the drawer opens instantly
  // with data already in hand rather than showing its own loading state.
  // Falls back to a single-account view (index/name derived from `wallet`
  // alone) if the round trip fails for some reason — the card and Send/
  // Receive/balances flows all still work fine off just `wallet`, only
  // the drawer's list would be incomplete, so this is never fatal here.
  let accountsState;
  try {
    accountsState = await sendInternal('FLUXIO_INTERNAL_GET_ACCOUNTS');
  } catch {
    accountsState = {
      accounts: [{ index: wallet.accountIndex, name: `Account ${wallet.accountIndex + 1}` }],
      activeIndex: wallet.accountIndex
    };
  }
  const activeAccountName =
    accountsState.accounts.find((a) => a.index === accountsState.activeIndex)?.name ||
    `Account ${wallet.accountIndex + 1}`;

  app.innerHTML = `
    <div class="zone-top">
      <div class="account-card">
        <img class="account-card__ornament${cardBackground === CARD_BACKGROUND_ACCENT ? '' : ' account-card__ornament--hidden'}" src="../assets/card-accent.png" alt="" aria-hidden="true" />
        <div class="account-card__header">
          <button class="account-card__label" id="accountSwitcherBtn" type="button" title="Switch account" aria-haspopup="dialog">
            <span id="activeAccountName">${escapeHtml(activeAccountName)}</span>
            ${ICONS.chevronDown}
          </button>
          <div class="account-card__header-actions">
            <button class="account-card__icon-btn" id="actionRefresh" title="Refresh balances" aria-label="Refresh balances">${ICONS.refresh}</button>
            <button class="account-card__icon-btn" id="actionActivity" title="Activity" aria-label="Activity">${ICONS.activity}</button>
            <button class="account-card__icon-btn" id="actionNotifications" title="Notifications" aria-label="Notifications">${ICONS.bell}${hasUnreadNotifications ? '<span class="notif-dot" aria-hidden="true"></span>' : ''}</button>
            <button class="account-card__icon-btn" id="actionSettings" title="Settings" aria-label="Settings">${ICONS.settings}</button>
            <button class="account-card__icon-btn" id="lockBtn" title="Lock wallet" aria-label="Lock wallet">${ICONS.lock}</button>
          </div>
        </div>
        <div class="account-card__total">
          <div class="account-card__total-value" id="portfolioTotalValue">${escapeHtml(cachedTotal.totalFormatted)}</div>
          <div class="account-card__total-hint" id="portfolioTotalHint" ${cachedTotal.hasExcludedAssets ? '' : 'hidden'} title="Some assets aren't included in this total yet (unpriced or unavailable).">ⓘ Some assets not included</div>
        </div>
        <div class="account-card__chips">
          <button class="chip" id="chip-sol" type="button">
            <span class="chip__text">SOL · ${escapeHtml(shortenAddress(solAddress))}</span>
            <span class="chip__icon">${ICONS.copy}</span>
          </button>
          <button class="chip" id="chip-evm" type="button">
            <span class="chip__text">EVM · ${escapeHtml(shortenAddress(evmAddress))}</span>
            <span class="chip__icon">${ICONS.copy}</span>
          </button>
        </div>
      </div>
      <div class="action-row">
        <button class="action-btn" id="actionSend" ${sendableVisible.length ? '' : 'disabled'} title="${sendableVisible.length ? 'Send' : 'Enable Developer networks in Settings to send'}">
          <span class="action-btn__icon">${ICONS.send}</span>
          <span class="action-btn__label">Send</span>
        </button>
        <button class="action-btn" id="actionReceive" title="Receive">
          <span class="action-btn__icon">${ICONS.receive}</span>
          <span class="action-btn__label">Receive</span>
        </button>
        <button class="action-btn" id="actionBuy" title="Buy">
          <span class="action-btn__icon">${ICONS.buy}</span>
          <span class="action-btn__label">Buy</span>
        </button>
        <button class="action-btn" id="actionSwap" title="Swap">
          <span class="action-btn__icon">${ICONS.swap}</span>
          <span class="action-btn__label">Swap</span>
        </button>
      </div>
    </div>
    <div class="zone-bottom">
      <div class="zone-bottom__scroll">
        <div class="panel-header"><span>Assets</span></div>
        <div class="network-list">
          ${visibleNetworks.map((n) => networkRowMarkup(n.key, n.label)).join('')}
        </div>
      </div>
    </div>
  `;

  wireCopyButton(document.getElementById('chip-sol'), solAddress, {
    labelEl: document.querySelector('#chip-sol .chip__text')
  });
  wireCopyButton(document.getElementById('chip-evm'), evmAddress, {
    labelEl: document.querySelector('#chip-evm .chip__text')
  });

  document.getElementById('accountSwitcherBtn').addEventListener('click', () => openAccountDrawer(accountsState));

  document.getElementById('lockBtn').addEventListener('click', async () => {
    try {
      await sendInternal('FLUXIO_INTERNAL_LOCK');
    } catch {
      // Locking is best-effort from the UI's perspective — even if the
      // round trip itself errors, re-checking status below is the source
      // of truth for which screen to show next.
    }
    renderLocked();
  });

  document.getElementById('actionSend').addEventListener('click', () => {
    if (!sendableVisible.length) return;
    renderNetworkPicker(wallet, sendableVisible);
  });
  document.getElementById('actionReceive').addEventListener('click', () => renderReceive(wallet));
  // Buy is the one deliberate placeholder left — no on-ramp exists yet
  // (Swap has been real since prompt 0200). A toast, not a disabled/inert
  // button: a dead-looking control in the middle of an otherwise-live
  // action row reads as broken, and a permanently-dimmed one makes the
  // whole row look half-built.
  document.getElementById('actionBuy').addEventListener('click', () => showToast('Coming soon'));
  document.getElementById('actionSwap').addEventListener('click', () => renderSwapNetworkPicker(wallet, visibleNetworks));
  document.getElementById('actionSettings').addEventListener('click', () => renderSettingsScreen(wallet));
  document.getElementById('actionActivity').addEventListener('click', () => renderActivityPicker(wallet, { onBack: () => renderWalletReady(wallet) }));
  document.getElementById('actionNotifications').addEventListener('click', () => renderNotificationsScreen(wallet));

  const refreshBtn = document.getElementById('actionRefresh');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('spinning');
    try {
      await Promise.all([loadAllBalances(visibleNetworks), loadPortfolioTotal()]);
    } finally {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }
  });

  // Fetch on open (this function runs fresh every time the popup opens),
  // never on a timer — see loadBalance()'s own comment for why. The
  // portfolio total's own cache was already painted synchronously above
  // (see cachedTotal) — this just replaces it with a fresh number once
  // the round trip resolves, same "cache now, refresh in the background"
  // shape as the rest of this screen already has for balances.
  loadAllBalances(visibleNetworks);
  loadPortfolioTotal();
  loadNotificationsBadge();
}

// ---- Account drawer (multi-account — all derived from the SAME seed via
// increasing account index, see @fluxio/crypto/derivation.js; never a new
// seed) ----

function onDrawerKeydown(event) {
  if (event.key === 'Escape') closeAccountDrawer();
}

/**
 * Slide-in overlay (appended to document.body, not #app, same reasoning
 * as showToast() — a screen navigation underneath it can't rip it out
 * mid-transition) listing every known account with a deterministic
 * colored-initial avatar, the active one marked, a pencil for inline
 * rename, and a "+" to add a new one. Closes on backdrop click, the
 * Close button, or Escape.
 */
function openAccountDrawer(accountsState) {
  closeAccountDrawer(); // never stack two

  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.id = 'accountDrawerBackdrop';
  backdrop.innerHTML = `
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="Accounts">
      <div class="drawer__header">
        <button class="back-btn" id="drawerCloseBtn">${ICONS.back}<span>Close</span></button>
      </div>
      <div class="drawer__list" id="drawerList">
        ${accountsState.accounts.map((a) => accountRowMarkup(a, accountsState.activeIndex)).join('')}
      </div>
      <div class="drawer__footer">
        <button class="drawer__add" id="drawerAddBtn">${ICONS.plus}<span>Add account</span></button>
      </div>
    </aside>
  `;
  document.body.appendChild(backdrop);

  // Force a reflow between insertion and adding the open class, so the
  // CSS transition (opacity/transform) actually plays instead of the
  // drawer just appearing already-open.
  void backdrop.offsetWidth;
  backdrop.classList.add('drawer-backdrop--open');

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeAccountDrawer();
  });
  document.getElementById('drawerCloseBtn').addEventListener('click', closeAccountDrawer);
  document.addEventListener('keydown', onDrawerKeydown);

  accountsState.accounts.forEach((account) => {
    const selectEl = document.getElementById(`drawer-select-${account.index}`);
    selectEl?.addEventListener('click', () => switchActiveAccount(account.index));
    // drawer-select-X is a <div role="button">, not a real <button> (see
    // accountRowMarkup's own comment) — Enter/Space activation isn't free
    // anymore, so it's replicated here. Guarded to the element itself being
    // the actual event target (not just something the keydown bubbled up
    // from) so a Space/Enter keystroke typed into the rename <input> that
    // ends up nested inside this div during an active rename never
    // spuriously switches the account.
    selectEl?.addEventListener('keydown', (event) => {
      if (event.target !== selectEl) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        switchActiveAccount(account.index);
      }
    });
    document
      .getElementById(`drawer-rename-${account.index}`)
      ?.addEventListener('click', () => beginRenameRow(account, account.index === accountsState.activeIndex));
  });
  document.getElementById('drawerAddBtn').addEventListener('click', addNewAccount);

  // Keyboard focus starts on Close — the drawer's first interactive
  // element — rather than being left on whatever triggered it (which is
  // now visually behind the backdrop).
  document.getElementById('drawerCloseBtn').focus();
}

function closeAccountDrawer() {
  const backdrop = document.getElementById('accountDrawerBackdrop');
  if (!backdrop) return;
  document.removeEventListener('keydown', onDrawerKeydown);
  backdrop.classList.remove('drawer-backdrop--open');
  // Removed once the CSS transition finishes so the slide-out actually
  // plays; harmless if prefers-reduced-motion already made that
  // transition instant — the element is just gone slightly early.
  setTimeout(() => backdrop.remove(), 260);
}

function accountRowMarkup(account, activeIndex) {
  const isActive = account.index === activeIndex;
  const avatarSeed = account.solanaAddress || account.evmAddress || String(account.index);
  // drawer-row__main is deliberately a <div role="button"> here, not a real
  // <button> (prompt 0126 bugfix): beginRenameRow() below swaps
  // #drawer-name-X for a <form><input> IN PLACE, which lands that input
  // INSIDE this element — nesting a text input inside a real <button> is
  // invalid HTML (buttons may not contain interactive content) and is the
  // proven root cause of Space getting swallowed while renaming (see
  // beginRenameRow's own comment). A <div> has no such restriction, so the
  // nested input's own keys are never at the mercy of an ancestor button's
  // native keyboard-activation handling. Keyboard activation (Enter/Space
  // selects the account, same as a real button would give for free) is
  // wired back manually in openAccountDrawer(), guarded to only fire when
  // this element itself is the actual event target.
  return `
    <div class="drawer-row ${isActive ? 'drawer-row--active' : ''}" id="drawer-row-${account.index}">
      <div class="drawer-row__main" id="drawer-select-${account.index}" role="button" tabindex="0" ${isActive ? 'aria-current="true"' : ''}>
        <span class="drawer-avatar" id="drawer-avatar-${account.index}" style="background:${avatarColorFor(avatarSeed)}">${escapeHtml(avatarInitial(account.name))}</span>
        <span class="drawer-row__name" id="drawer-name-${account.index}">${escapeHtml(account.name)}</span>
      </div>
      <button class="drawer-row__rename" id="drawer-rename-${account.index}" title="Rename ${escapeHtml(account.name)}" aria-label="Rename ${escapeHtml(account.name)}">${ICONS.pencil}</button>
    </div>
  `;
}

async function switchActiveAccount(index) {
  try {
    const { wallet } = await sendInternal('FLUXIO_INTERNAL_SET_ACTIVE_ACCOUNT', { index });
    closeAccountDrawer();
    renderWalletReady(wallet);
  } catch (error) {
    if (isLockedError(error)) {
      closeAccountDrawer();
      renderUnlockPrompt((freshWallet) => renderWalletReady(freshWallet));
      return;
    }
    showToast(error.message || 'Could not switch accounts.');
  }
}

/** "Add" always means "add and switch to it" — a brand-new account is created already active, matching the drawer's own "+" affordance (see background.js's FLUXIO_INTERNAL_ADD_ACCOUNT). */
async function addNewAccount() {
  const addBtn = document.getElementById('drawerAddBtn');
  if (addBtn) addBtn.disabled = true;
  try {
    const { wallet } = await sendInternal('FLUXIO_INTERNAL_ADD_ACCOUNT');
    closeAccountDrawer();
    renderWalletReady(wallet);
  } catch (error) {
    if (isLockedError(error)) {
      closeAccountDrawer();
      renderUnlockPrompt((freshWallet) => renderWalletReady(freshWallet));
      return;
    }
    showToast(error.message || 'Could not add a new account.');
    if (addBtn) addBtn.disabled = false;
  }
}

/**
 * Swaps one drawer row's name into an inline editable input — no separate
 * screen/dialog, so the rest of the drawer (and its scroll position, and
 * every other row) stays put. Enter/blur commits, Escape cancels. The
 * drawer is deliberately kept open afterward (unlike switching/adding,
 * which both close it) so renaming several accounts in a row doesn't mean
 * reopening the drawer each time.
 */
function beginRenameRow(account, isActiveAccount) {
  const nameEl = document.getElementById(`drawer-name-${account.index}`);
  if (!nameEl) return;

  const form = document.createElement('form');
  form.className = 'drawer-row__rename-form';
  form.innerHTML = `<input type="text" class="drawer-row__rename-input" id="rename-input-${account.index}" value="${escapeHtml(account.name)}" maxlength="32" autocomplete="off" />`;
  nameEl.replaceWith(form);

  const input = document.getElementById(`rename-input-${account.index}`);
  input.focus();
  input.select();

  let settled = false;

  function restore(displayName) {
    if (!form.isConnected) return;
    nameEl.textContent = displayName;
    form.replaceWith(nameEl);
  }

  async function commit() {
    if (settled) return;
    settled = true;
    const newName = input.value.trim();
    if (!newName || newName === account.name) {
      restore(account.name);
      return;
    }
    try {
      await sendInternal('FLUXIO_INTERNAL_RENAME_ACCOUNT', { index: account.index, name: newName });
      account.name = newName;
      restore(newName);
      // Initial only — the avatar's background color is derived from the
      // account's address (avatarColorFor), not its name, so it
      // deliberately stays put across a rename (same visual identity).
      const avatarEl = document.getElementById(`drawer-avatar-${account.index}`);
      if (avatarEl) avatarEl.textContent = avatarInitial(newName);
      if (isActiveAccount) {
        const headerName = document.getElementById('activeAccountName');
        if (headerName) headerName.textContent = newName;
      }
    } catch (error) {
      if (isLockedError(error)) {
        closeAccountDrawer();
        renderUnlockPrompt((freshWallet) => renderWalletReady(freshWallet));
        return;
      }
      showToast(error.message || 'Could not rename this account.');
      restore(account.name);
    }
  }

  function cancel() {
    if (settled) return;
    settled = true;
    restore(account.name);
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancel();
  });
  input.addEventListener('blur', () => commit());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    commit();
  });
}

/** A network row is logo + name + badge + balance, full stop — no per-row action button. The Send action row's own button at the top of the screen already opens the full network-picker -> Send-form flow for every sendable network (see SENDABLE_NETWORK_KEYS); a second, repeated "Send" link under every eligible row was redundant with it and, per the same "layar utama tidak boleh berisik" complaint 0110 raised about "+ Add token", visual noise on a screen meant to read as a balance overview — removed for the same reason. */
function networkRowMarkup(key, label) {
  return `
    <div class="network-block">
      <div class="network-row" id="balance-row-${key}">
        <img class="network-row__logo" src="${chainLogoSrc(key)}" alt="" />
        <div class="network-row__meta">
          <span class="network-row__name">${escapeHtml(label)}${badgeMarkup(key)}</span>
        </div>
        <div class="network-row__right">
          <span class="network-row__value skeleton" id="balance-value-${key}">0.000</span>
        </div>
      </div>
      <div class="token-list" id="token-list-${key}"></div>
    </div>
  `;
}

/** Fires every visible network's native-balance AND token-balance fetches in parallel and resolves once they've all settled — lets the Refresh button know when to stop spinning. Individual failures still resolve (loadBalance/loadTokenBalances never throw, see their own comments), so one slow/failing row never blocks the spinner from stopping for the others. */
function loadAllBalances(networks) {
  return Promise.all(networks.flatMap((n) => [loadBalance(n.key), loadTokenBalances(n.key)]));
}

/**
 * Portfolio total (prompt 0118): fetches the real, freshly-computed total
 * (background.js resolves balances + prices + the sum in one round trip —
 * see FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE's own comment) and, if the main
 * screen's card is currently on-screen, replaces whatever it's showing
 * (the cached value painted at render time, or a previous fresh value on
 * Refresh).
 *
 * Deliberately ALWAYS makes the round trip regardless of whether the
 * card's own DOM elements exist right now — this is also called from the
 * Settings screen's Currency change handler (a different screen/DOM
 * entirely) specifically to trigger background.js's own cache-invalidate-
 * and-recompute side effect for FLUXIO_INTERNAL_SET_CURRENCY, so the
 * persisted total cache is already correct in the NEW currency by the
 * time the user navigates back — only the DOM-touching half below is
 * conditional, never the fetch itself.
 *
 * Only ever triggered by popup-open, an explicit Refresh click, or a
 * Currency change, matching every other balance fetch in this file —
 * never on a timer.
 *
 * Never throws on a locked session discovered mid-flight — same
 * triggerBackgroundLockRecovery() pattern loadBalance()/loadTokenBalances()
 * already use, reused here rather than inventing a second mechanism for
 * this one more background-fetching function. Only triggers that
 * recovery flow when the wallet-ready screen (this function's normal
 * caller) is actually the one on-screen — a lock discovered while
 * Settings' Currency handler triggered this call is left to
 * FLUXIO_INTERNAL_SET_CURRENCY's own already-existing lock handling
 * instead, so the two error paths never race to render two different
 * unlock prompts over each other.
 */
async function loadPortfolioTotal() {
  const valueEl = document.getElementById('portfolioTotalValue');
  const hintEl = document.getElementById('portfolioTotalHint');
  try {
    const { totalFormatted, hasExcludedAssets } = await sendInternal('FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE');
    if (valueEl) valueEl.textContent = totalFormatted;
    if (hintEl) hintEl.hidden = !hasExcludedAssets;
  } catch (error) {
    if (valueEl && isLockedError(error)) {
      triggerBackgroundLockRecovery();
    }
    // Otherwise best-effort, matching the rest of this card: leave
    // whatever total was already showing (cache or a previous fresh
    // value) rather than clearing it to an error state — a possibly-
    // stale number is more useful here than a blank/error one, same
    // reasoning background.js's own resolvePortfolioPrices() cache-
    // fallback uses.
  }
}

/**
 * Notifications inbox (prompt 0170): fires this popup open's own
 * throttled background refresh (a no-op most of the time — see
 * background.js's own fetchAndMergeNotifications() throttle) and updates
 * just the bell icon's dot if the unread state changed since the
 * cache-only paint at the top of renderWalletReady(). No unlock-recovery
 * handling needed — FLUXIO_INTERNAL_GET_NOTIFICATIONS never throws (see
 * that handler's own comment), and this is public content anyway, not
 * gated on the session being unlocked.
 */
async function loadNotificationsBadge() {
  const bellBtn = document.getElementById('actionNotifications');
  if (!bellBtn) return; // screen navigated away before this resolved
  try {
    const { announcements, readIds } = await sendInternal('FLUXIO_INTERNAL_GET_NOTIFICATIONS');
    const hasUnread = countUnread(announcements, readIds) > 0;
    const existingDot = bellBtn.querySelector('.notif-dot');
    if (hasUnread && !existingDot) {
      bellBtn.insertAdjacentHTML('beforeend', '<span class="notif-dot" aria-hidden="true"></span>');
    } else if (!hasUnread && existingDot) {
      existingDot.remove();
    }
  } catch {
    // Best-effort — the cache-derived dot painted at render time stands
    // as-is, same reasoning as loadPortfolioTotal()'s own catch above.
  }
}

/**
 * Shared recovery trigger for a lock discovered by a PASSIVE background
 * fetch on the wallet-ready screen (prompt 0117 — auto-lock firing while
 * the popup happens to be sitting open, e.g. on Refresh long after the
 * last real interaction) — same existing renderUnlockPrompt->resume
 * pattern every other screen in this file already uses for an in-flow
 * lock, applied here rather than inventing a second mechanism. Verified
 * as a genuine, previously-uncovered gap while building auto-lock, not
 * assumed already handled: loadBalance/loadTokenBalances previously just
 * showed a per-row "Failed — Retry" for ANY error, lock included, which
 * would never actually resolve (Retry just fails the same way again)
 * without the user separately navigating to a screen that DID have this
 * handling.
 *
 * loadAllBalances fires up to 8 of these in parallel (native + token,
 * across every visible network) — all could discover "locked" within the
 * same tick. The guard flag keeps this to exactly one actual screen
 * transition rather than several redundant renderUnlockPrompt calls
 * racing each other (harmless either way — the DOM fully replaces on
 * each call, so the last one simply wins — but one deliberate transition
 * is cleaner than relying on that).
 */
let recoveringFromBackgroundLock = false;
function triggerBackgroundLockRecovery() {
  if (recoveringFromBackgroundLock) return;
  recoveringFromBackgroundLock = true;
  renderUnlockPrompt((freshWallet) => {
    recoveringFromBackgroundLock = false;
    renderWalletReady(freshWallet);
  });
}

/**
 * Fetches one network's balance independently — each row gets its own
 * loading/success/error state, so a slow or rate-limited chain never
 * blocks the other three from showing. Only ever called on popup-open
 * (via loadAllBalances() above) or an explicit Refresh/Retry click —
 * never on an interval, per the "don't hammer free public RPCs" guidance.
 */
async function loadBalance(networkKey) {
  const valueEl = document.getElementById(`balance-value-${networkKey}`);
  if (!valueEl) return; // popup may have re-rendered to a different view under us
  valueEl.className = 'network-row__value skeleton';
  valueEl.textContent = '0.000';
  try {
    const { formatted, symbol } = await sendInternal('FLUXIO_INTERNAL_GET_BALANCE', { networkKey });
    const isZero = Number(formatted) === 0;
    valueEl.className = `network-row__value${isZero ? ' network-row__value--zero' : ''}`;
    valueEl.textContent = `${trimAmount(formatted)} ${symbol}`;
  } catch (error) {
    if (isLockedError(error)) {
      triggerBackgroundLockRecovery();
      return;
    }
    valueEl.className = 'network-row__value network-row__value--error';
    valueEl.innerHTML = `Failed. <button class="link" id="retry-${networkKey}">Retry</button>`;
    document.getElementById(`retry-${networkKey}`)?.addEventListener('click', () => loadBalance(networkKey));
  }
}

/**
 * Fetches one network's token balances (SPL/ERC-20) independently of its
 * native-coin row — the two are fired in parallel (see loadAllBalances())
 * but never block each other: a failed/slow token fetch never disturbs
 * the native balance value above it, and vice versa. Renders nothing at
 * all when the network simply has no held tokens (the common case for
 * most networks right now — no clutter for an empty list), a small
 * skeleton line while loading, or a compact "Failed — Retry" line scoped
 * to just this network's token list on error. Same "only on open/Refresh/
 * Retry, never on a timer" rule as loadBalance() above.
 */
async function loadTokenBalances(networkKey) {
  const listEl = document.getElementById(`token-list-${networkKey}`);
  if (!listEl) return; // popup may have re-rendered to a different view under us
  listEl.innerHTML = `<div class="token-row token-row--skeleton">Loading tokens…</div>`;
  try {
    const { tokens } = await sendInternal('FLUXIO_INTERNAL_GET_TOKEN_BALANCES', { networkKey });
    listEl.innerHTML = tokens.map(tokenRowMarkup).join('');
  } catch (error) {
    if (isLockedError(error)) {
      triggerBackgroundLockRecovery();
      return;
    }
    listEl.innerHTML = `
      <div class="token-row token-row--error">
        Tokens failed to load. <button class="link" id="token-retry-${networkKey}">Retry</button>
      </div>
    `;
    document.getElementById(`token-retry-${networkKey}`)?.addEventListener('click', () => loadTokenBalances(networkKey));
  }
}

/**
 * Shared token-logo cell (prompt 0206): the mint's EMBEDDED icon when one
 * is bundled (tokenIconSrc — a local ../assets/ path, never a URL; native
 * SOL and the wrapped-SOL mint reuse the chain logo the dashboard already
 * ships), else the colored-letter placeholder this UI has always had.
 * Lookup is strictly by address/mint — a token merely CLAIMING a known
 * symbol can never borrow its logo (see test/tokenIcons.test.js).
 */
function tokenLogoMarkup(address, symbol, { native = false, networkKey = 'solana' } = {}) {
  // Only ever a bundled relative path: chainLogoSrc/tokenIconSrc both
  // construct ../assets/ paths and nothing else — the name below is what
  // test/tokenIcons.test.js's no-remote-images scan allowlists.
  // 'native' is the EVM-swap native marker (prompt 0219) — the chain
  // logo of the given network, same treatment the wrapped-SOL mint has
  // always had on Solana; networkKey defaults to 'solana' so every
  // pre-0219 call site renders byte-identically.
  const isNative = native || address === SWAP_NATIVE_SOL_MINT || address === 'native';
  const localIconPath = isNative ? chainLogoSrc(networkKey) : tokenIconSrc(address);
  if (localIconPath) {
    return `<img class="token-row__logo token-row__logo--img" src="${localIconPath}" alt="" />`;
  }
  const initial = (symbol || '?').charAt(0).toUpperCase();
  return `<span class="token-row__logo" style="background:${avatarColorFor(address)}">${escapeHtml(initial)}</span>`;
}

/**
 * One token's row — embedded icon or circle-initial placeholder (see
 * tokenLogoMarkup above; before prompt 0206 this was always the
 * initial, real logo assets being out of scope for the original slice).
 *
 * An unrecognized token (tokenService.js's "Unknown" fallback for a held
 * mint/contract with no registry/custom entry) gets a second, smaller
 * line showing its truncated address — without it, multiple unrecognized
 * tokens in the same list render as identical "Unknown" rows with no way
 * to tell them apart (confirmed during manual verification of the
 * Manage Tokens UI: four indistinguishable "Unknown" rows). A recognized
 * token never shows this line — its symbol alone is already
 * distinguishing.
 */
function tokenRowMarkup(token) {
  const addressLine =
    token.symbol === 'Unknown' ? `<span class="token-row__address">${escapeHtml(shortenAddress(token.address))}</span>` : '';
  return `
    <div class="token-row">
      ${tokenLogoMarkup(token.address, token.symbol)}
      <div class="token-row__meta">
        <span class="token-row__name">${escapeHtml(token.symbol)}</span>
        ${addressLine}
      </div>
      <span class="token-row__value">${escapeHtml(trimAmount(token.amountFormatted))}</span>
    </div>
  `;
}

/**
 * Trims an exact decimal string (from formatUnits, via background.js) to
 * at most `maxDecimals` digits and drops trailing zeros — plain string
 * truncation, not rounding, so it can't reintroduce the float-precision
 * problem the exact string was built to avoid. Purely cosmetic: e.g.
 * "1.234567890" -> "1.234567", "0.050000000000000000" -> "0.05".
 */
function trimAmount(decimalStr, maxDecimals = 6) {
  const [whole, fraction = ''] = decimalStr.split('.');
  const truncated = fraction.slice(0, maxDecimals).replace(/0+$/, '');
  return truncated ? `${whole}.${truncated}` : whole;
}

// ---- Network picker (Send entry point from the account card's action row) ----

/** Lists only the sendable networks currently visible (respects the Developer networks toggle, same as every per-row Send link already did) — picking one drops straight into the existing Send form for that network. */
function renderNetworkPicker(wallet, sendableVisible) {
  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Send</h1>
      <p class="desc">Choose a network to send from.</p>
      <div class="network-picker">
        ${sendableVisible
          .map(
            (n) => `
          <button class="secondary" id="pick-${n.key}">
            <img class="network-picker__logo" src="${chainLogoSrc(n.key)}" alt="" />
            <span>${escapeHtml(n.label)}${badgeMarkup(n.key)}</span>
          </button>`
          )
          .join('')}
      </div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => renderWalletReady(wallet));
  sendableVisible.forEach((n) => {
    document.getElementById(`pick-${n.key}`).addEventListener('click', () => renderSendAssetPicker(n.key, wallet, sendableVisible));
  });
}

/**
 * Asset picker (prompt 0113) — the new step between "pick a network" and
 * the amount/address form: native coin + every token with a nonzero
 * balance on this network, reusing FLUXIO_INTERNAL_GET_TOKEN_BALANCES's
 * data (per this feature's explicit instruction — no separate token-
 * listing endpoint was added). Only HELD tokens are listed, same as the
 * main wallet screen's own token rows — an asset with nothing to send
 * would be a dead end here anyway. Native and token balances are fetched
 * in parallel, same "one slow fetch never blocks the other" principle
 * loadAllBalances() already established for the main screen.
 */
async function renderSendAssetPicker(networkKey, wallet, sendableVisible) {
  const label = networkLabel(networkKey);
  const back = () => renderNetworkPicker(wallet, sendableVisible);

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Send</h1>
      <p class="desc">${escapeHtml(label)}${badgeMarkup(networkKey)}. Choose an asset.</p>
      <div class="loading">Loading balances…</div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', back);

  let nativeBalance;
  let nativeSymbol;
  let tokens;
  try {
    const [nativeResult, tokenResult] = await Promise.all([
      sendInternal('FLUXIO_INTERNAL_GET_BALANCE', { networkKey }),
      sendInternal('FLUXIO_INTERNAL_GET_TOKEN_BALANCES', { networkKey })
    ]);
    nativeBalance = nativeResult.formatted;
    nativeSymbol = nativeResult.symbol;
    tokens = tokenResult.tokens;
  } catch (error) {
    if (isLockedError(error)) {
      renderUnlockPrompt((freshWallet) => renderSendAssetPicker(networkKey, freshWallet, sendableVisible), { onCancel: () => main() });
      return;
    }
    app.innerHTML = `
      <div class="screen">
        <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
        <h1>Send</h1>
        <div class="error">${escapeHtml(error.message || 'Could not load balances.')}</div>
      </div>
    `;
    document.getElementById('backBtn').addEventListener('click', back);
    return;
  }

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Send</h1>
      <p class="desc">${escapeHtml(label)}${badgeMarkup(networkKey)}. Choose an asset.</p>
      <div class="network-picker">
        <button class="secondary" id="asset-native">
          <img class="network-picker__logo" src="${chainLogoSrc(networkKey)}" alt="" />
          <span>${escapeHtml(nativeSymbol)}</span>
          <span class="network-picker__balance">${escapeHtml(trimAmount(nativeBalance))} ${escapeHtml(nativeSymbol)}</span>
        </button>
        ${tokens
          .map((t, idx) => {
            const initial = (t.symbol || '?').charAt(0).toUpperCase();
            return `
          <button class="secondary" id="asset-token-${idx}">
            <span class="token-row__logo" style="background:${avatarColorFor(t.address)}">${escapeHtml(initial)}</span>
            <span>${escapeHtml(t.symbol)}</span>
            <span class="network-picker__balance">${escapeHtml(trimAmount(t.amountFormatted))}</span>
          </button>`;
          })
          .join('')}
      </div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', back);
  document.getElementById('asset-native').addEventListener('click', () => renderSendForm(networkKey, wallet, { type: 'native' }));
  tokens.forEach((t, idx) => {
    document
      .getElementById(`asset-token-${idx}`)
      .addEventListener('click', () => renderSendForm(networkKey, wallet, { type: 'token', address: t.address, symbol: t.symbol, decimals: t.decimals }));
  });
}

// ---- Receive screen ----

/** Step 1: choose a chain. Step 2 (renderReceiveAddress): full address + a large copy button — never truncated, this is the one thing a wrong copy here would misdirect funds to. */
function renderReceive(wallet) {
  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Receive</h1>
      <p class="desc">Choose which address to share.</p>
      <div class="network-picker">
        <button class="secondary" id="pick-solana">
          <img class="network-picker__logo" src="${chainLogoSrc('solana')}" alt="" />
          <span>Solana</span>
        </button>
        <button class="secondary" id="pick-evm">
          <img class="network-picker__logo" src="${chainLogoSrc('ethereum')}" alt="" />
          <span>Ethereum / BNB Chain / Base</span>
        </button>
      </div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => renderWalletReady(wallet));
  document.getElementById('pick-solana').addEventListener('click', () => renderReceiveAddress(wallet, 'solana'));
  document.getElementById('pick-evm').addEventListener('click', () => renderReceiveAddress(wallet, 'evm'));
}

function renderReceiveAddress(wallet, accountType) {
  const address = accountType === 'evm' ? wallet.accounts.evm.address : wallet.accounts.solana.address;
  const chainLabel = accountType === 'evm' ? 'Ethereum / BNB Chain / Base' : 'Solana';

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Receive</h1>
      <p class="desc">${escapeHtml(chainLabel)}</p>
      <div class="address-label">Your address</div>
      <div class="address-box">${escapeHtml(address)}</div>
      <button class="primary receive-copy-btn" id="copyBtn"><span id="copyBtnLabel">Copy address</span></button>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => renderReceive(wallet));
  wireCopyButton(document.getElementById('copyBtn'), address, {
    labelEl: document.getElementById('copyBtnLabel')
  });
}

// ---- Settings (in-popup — previously always opened settings/settings.html in a new tab) ----

/** "1 minute" / "5 minutes" / "1 hour" / "Never" — the <select>'s option labels and the current-value display share this one formatter, so the wording can never drift between the two. */
function formatAutoLockLabel(minutes) {
  if (minutes === AUTO_LOCK_NEVER) return 'Never';
  if (minutes === 60) return '1 hour';
  if (minutes === 1) return '1 minute';
  return `${minutes} minutes`;
}

/**
 * Mirrors settings/settings.js's own list screen (same markup/classes,
 * both sourced from ../shared/theme.css) but as an in-popup screen with a
 * Back row instead of a full tab. The Developer networks toggle writes to
 * chrome.storage.local exactly like settings.js does — already reactive
 * by construction, not by anything new here: Back re-renders
 * renderWalletReady(), which always re-reads getDevNetworksEnabled()
 * fresh, so a toggle flip here is reflected the moment you back out, no
 * separate change-listener needed.
 *
 * Auto-lock (prompt 0117) is the one item here that DOES need a round
 * trip to background.js rather than touching chrome.storage.local
 * directly (unlike the Developer-networks toggle) — changing it has a
 * real side effect only background.js can perform (reprogramming the
 * chrome.alarms timer), not just a stored preference value.
 *
 * Card background (prompt 0121) follows the SAME direct-storage pattern
 * as Developer networks, not Auto-lock/Currency's message round trip:
 * it's a pure display preference with no background.js side effect to
 * trigger (confirmed by checking — no FLUXIO_INTERNAL_* message exists
 * for it, same as Developer networks has none). Modeled as a <select>
 * rather than a toggle-switch, though: Developer networks' toggle reads
 * as an on/off FEATURE switch ("show these extra networks or don't"),
 * while this is a choice between two equally-valid NAMED styles
 * ("Accent" vs "Plain") — the same shape Auto-lock/Currency already use
 * their own <select> for, so this follows that visual precedent instead.
 */
async function renderSettingsScreen(wallet) {
  const devNetworksEnabled = await getDevNetworksEnabled();
  const cardBackground = await getCardBackground();
  let autoLockMinutes = 15;
  try {
    ({ minutes: autoLockMinutes } = await sendInternal('FLUXIO_INTERNAL_GET_AUTO_LOCK'));
  } catch {
    // Non-fatal — the item still renders with a reasonable fallback
    // display value; the <select> itself still works normally on the
    // next successful change (e.g. if the wallet happened to lock between
    // opening Settings and this specific read).
  }
  let portfolioCurrency = 'usd';
  try {
    ({ currency: portfolioCurrency } = await sendInternal('FLUXIO_INTERNAL_GET_CURRENCY'));
  } catch {
    // Same non-fatal reasoning as Auto-lock above.
  }

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Settings</h1>
      <div class="settings-list">
        <button class="settings-item" id="revealItem">
          <span>Reveal Secret Phrase</span>
          <span class="chevron">›</span>
        </button>
        <button class="settings-item" id="manageTokensItem">
          <span>Manage Tokens</span>
          <span class="chevron">›</span>
        </button>
        <div class="settings-item settings-item--toggle">
          <span class="settings-item__label">
            <span>Developer networks</span>
            <span class="settings-item__hint">Show Solana Devnet, Solana Local, Ethereum Sepolia &amp; Ethereum Local in the popup</span>
          </span>
          <label class="toggle-switch">
            <input type="checkbox" id="devNetworksToggle" ${devNetworksEnabled ? 'checked' : ''} />
            <span class="track"><span class="thumb"></span></span>
          </label>
        </div>
        <div class="settings-item settings-item--toggle">
          <span class="settings-item__label">
            <span>Auto-lock</span>
            <span class="settings-item__hint">Lock the wallet automatically after inactivity</span>
          </span>
          <select id="autoLockSelect" class="settings-select">
            ${AUTO_LOCK_OPTIONS_MINUTES.map(
              (m) => `<option value="${escapeHtml(String(m))}" ${m === autoLockMinutes ? 'selected' : ''}>${escapeHtml(formatAutoLockLabel(m))}</option>`
            ).join('')}
          </select>
        </div>
        <div class="settings-item settings-item--toggle">
          <span class="settings-item__label">
            <span>Currency</span>
            <span class="settings-item__hint">Portfolio total on the main screen</span>
          </span>
          <select id="currencySelect" class="settings-select">
            ${SUPPORTED_CURRENCIES.map(
              (c) => `<option value="${escapeHtml(c.code)}" ${c.code === portfolioCurrency ? 'selected' : ''}>${escapeHtml(c.code.toUpperCase())} · ${escapeHtml(c.label)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="settings-item settings-item--toggle">
          <span class="settings-item__label">
            <span>Card background</span>
            <span class="settings-item__hint">Chevron accent or a plain black card</span>
          </span>
          <select id="cardBackgroundSelect" class="settings-select">
            ${CARD_BACKGROUND_OPTIONS.map(
              (o) => `<option value="${escapeHtml(o.value)}" ${o.value === cardBackground ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
            ).join('')}
          </select>
        </div>
      </div>
    </div>
  `;

  document.getElementById('backBtn').addEventListener('click', () => renderWalletReady(wallet));
  document.getElementById('revealItem').addEventListener('click', () => renderRevealFlow(wallet));
  document.getElementById('manageTokensItem').addEventListener('click', () => renderManageTokensPicker(wallet));
  document.getElementById('devNetworksToggle').addEventListener('change', async (event) => {
    await chrome.storage.local.set({ [DEV_NETWORKS_STORAGE_KEY]: event.target.checked });
  });
  document.getElementById('cardBackgroundSelect').addEventListener('change', async (event) => {
    // Same direct-storage, no-round-trip pattern as devNetworksToggle
    // above — Back re-renders renderWalletReady(), which re-reads this
    // key fresh, so the card reflects the new choice the moment the user
    // backs out, no separate listener/live DOM patch needed here.
    await chrome.storage.local.set({ [CARD_BACKGROUND_STORAGE_KEY]: event.target.value });
  });
  document.getElementById('autoLockSelect').addEventListener('change', async (event) => {
    // Option values are always strings in the DOM — every real duration
    // is numeric, so anything parseable as a number is converted back;
    // AUTO_LOCK_NEVER stays the literal string 'never' either way.
    const raw = event.target.value;
    const minutes = raw === AUTO_LOCK_NEVER ? AUTO_LOCK_NEVER : Number(raw);
    try {
      await sendInternal('FLUXIO_INTERNAL_SET_AUTO_LOCK', { minutes });
    } catch (error) {
      if (isLockedError(error)) {
        renderUnlockPrompt((freshWallet) => renderSettingsScreen(freshWallet), { onCancel: () => renderWalletReady(wallet) });
        return;
      }
      showToast(error.message || 'Could not update auto-lock.');
    }
  });
  document.getElementById('currencySelect').addEventListener('change', async (event) => {
    const currency = event.target.value;
    try {
      await sendInternal('FLUXIO_INTERNAL_SET_CURRENCY', { currency });
      // Recompute the cached total in the new currency right away (no new
      // CoinGecko call — background.js already has every currency's price
      // cached, see FLUXIO_INTERNAL_SET_CURRENCY's own comment) so the
      // main screen shows the correct number the instant the user goes
      // back, not the old currency's total. Fire-and-forget: Settings
      // itself has nothing to show for this, and a failure here isn't
      // worth surfacing over the SET_CURRENCY call that already succeeded
      // — the main screen's own loadPortfolioTotal() will simply try
      // again on next open/Refresh.
      loadPortfolioTotal();
    } catch (error) {
      if (isLockedError(error)) {
        renderUnlockPrompt((freshWallet) => renderSettingsScreen(freshWallet), { onCancel: () => renderWalletReady(wallet) });
        return;
      }
      showToast(error.message || 'Could not update currency.');
    }
  });
}

/** Wraps the shared reveal flow in a padded .screen — every other popup screen provides its own padding this way; settings.html's own #app is already its `.card` (already padded), so it passes that straight through instead (see settings.js). */
function renderRevealFlow(wallet) {
  app.innerHTML = '<div class="screen" id="revealScreen"></div>';
  renderRevealPasswordPrompt(document.getElementById('revealScreen'), () => renderSettingsScreen(wallet));
}

// ---- Manage Tokens (human UI for the same fluxio_custom_tokens storage
// scripts/{spl-token-demo,erc20-local-demo}.mjs's printed console snippet
// writes — see background.js's CUSTOM_TOKENS_STORAGE_KEY comment) ----

/**
 * Step 1: pick a network. Lists the SAME `visibleNetworks` set the main
 * wallet screen shows (respects the Developer Networks toggle) — a
 * network you can't currently see/use in the wallet isn't manageable
 * here either; turning Developer Networks on is what makes
 * solana-local/ethereum-local etc. reachable in both places at once,
 * a single source of truth rather than a second toggle. Each row shows a
 * "N tokens" hint fetched in one round trip (FLUXIO_INTERNAL_LIST_CUSTOM_TOKENS
 * with no `networkKey` returns every network's list at once) rather than
 * one request per row.
 *
 * Reachable exactly one way: Settings -> Manage Tokens (the main wallet
 * screen has no token-management entry point at all, by design — see
 * renderWalletReady()'s own header comment). So Back always goes to
 * Settings, hardcoded, no `onBack` parameter needed here.
 */
async function renderManageTokensPicker(wallet) {
  const devNetworksEnabled = await getDevNetworksEnabled();
  const visibleNetworks = devNetworksEnabled ? [...NATIVE_NETWORKS, ...DEV_NETWORKS] : NATIVE_NETWORKS;

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Manage Tokens</h1>
      <p class="desc">Choose a network.</p>
      <div class="network-picker" id="pickerList">
        ${visibleNetworks
          .map(
            (n) => `
          <button class="secondary" id="pick-${n.key}">
            <img class="network-picker__logo" src="${chainLogoSrc(n.key)}" alt="" />
            <span>${escapeHtml(n.label)}${badgeMarkup(n.key)}</span>
            <span class="network-picker__hint" id="hint-${n.key}"></span>
          </button>`
          )
          .join('')}
      </div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => renderSettingsScreen(wallet));
  visibleNetworks.forEach((n) => {
    document
      .getElementById(`pick-${n.key}`)
      .addEventListener('click', () => renderManageTokensNetwork(wallet, n.key, { onBack: () => renderManageTokensPicker(wallet) }));
  });

  // Count hints load after the picker itself renders (non-blocking) — a
  // slow/locked round trip here shouldn't delay showing the network list.
  try {
    const { tokensByNetwork } = await sendInternal('FLUXIO_INTERNAL_LIST_CUSTOM_TOKENS');
    visibleNetworks.forEach((n) => {
      const count = tokensByNetwork[n.key]?.length || 0;
      const hintEl = document.getElementById(`hint-${n.key}`);
      if (hintEl) hintEl.textContent = count ? `${count} token${count === 1 ? '' : 's'}` : '';
    });
  } catch {
    // Non-fatal — the picker still works, just without count hints (e.g.
    // wallet locked between opening Settings and reaching this screen).
  }
}

/**
 * Step 2: manage one network's custom tokens — the current list (each
 * removable, two-click "Remove" -> "Confirm remove?" confirmation, per
 * the "light confirmation" instruction this feature was built to) plus
 * an add-token form. Only ever reached one way: the picker above, which
 * always supplies `onBack` pointing back to a fresh picker render — the
 * `onBack || renderManageTokensPicker(wallet)` default below is only a
 * defensive fallback, not a path any real navigation exercises.
 *
 * After a successful add/remove, this screen re-renders itself in place
 * (not a forced navigation back to the main screen) so multiple tokens
 * can be added back-to-back without re-navigating; the main wallet
 * screen still ends up reflecting the change the moment it's next
 * rendered, since renderWalletReady() always fetches token balances
 * fresh on every render — satisfied structurally, not by a special case
 * here.
 */
async function renderManageTokensNetwork(wallet, networkKey, { onBack } = {}) {
  const back = onBack || (() => renderManageTokensPicker(wallet));
  const label = networkLabel(networkKey);
  const isEvm = networkAccountType(networkKey) === 'evm';

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Manage Tokens</h1>
      <p class="desc">${escapeHtml(label)}${badgeMarkup(networkKey)}</p>
      <div class="loading">Loading…</div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', back);

  let tokens;
  try {
    const result = await sendInternal('FLUXIO_INTERNAL_LIST_CUSTOM_TOKENS', { networkKey });
    tokens = result.tokens;
  } catch (error) {
    if (isLockedError(error)) {
      renderUnlockPrompt((freshWallet) => renderManageTokensNetwork(freshWallet, networkKey, { onBack }), { onCancel: back });
      return;
    }
    app.innerHTML = `
      <div class="screen">
        <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
        <h1>Manage Tokens</h1>
        <div class="error">${escapeHtml(error.message || 'Could not load tokens.')}</div>
      </div>
    `;
    document.getElementById('backBtn').addEventListener('click', back);
    return;
  }

  const rerender = () => renderManageTokensNetwork(wallet, networkKey, { onBack });

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Manage Tokens</h1>
      <p class="desc">${escapeHtml(label)}${badgeMarkup(networkKey)}</p>

      <div class="panel-header"><span>Custom tokens</span></div>
      <div class="token-manage-list" id="tokenManageList">
        ${tokens.length ? tokens.map(tokenManageRowMarkup).join('') : '<p class="desc">No custom tokens registered for this network yet.</p>'}
      </div>

      <div class="panel-header"><span>Add token</span></div>
      <div id="addTokenSection"></div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', back);

  wireTokenManageRemoveButtons(tokens, networkKey, rerender, back);

  renderAddTokenSection(document.getElementById('addTokenSection'), {
    networkKey,
    isEvm,
    onAdded: () => {
      showToast('Token added.');
      rerender();
    },
    onLocked: () => renderUnlockPrompt((freshWallet) => renderManageTokensNetwork(freshWallet, networkKey, { onBack }), { onCancel: back })
  });
}

/**
 * Two-step "Add custom token" form (prompt 0119 — replacing the old
 * one-shot flat symbol/name/decimals form that manual verification of
 * prompts 0108/0109 found genuinely confusing: it wasn't clear which
 * fields were required vs optional, that blank meant auto-fetch from
 * chain, or that the fields behave differently per chain).
 *
 * Step 1 — address only: the user pastes just a mint/contract address.
 * Lookup fires automatically once the address at least LOOKS well-formed
 * (looksLikeAddress(), debounced so it doesn't fire on every keystroke
 * mid-paste), and a "Look up" button is always available too — both for
 * an immediate retry and so a malformed paste still gets real, immediate
 * server-side validation feedback instead of a dead button. Chosen over
 * "only ever an explicit button" because it's the smoother default this
 * spec asked to pick between the two, while the button stays as the
 * discoverable, always-available fallback/retry action.
 *
 * Once resolved, this calls FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN — no
 * new fetch logic of its own, that message reuses the EXACT SAME
 * fetchErc20Metadata()/fetchSolanaMintInfo() functions
 * FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN itself calls at commit time (see that
 * handler's own comment in background.js) — and branches into one of
 * three step-2 UIs by its discriminated `status`:
 *   - 'found' -> editable Symbol/Name preview, Decimals shown per
 *     shared/addTokenFlow.js's isDecimalsEditable() (a read-only on-chain
 *     fact for Solana always, and for EVM whenever it resolved; editable
 *     ONLY for EVM when it didn't).
 *   - 'rpc-unreachable' -> Retry, plus (EVM only, per
 *     shared/addTokenFlow.js's canOfferManualFallback() — Solana can
 *     never offer this, decimals is unknowable without a real mint read)
 *     an "Enter details manually" escape hatch straight into the same
 *     preview UI with nothing pre-filled — the real, routine "anvil/
 *     solana-test-validator restarted" case this spec explicitly says
 *     must not be locked out.
 *   - 'not-found' -> a clear rejection, never a path to save an empty
 *     entry — only "try a different address" (back to step 1).
 *
 * Manages its own state/DOM entirely inside `container` (a plain,
 * re-rendered-in-place subtree) — the token list above it, rendered by
 * the caller, is untouched by anything here. `onAdded()` is called after
 * a successful commit so the caller can re-fetch/re-render the whole
 * screen (list + a fresh empty step 1), matching the existing rerender()
 * pattern every other Manage Tokens action already uses. `onLocked()` is
 * called instead of handling a locked-wallet error locally, so this
 * function never needs its own copy of the renderUnlockPrompt() resume
 * logic — the caller already owns that context (the current `wallet`,
 * `networkKey`, `onBack`).
 */
function renderAddTokenSection(container, { networkKey, isEvm, onAdded, onLocked }) {
  let status = LOOKUP_STATUS.ADDRESS;
  let addressValue = '';
  let lookupResult = null; // { symbol, name, decimals } once resolved (from 'found' or chosen manually)
  let statusMessage = '';
  let debounceTimer = null;
  let lookupToken = 0; // bumped on every new lookup attempt so a stale async response can never clobber a newer one

  render();

  /** True once this section's own DOM has been replaced by a later render/navigation — guards every async continuation below, same "popup may have re-rendered to a different view under us" pattern loadBalance()/loadTokenBalances() already use. */
  function isStale() {
    return !document.body.contains(container);
  }

  function render() {
    if (isStale()) return;
    if (status === LOOKUP_STATUS.RPC_UNREACHABLE) return renderRpcUnreachableStep();
    if (status === LOOKUP_STATUS.NOT_FOUND) return renderNotFoundStep();
    if (status === LOOKUP_STATUS.FOUND || status === LOOKUP_STATUS.MANUAL) return renderPreviewStep();
    return renderAddressStep();
  }

  function renderAddressStep() {
    const isLookingUp = status === LOOKUP_STATUS.LOOKING_UP;
    container.innerHTML = `
      <div class="address-label">Token address</div>
      <p class="settings-item__hint">${
        isEvm
          ? 'Paste the contract address. Symbol, name, and decimals are read from the chain automatically.'
          : 'Paste the mint address. Decimals is always read from the mint itself; symbol and name can be added manually if the chain has none.'
      }</p>
      <input type="text" id="addAddress" placeholder="${isEvm ? '0x...' : 'Base58 mint address'}" autocomplete="off" spellcheck="false" autofocus value="${escapeHtml(addressValue)}" ${isLookingUp ? 'disabled' : ''} />
      <div class="error" id="addError">${escapeHtml(statusMessage)}</div>
      <button class="primary" id="lookupBtn" ${isLookingUp ? 'disabled' : ''}>${isLookingUp ? 'Looking up…' : 'Look up'}</button>
    `;
    const input = document.getElementById('addAddress');
    input.addEventListener('input', () => {
      addressValue = input.value.trim();
      statusMessage = '';
      const errorEl = document.getElementById('addError');
      if (errorEl) errorEl.textContent = '';
      clearTimeout(debounceTimer);
      if (looksLikeAddress(networkKey, addressValue)) {
        debounceTimer = setTimeout(attemptLookup, 500);
      }
    });
    document.getElementById('lookupBtn').addEventListener('click', () => {
      clearTimeout(debounceTimer);
      attemptLookup();
    });
  }

  function renderRpcUnreachableStep() {
    const offerManual = canOfferManualFallback({ isEvm });
    container.innerHTML = `
      <div class="address-label">Address</div>
      <p class="desc">${escapeHtml(shortenAddress(addressValue))} <button class="link" id="changeAddressBtn">Change</button></p>
      <div class="error">${escapeHtml(statusMessage)}</div>
      <button class="primary" id="retryBtn">Retry</button>
      ${offerManual ? '<p class="back-link"><button class="link" id="manualBtn">Enter details manually instead</button></p>' : ''}
    `;
    document.getElementById('changeAddressBtn').addEventListener('click', backToAddressStep);
    document.getElementById('retryBtn').addEventListener('click', attemptLookup);
    if (offerManual) {
      document.getElementById('manualBtn').addEventListener('click', () => {
        lookupResult = { symbol: null, name: null, decimals: null };
        status = LOOKUP_STATUS.MANUAL;
        render();
      });
    }
  }

  function renderNotFoundStep() {
    container.innerHTML = `
      <div class="address-label">Address</div>
      <p class="desc">${escapeHtml(shortenAddress(addressValue))}</p>
      <div class="error">${escapeHtml(statusMessage)}</div>
      <button class="primary" id="changeAddressBtn">Try a different address</button>
    `;
    document.getElementById('changeAddressBtn').addEventListener('click', backToAddressStep);
  }

  function renderPreviewStep() {
    const decimalsEditable = isDecimalsEditable({ isEvm, fetchedDecimals: lookupResult?.decimals });
    const noMetadataFound = lookupResult?.symbol == null && lookupResult?.name == null;
    container.innerHTML = `
      <div class="address-label">Address</div>
      <p class="desc">${escapeHtml(shortenAddress(addressValue))} <button class="link" id="changeAddressBtn">Change</button></p>
      ${
        noMetadataFound
          ? '<p class="settings-item__hint">No symbol or name found on chain for this token. It will show as "Unknown" unless you fill these in.</p>'
          : ''
      }
      <div class="address-label">Symbol</div>
      <input type="text" id="addSymbol" placeholder="Unknown" value="${escapeHtml(lookupResult?.symbol || '')}" autocomplete="off" spellcheck="false" maxlength="16" />
      <div class="address-label">Name</div>
      <input type="text" id="addName" placeholder="Unknown" value="${escapeHtml(lookupResult?.name || '')}" autocomplete="off" spellcheck="false" maxlength="64" />
      <div class="address-label">Decimals</div>
      ${
        decimalsEditable
          ? `<input type="text" id="addDecimals" placeholder="e.g. 18" autocomplete="off" spellcheck="false" inputmode="numeric" />
             <p class="settings-item__hint">Could not read decimals automatically. Enter it manually. An incorrect value will show the wrong balance for this token.</p>`
          : `<p class="desc">${escapeHtml(String(lookupResult.decimals))} <span class="settings-item__hint">(read from ${isEvm ? 'the contract' : 'the mint'}, cannot be changed)</span></p>`
      }
      <div class="error" id="addError"></div>
      <button class="primary" id="addBtn">Add token</button>
    `;
    document.getElementById('changeAddressBtn').addEventListener('click', backToAddressStep);
    document.getElementById('addBtn').addEventListener('click', () => submitAdd(decimalsEditable));
  }

  function backToAddressStep() {
    status = LOOKUP_STATUS.ADDRESS;
    statusMessage = '';
    render();
  }

  async function attemptLookup() {
    if (!addressValue) {
      statusMessage = 'Enter a token address.';
      status = LOOKUP_STATUS.ADDRESS;
      return render();
    }
    status = LOOKUP_STATUS.LOOKING_UP;
    render();
    const myToken = ++lookupToken;
    try {
      const result = await sendInternal('FLUXIO_INTERNAL_PREVIEW_CUSTOM_TOKEN', { networkKey, address: addressValue });
      if (isStale() || myToken !== lookupToken) return; // superseded by a newer lookup, or the popup navigated away
      if (result.status === 'found') {
        lookupResult = { symbol: result.symbol, name: result.name, decimals: result.decimals };
        status = LOOKUP_STATUS.FOUND;
      } else {
        statusMessage = result.message;
        status = result.status === 'rpc-unreachable' ? LOOKUP_STATUS.RPC_UNREACHABLE : LOOKUP_STATUS.NOT_FOUND;
      }
    } catch (error) {
      if (isStale() || myToken !== lookupToken) return;
      if (isLockedError(error)) {
        onLocked();
        return;
      }
      // A genuine caller-input problem (malformed address, already
      // registered, unknown network) — surfaced on step 1, same as the
      // old flat form's own inline validation errors.
      statusMessage = error.message || 'Could not look up this token.';
      status = LOOKUP_STATUS.ADDRESS;
    }
    render();
  }

  async function submitAdd(decimalsEditable) {
    const addBtn = document.getElementById('addBtn');
    const addError = document.getElementById('addError');
    const symbol = document.getElementById('addSymbol').value.trim();
    const name = document.getElementById('addName').value.trim();

    let decimals;
    if (decimalsEditable) {
      const raw = document.getElementById('addDecimals').value.trim();
      if (!raw) {
        addError.textContent = 'Enter decimals. It could not be read automatically.';
        return;
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 18) {
        addError.textContent = 'Decimals must be a whole number between 0 and 18.';
        return;
      }
      decimals = parsed;
    }

    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    try {
      await sendInternal('FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN', {
        networkKey,
        address: addressValue,
        symbol: symbol || undefined,
        name: name || undefined,
        decimals
      });
      if (isStale()) return;
      onAdded();
    } catch (error) {
      if (isStale()) return;
      if (isLockedError(error)) {
        onLocked();
        return;
      }
      addError.textContent = error.message || 'Could not add token.';
      addBtn.disabled = false;
      addBtn.textContent = 'Add token';
    }
  }
}

/** One registered custom token's row in the management list — logo/symbol/truncated address, plus a Remove button (two-click confirm, wired separately by wireTokenManageRemoveButtons so this stays a pure markup function). */
function tokenManageRowMarkup(token, idx) {
  const initial = (token.symbol || '?').charAt(0).toUpperCase();
  return `
    <div class="token-manage-row">
      <span class="token-row__logo" style="background:${avatarColorFor(token.address)}">${escapeHtml(initial)}</span>
      <div class="token-manage-row__meta">
        <span class="token-manage-row__symbol">${escapeHtml(token.symbol)}</span>
        <span class="token-manage-row__address">${escapeHtml(shortenAddress(token.address))}</span>
      </div>
      <button class="link token-manage-row__remove" id="remove-${idx}">Remove</button>
    </div>
  `;
}

/**
 * Wires each row's Remove button to a light two-click confirmation: first
 * click turns it into "Confirm remove?" (danger-colored, via the
 * `--confirm` class); a second click on that SAME button actually
 * removes it. Clicking any OTHER row's Remove button first resets this
 * one back to its normal state — only one row is ever "armed" at a time,
 * so a stray click elsewhere can't leave a forgotten armed button behind
 * to be accidentally confirmed later.
 */
function wireTokenManageRemoveButtons(tokens, networkKey, rerender, back) {
  let armedIdx = null;
  tokens.forEach((token, idx) => {
    const btn = document.getElementById(`remove-${idx}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (armedIdx !== idx) {
        if (armedIdx !== null) {
          const previous = document.getElementById(`remove-${armedIdx}`);
          if (previous) {
            previous.textContent = 'Remove';
            previous.classList.remove('token-manage-row__remove--confirm');
          }
        }
        armedIdx = idx;
        btn.textContent = 'Confirm remove?';
        btn.classList.add('token-manage-row__remove--confirm');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Removing…';
      try {
        await sendInternal('FLUXIO_INTERNAL_REMOVE_CUSTOM_TOKEN', { networkKey, address: token.address });
        showToast('Token removed.');
        rerender();
      } catch (error) {
        if (isLockedError(error)) {
          renderUnlockPrompt((freshWallet) => renderManageTokensNetwork(freshWallet, networkKey, { onBack: back }), { onCancel: back });
          return;
        }
        showToast(error.message || 'Could not remove token.');
        btn.disabled = false;
        btn.textContent = 'Remove';
        btn.classList.remove('token-manage-row__remove--confirm');
        armedIdx = null;
      }
    });
  });
}

// ---- Activity (transaction history — local send record merged with real
// Solana chain history; EVM is local-record-only, see
// @fluxio/services/historyService.js's own header comment for why) ----

/**
 * Entry-point placement decision: a small icon in the account card's
 * header row, next to Refresh/Settings/Lock — NOT tucked into Settings
 * the way Manage Tokens was deliberately placed (see that feature's own
 * "+ Add token" removal comment, prompt 0110). The two decisions look
 * inconsistent side by side but rest on the same underlying principle
 * ("don't clutter the main screen with rarely-used actions") applied to
 * genuinely different frequencies of use: Manage Tokens is an occasional
 * configuration action (register a custom token once, rarely revisit),
 * while Activity — viewing your own transaction history — is core,
 * everyday wallet usage on par with Send/Receive/checking a balance, the
 * same way every reference wallet (Phantom, MetaMask) treats it as a
 * primary surface, not a Settings sub-item. A single icon among three
 * already-established header icons (Refresh/Settings/Lock) adds no new
 * visual language and no repeated per-row clutter the way the old "+ Add
 * token" links did — it's one icon, once, not N.
 */
async function renderActivityPicker(wallet, { onBack } = {}) {
  const back = onBack || (() => renderWalletReady(wallet));
  const devNetworksEnabled = await getDevNetworksEnabled();
  const visibleNetworks = devNetworksEnabled ? [...NATIVE_NETWORKS, ...DEV_NETWORKS] : NATIVE_NETWORKS;

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Activity</h1>
      <p class="desc">Choose a network.</p>
      <div class="network-picker" id="pickerList">
        ${visibleNetworks
          .map(
            (n) => `
          <button class="secondary" id="pick-${n.key}">
            <img class="network-picker__logo" src="${chainLogoSrc(n.key)}" alt="" />
            <span>${escapeHtml(n.label)}${badgeMarkup(n.key)}</span>
          </button>`
          )
          .join('')}
      </div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', back);
  visibleNetworks.forEach((n) => {
    document
      .getElementById(`pick-${n.key}`)
      .addEventListener('click', () => renderActivityNetwork(wallet, n.key, { onBack: () => renderActivityPicker(wallet, { onBack }) }));
  });
}

/** Step 2 shell: renders the loading state immediately, then hands off to loadActivity() for the actual fetch — kept separate so Back/Retry/Refresh can all re-invoke loadActivity() without re-flashing the whole screen's static chrome (heading, Back row) each time. */
async function renderActivityNetwork(wallet, networkKey, { onBack } = {}) {
  const back = onBack || (() => renderActivityPicker(wallet));
  const label = networkLabel(networkKey);

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Activity</h1>
      <p class="desc">${escapeHtml(label)}${badgeMarkup(networkKey)}</p>
      <div class="loading">Loading…</div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', back);

  await loadActivity(wallet, networkKey, back);
}

/**
 * Fetches and renders one network's merged Activity list. Failure
 * isolation: a thrown error here only ever means the WHOLE
 * FLUXIO_INTERNAL_GET_HISTORY call itself failed (locked wallet, or some
 * unexpected error) — a chain-history-specific failure never reaches
 * this catch block at all, because background.js already isolates that
 * internally and returns local entries plus `chainHistoryError` instead
 * of throwing (see that handler's own comment) — this is the same
 * "isolasi kegagalan" lesson prompt 0108 established for token balances,
 * applied here: a dead RPC must never blank the whole screen.
 */
async function loadActivity(wallet, networkKey, back) {
  const label = networkLabel(networkKey);
  const isEvm = networkAccountType(networkKey) === 'evm';

  let entries;
  let chainHistoryError;
  try {
    const result = await sendInternal('FLUXIO_INTERNAL_GET_HISTORY', { networkKey });
    entries = result.entries;
    chainHistoryError = result.chainHistoryError;
  } catch (error) {
    if (isLockedError(error)) {
      renderUnlockPrompt((freshWallet) => renderActivityNetwork(freshWallet, networkKey, { onBack: back }), { onCancel: back });
      return;
    }
    app.innerHTML = `
      <div class="screen">
        <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
        <h1>Activity</h1>
        <p class="desc">${escapeHtml(label)}${badgeMarkup(networkKey)}</p>
        <div class="error">${escapeHtml(error.message || 'Could not load activity.')}</div>
        <button class="secondary" id="retryBtn">Retry</button>
      </div>
    `;
    document.getElementById('backBtn').addEventListener('click', back);
    document.getElementById('retryBtn').addEventListener('click', () => loadActivity(wallet, networkKey, back));
    return;
  }

  // EVM's empty state is deliberately more specific than Solana's — see
  // historyService.js's own header comment: EVM Activity is local-
  // record-only (no chain history at all this slice), so an empty list
  // here doesn't mean "this address has never received anything," only
  // "this wallet hasn't sent anything on this network yet." Saying so
  // plainly avoids the empty state silently implying a guarantee this
  // feature doesn't actually make.
  const emptyNote = isEvm
    ? "No activity yet. Only transfers sent from this wallet are recorded here. Incoming transfers are not tracked without a paid indexer (see this network's own history limitation)."
    : 'No activity yet.';

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <div class="activity-header">
        <div>
          <h1>Activity</h1>
          <p class="desc">${escapeHtml(label)}${badgeMarkup(networkKey)}</p>
        </div>
        <button class="account-card__icon-btn" id="refreshActivity" title="Refresh" aria-label="Refresh">${ICONS.refresh}</button>
      </div>
      ${
        chainHistoryError
          ? `<div class="activity-banner">Chain history failed to load. Showing this wallet's own sent transactions only. <button class="link" id="retryChainHistory">Retry</button></div>`
          : ''
      }
      ${
        entries.length
          ? `<div class="activity-list">${entries.map(activityRowMarkup).join('')}</div>`
          : `<p class="desc activity-empty">${escapeHtml(emptyNote)}</p>`
      }
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', back);
  document.getElementById('refreshActivity').addEventListener('click', () => loadActivity(wallet, networkKey, back));
  document.getElementById('retryChainHistory')?.addEventListener('click', () => loadActivity(wallet, networkKey, back));

  entries.forEach((entry, idx) => {
    if (!entry.explorerUrl) return;
    // Same window.open(...,'_blank','noopener,noreferrer') pattern
    // renderSendResult()'s own "View on Explorer" button already uses —
    // not a plain <a href> tag, for consistency with that established
    // click-to-open handling.
    document.getElementById(`activity-explorer-${idx}`)?.addEventListener('click', () => {
      window.open(entry.explorerUrl, '_blank', 'noopener,noreferrer');
    });
  });
}

/** One Activity entry — direction icon+label (reusing the exact Send/Receive glyphs from the action row, for the same outbound/inbound visual language), signed amount, relative time, counterparty address (truncated), a colored status word, and an explorer link/button when this network has one. */
function activityRowMarkup(entry, idx) {
  if (entry.type === 'swap') {
    return swapActivityRowMarkup(entry, idx);
  }
  // Approval row (tahap C, 0223 Revisi 3): the approve leg of a token-in
  // swap — its gas has to trace in Activity even when the swap leg never
  // followed. Texts carry no hyphens or dashes (standing UI rule).
  if (entry.type === 'approval') {
    const approvalExplorerBtn = entry.explorerUrl
      ? `<button class="link activity-row__explorer" id="activity-explorer-${idx}">View</button>`
      : '';
    return `
    <div class="activity-row">
      <span class="activity-row__icon activity-row__icon--out">${ICONS.send}</span>
      <div class="activity-row__meta">
        <span class="activity-row__label">Approval <span class="activity-row__counterparty">${entry.approvalKind === 'reset' ? 'Reset approval for swap' : `Approve ${escapeHtml(entry.tokenSymbol || 'token')} for swap`}</span></span>
        <span class="activity-row__time">${escapeHtml(entry.relativeTime)}</span>
      </div>
      <div class="activity-row__right">
        <span class="activity-row__amount">${entry.amountFormatted != null ? `${escapeHtml(trimAmount(entry.amountFormatted))} ${escapeHtml(entry.tokenSymbol || '')}` : ''}</span>
        <div class="activity-row__right-bottom">
          <span class="activity-row__status activity-row__status--${entry.status}">${escapeHtml(entry.status)}</span>
          ${approvalExplorerBtn}
        </div>
      </div>
    </div>
  `;
  }
  const isOut = entry.direction === 'out';
  const icon = isOut ? ICONS.send : ICONS.receive;
  const directionLabel = isOut ? 'Sent' : 'Received';
  const prepositionAndParty = entry.counterpartyAddress
    ? `${isOut ? 'to' : 'from'} ${shortenAddress(entry.counterpartyAddress)}`
    : isOut
      ? 'to unknown address'
      : 'from unknown address';
  const sign = isOut ? '−' : '+';
  const explorerBtn = entry.explorerUrl
    ? `<button class="link activity-row__explorer" id="activity-explorer-${idx}">View</button>`
    : '';
  // Token vs native entries (prompt 0113): a small "Token" pill next to
  // the amount — entry.unit already differs (a token's own symbol, e.g.
  // "USDC", instead of the network's native currency), but this feature's
  // explicit requirement is that the two read as CLEARLY distinguished,
  // not just implicitly via a different symbol someone has to notice.
  const tokenBadge = entry.isToken ? ' <span class="badge-token">Token</span>' : '';

  return `
    <div class="activity-row">
      <span class="activity-row__icon activity-row__icon--${entry.direction}">${icon}</span>
      <div class="activity-row__meta">
        <span class="activity-row__label">${directionLabel} <span class="activity-row__counterparty">${escapeHtml(prepositionAndParty)}</span></span>
        <span class="activity-row__time">${escapeHtml(entry.relativeTime)}</span>
      </div>
      <div class="activity-row__right">
        <span class="activity-row__amount activity-row__amount--${entry.direction}">${sign}${escapeHtml(trimAmount(entry.amountFormatted))} ${escapeHtml(entry.unit)}${tokenBadge}</span>
        <div class="activity-row__right-bottom">
          <span class="activity-row__status activity-row__status--${entry.status}">${escapeHtml(entry.status)}</span>
          ${explorerBtn}
        </div>
      </div>
    </div>
  `;
}

/**
 * Swap-type Activity row (prompt 0115) — genuinely different shape from a
 * transfer row (no single direction/counterparty/amount+unit; instead
 * "X SOL -> Y USDC"), per this feature's explicit requirement. Live as of
 * prompt 0200: FLUXIO_INTERNAL_EXECUTE_SWAP's success path writes this
 * shape for real, and this renderer needed zero changes that day — the
 * exact point of preparing it in 0115, with no further UI
 * change needed then.
 */
function swapActivityRowMarkup(entry, idx) {
  const explorerBtn = entry.explorerUrl
    ? `<button class="link activity-row__explorer" id="activity-explorer-${idx}">View</button>`
    : '';
  // Prompt 0206 butir 4 (owner opsi A): the in/out amounts render as two
  // STACKED lines in the right column — one nowrap line each — instead of
  // one long "X USDT → Y SOL" line, which genuinely collided with the
  // left column on real entries (reproduced with the 0205 real-money
  // history in this prompt's fase 1). Full numbers, no extra rounding;
  // Sent/Received rows (activityRowMarkup above) share none of this markup.
  return `
    <div class="activity-row activity-row--swap">
      <span class="activity-row__icon activity-row__icon--swap">${ICONS.swap}</span>
      <div class="activity-row__meta">
        <span class="activity-row__label">Swap</span>
        <span class="activity-row__time">${escapeHtml(entry.relativeTime)}</span>
      </div>
      <div class="activity-row__right">
        ${
          entry.inputAmountFormatted != null && entry.outputAmountFormatted != null
            ? `<span class="activity-row__amount activity-row__swap-amount">
          <span class="activity-row__swap-line">${escapeHtml(trimAmount(entry.inputAmountFormatted))} ${escapeHtml(entry.inputSymbol)}</span>
          <span class="activity-row__swap-line">→ ${escapeHtml(trimAmount(entry.outputAmountFormatted))} ${escapeHtml(entry.outputSymbol)}</span>
        </span>`
            : entry.chainNote
              ? `<span class="activity-row__swap-note">${escapeHtml(entry.chainNote)}</span>`
              : ''
        }
        <div class="activity-row__right-bottom">
          <span class="activity-row__status activity-row__status--${entry.status}">${escapeHtml(entry.status)}</span>
          ${explorerBtn}
        </div>
      </div>
    </div>
  `;
}

// ---- Notifications (prompt 0170 — an inbox of admin-published announcements, GET /api/announcements) ----

/**
 * The header bell icon's own screen — awaits one more (throttle-gated,
 * usually a no-op) fetch attempt so the list is as fresh as this exact
 * open is allowed to be, renders it newest-first (server order, already
 * DESC by created_at — see backend/src/db/repositories/announcementsRepo.js),
 * then marks everything just shown as read in one call (see
 * FLUXIO_INTERNAL_MARK_NOTIFICATIONS_READ's own comment on why "open =
 * read everything" was chosen over a per-item click handler).
 */
async function renderNotificationsScreen(wallet) {
  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Notifications</h1>
      <div class="loading">Loading…</div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => renderWalletReady(wallet));

  const { announcements, readIds } = await sendInternal('FLUXIO_INTERNAL_GET_NOTIFICATIONS');

  if (!announcements.length) {
    app.innerHTML = `
      <div class="screen">
        <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
        <h1>Notifications</h1>
        <p class="desc notif-empty">No notifications yet.</p>
      </div>
    `;
    document.getElementById('backBtn').addEventListener('click', () => renderWalletReady(wallet));
    return;
  }

  const readSet = new Set(readIds);
  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Notifications</h1>
      <div class="notif-list">
        ${announcements.map((a) => notificationItemShellMarkup(a, !readSet.has(a.id))).join('')}
      </div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => renderWalletReady(wallet));

  // Title/body are built as real DOM nodes here, AFTER the shell above is
  // in the document — never via innerHTML/insertAdjacentHTML with server
  // content interpolated into the string, which is exactly the class of
  // bug this whole feature is designed to avoid. See richTextParse.js/
  // renderRestrictedHtml.js's own header comments for the full boundary.
  announcements.forEach((a) => {
    renderNotificationRichField(`notif-title-${a.id}`, a.title, a.titleFormat);
    renderNotificationRichField(`notif-body-${a.id}`, a.body, a.bodyFormat);
  });

  // Opening this screen marks everything currently shown as read — see
  // FLUXIO_INTERNAL_MARK_NOTIFICATIONS_READ's own comment for why this,
  // not a per-item click handler, was chosen. Fire-and-forget: the badge
  // update it performs server-side only matters for the NEXT popup open
  // (this screen doesn't show its own unread dots after this point makes
  // them all moot anyway — see notificationItemShellMarkup(), which
  // already rendered every dot from the PRE-mark-read state above).
  sendInternal('FLUXIO_INTERNAL_MARK_NOTIFICATIONS_READ').catch(() => {
    // Best-effort — worst case, the badge/dot stays as it was until the
    // next successful mark-as-read (e.g. the next time this screen opens).
  });
}

/**
 * The static shell for one notification row — title/body are left as
 * empty containers (`#notif-title-<id>`/`#notif-body-<id>`), filled in
 * separately via real DOM APIs by renderNotificationRichField() below,
 * never interpolated here. Only trusted, locally-known values (id, level,
 * date, unread flag) are interpolated into this template string — never
 * `a.title`/`a.body` themselves, which are the one thing about an
 * announcement that ultimately originated from outside this extension.
 */
function notificationItemShellMarkup(a, isUnread) {
  const dateLabel = formatNotificationDate(a.startsAt || a.firstSeenAt);
  return `
    <div class="notif-item${isUnread ? ' notif-item--unread' : ''}">
      <div class="notif-item__header">
        <span class="notif-level notif-level--${escapeHtml(a.level)}">${escapeHtml(a.level)}</span>
        ${isUnread ? '<span class="notif-dot" aria-hidden="true"></span>' : ''}
        <span class="notif-item__date">${escapeHtml(dateLabel)}</span>
      </div>
      <div class="notif-item__title" id="notif-title-${escapeHtml(a.id)}"></div>
      <div class="notif-item__body" id="notif-body-${escapeHtml(a.id)}"></div>
    </div>
  `;
}

/**
 * Fills one already-in-the-document container with real DOM nodes for
 * one title/body field. A `'plain'`-format value (the legacy shape, still
 * possible for an announcement created before rich text existed — see
 * CLAUDE.md's own prompt 0163 section) is shown as literal text via
 * `.textContent`, newlines preserved through CSS `white-space: pre-wrap`
 * (`.notif-item__title`/`.notif-item__body` in popup.css) rather than any
 * HTML interpretation at all — matching this feature's own explicit
 * requirement ("Pengumuman format plain tampil sebagai teks apa adanya
 * termasuk baris baru"). An `'html'`-format value goes through the
 * restricted parser + DOM builder — see either module's own header
 * comment for the full safety boundary.
 */
function renderNotificationRichField(elementId, value, format) {
  const container = document.getElementById(elementId);
  if (!container) return;
  if (format === 'html') {
    renderRestrictedHtmlNodes(container, parseRestrictedHtmlToNodes(value));
  } else {
    container.textContent = value ?? '';
  }
}

/**
 * A plain, locale-formatted date/time string — no relative-time wording
 * (unlike Activity's entries, which get a pre-formatted relativeTime
 * string FROM background.js, since that computation needs
 * @fluxio/utils — see that section's own header comment). This one stays
 * a small local helper instead: an announcement's date only needs to
 * read as "when," not "how long ago," and Intl.DateTimeFormat needs no
 * @fluxio/* import at all, so there's no reason to route it through a
 * message the way every amount/relative-time string in this file already
 * has to.
 */
function formatNotificationDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ---- Send flow (Tahap C: Solana test networks; Tahap D: + EVM test networks — see SENDABLE_NETWORK_KEYS) ----

/**
 * Step 1 (was: address + amount form for the native coin only; prompt
 * 0113 generalizes it to any asset picked in the new renderSendAssetPicker
 * step just before this). `asset` is `{ type: 'native' }` or
 * `{ type: 'token', address, symbol, decimals }` — everything this form
 * (and the two steps after it) need to know to tell the two apart.
 * `prefill` carries values back from a later step (Back from Confirm, or
 * resuming after an inline unlock) so the user never loses what they
 * already typed.
 */
async function renderSendForm(networkKey, wallet, asset, prefill = {}) {
  const label = networkLabel(networkKey);
  const senderAddress = senderAddressFor(networkKey, wallet);
  const isToken = asset.type === 'token';
  // A token's own decimals (read from GET_TOKEN_BALANCES, ultimately
  // chain/registry-sourced — see tokenService.js) rather than the fixed
  // 9/18 native precision — a token's decimals is neither, generally.
  const precision = isToken ? asset.decimals : amountPrecisionFor(networkKey);

  app.innerHTML = `
    <div class="screen">
      <h1>Send</h1>
      <p class="desc">${escapeHtml(label)}${badgeMarkup(networkKey)}</p>
      <div class="loading">Loading balance…</div>
    </div>
  `;

  let balance;
  let symbol;
  try {
    if (isToken) {
      // Reuses FLUXIO_INTERNAL_GET_TOKEN_BALANCES — the same data the
      // asset picker just fetched — rather than a dedicated single-token
      // balance message, per this feature's explicit instruction. Fetched
      // fresh here too (not passed down from the picker) so a balance
      // that changed between the two screens is never silently stale.
      const { tokens } = await sendInternal('FLUXIO_INTERNAL_GET_TOKEN_BALANCES', { networkKey });
      const match = tokens.find((t) => t.address === asset.address);
      balance = match ? match.amountFormatted : '0';
      symbol = asset.symbol;
    } else {
      const result = await sendInternal('FLUXIO_INTERNAL_GET_BALANCE', { networkKey });
      balance = result.formatted;
      symbol = result.symbol;
    }
  } catch (error) {
    if (isLockedError(error)) {
      renderUnlockPrompt((freshWallet) => renderSendForm(networkKey, freshWallet, asset, prefill), { onCancel: () => main() });
      return;
    }
    app.innerHTML = `
      <div class="screen">
        <h1>Send</h1>
        <div class="error">${escapeHtml(error.message || 'Could not load balance.')}</div>
        <button class="secondary" id="backBtn">Back</button>
      </div>
    `;
    document.getElementById('backBtn').addEventListener('click', () => renderWalletReady(wallet));
    return;
  }

  app.innerHTML = `
    <div class="screen">
      <h1>Send ${escapeHtml(symbol)}</h1>
      <p class="desc">${escapeHtml(label)}${badgeMarkup(networkKey)}</p>

      <div class="address-label">Available</div>
      <div class="address-box send-balance">${escapeHtml(trimAmount(balance, precision))} ${escapeHtml(symbol)}</div>

      <div class="address-label">Recipient address</div>
      <input type="text" id="toInput" placeholder="${escapeHtml(label)} address" value="${escapeHtml(prefill.to || '')}" autocomplete="off" spellcheck="false" />
      <div class="error" id="toError"></div>

      <div class="address-label">Amount (${escapeHtml(symbol)})</div>
      <div class="send-amount-row">
        <input type="text" id="amountInput" placeholder="0.00" value="${escapeHtml(prefill.amount || '')}" autocomplete="off" inputmode="decimal" />
        <button class="link" id="maxBtn">MAX</button>
      </div>
      <div class="error" id="amountError"></div>

      <div class="error" id="formError"></div>
      <button class="primary" id="continueBtn">Continue</button>
      <button class="secondary" id="cancelBtn">Cancel</button>
    </div>
  `;

  const toInput = document.getElementById('toInput');
  const amountInput = document.getElementById('amountInput');
  const toError = document.getElementById('toError');
  const amountError = document.getElementById('amountError');
  const formError = document.getElementById('formError');
  const continueBtn = document.getElementById('continueBtn');
  const maxBtn = document.getElementById('maxBtn');

  document.getElementById('cancelBtn').addEventListener('click', () => renderWalletReady(wallet));

  function validateLive() {
    let ok = true;
    const to = toInput.value.trim();
    if (to && !looksLikeAddress(networkKey, to)) {
      toError.textContent = `Doesn't look like a valid ${escapeHtml(label)} address.`;
      ok = false;
    } else {
      toError.textContent = '';
    }

    const amountText = amountInput.value.trim();
    if (amountText) {
      const amountNum = Number(amountText);
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        amountError.textContent = 'Enter an amount greater than 0.';
        ok = false;
      } else if (amountNum > Number(balance)) {
        amountError.textContent = 'Amount exceeds available balance.';
        ok = false;
      } else {
        amountError.textContent = '';
      }
    } else {
      amountError.textContent = '';
    }

    if (!to || !amountText) ok = false;
    continueBtn.disabled = !ok;
    return ok;
  }

  toInput.addEventListener('input', validateLive);
  amountInput.addEventListener('input', validateLive);
  validateLive();

  maxBtn.addEventListener('click', async () => {
    // Token MAX = the full token balance, already known from the fetch
    // above — no round trip needed. Unlike native (where MAX must
    // subtract the network fee, paid from the SAME balance being sent),
    // a token's fee is paid in a completely different currency (the
    // native coin), so nothing about the token balance itself needs to be
    // reserved — per this feature's explicit instruction ("token tidak
    // perlu sisakan fee — fee dibayar native").
    if (isToken) {
      amountInput.value = stripTrailingZeros(balance);
      validateLive();
      return;
    }
    maxBtn.disabled = true;
    formError.textContent = '';
    const typedTo = toInput.value.trim();
    // A fee-only estimate doesn't depend on which valid address is used —
    // see FEE_ESTIMATE_PLACEHOLDER_AMOUNT's own comment — falls back to
    // the sender's own address so MAX works even before a recipient has
    // been typed.
    const estimateTo = typedTo && looksLikeAddress(networkKey, typedTo) ? typedTo : senderAddress;
    try {
      const result = await sendInternal('FLUXIO_INTERNAL_ESTIMATE_TRANSFER', {
        networkKey,
        to: estimateTo,
        amount: FEE_ESTIMATE_PLACEHOLDER_AMOUNT
      });
      amountInput.value = stripTrailingZeros(result.maxSendableAmount);
      validateLive();
    } catch (error) {
      if (isLockedError(error)) {
        renderUnlockPrompt(
          (freshWallet) => renderSendForm(networkKey, freshWallet, asset, { to: typedTo, amount: amountInput.value }),
          { onCancel: () => main() }
        );
        return;
      }
      formError.textContent = error.message || 'Could not estimate the maximum sendable amount.';
    } finally {
      maxBtn.disabled = false;
    }
  });

  continueBtn.addEventListener('click', async () => {
    if (!validateLive()) return;
    continueBtn.disabled = true;
    formError.textContent = '';
    const to = toInput.value.trim();
    const amount = amountInput.value.trim();
    try {
      const estimate = await sendInternal('FLUXIO_INTERNAL_ESTIMATE_TRANSFER', {
        networkKey,
        to,
        amount,
        tokenAddress: isToken ? asset.address : undefined
      });
      if (!estimate.sufficient) {
        formError.textContent = isToken
          ? !estimate.sufficientToken
            ? `Amount (${trimAmount(estimate.tokenAmount, precision)} ${symbol}) exceeds available balance (${trimAmount(estimate.tokenBalanceAmount, precision)} ${symbol}).`
            : `Network fee${estimate.needsAta ? ' plus the new recipient account’s rent' : ''} (${trimAmount(estimate.nativeRequiredAmount)} ${estimate.nativeSymbol}) exceeds available ${estimate.nativeSymbol} balance (${trimAmount(estimate.nativeBalanceAmount)} ${estimate.nativeSymbol}).`
          : `Amount + fee (${trimAmount(estimate.totalAmount, precision)} ${symbol}) exceeds available balance (${trimAmount(estimate.balanceAmount, precision)} ${symbol}).`;
        continueBtn.disabled = false;
        return;
      }
      renderSendConfirm(networkKey, wallet, asset, {
        to,
        amount,
        symbol,
        isToken,
        feeAmount: estimate.feeAmount,
        isMaxFee: estimate.isMaxFee,
        // 0242 (catatan 18, EVM saja — undefined untuk Solana): plafon wei
        // mentah dari estimasi, dikirim balik di SEND_TRANSFER supaya pagar
        // background menegakkan persis angka yang layar ini tampilkan.
        maxFeeWei: estimate.maxFeeWei,
        // Native-only:
        totalAmount: estimate.totalAmount,
        // Token-only:
        nativeSymbol: estimate.nativeSymbol,
        needsAta: estimate.needsAta,
        ataRentAmount: estimate.ataRentAmount
      });
    } catch (error) {
      if (isLockedError(error)) {
        renderUnlockPrompt((freshWallet) => renderSendForm(networkKey, freshWallet, asset, { to, amount }), { onCancel: () => main() });
        return;
      }
      formError.textContent = error.message || 'Could not estimate this transfer.';
      continueBtn.disabled = false;
    }
  });
}

/**
 * Step 2: confirmation summary — recipient shown in full (never
 * truncated: a wrong address here means lost funds). For a native send:
 * amount, fee, total, all in the same currency (unchanged from before
 * this feature). For a TOKEN send (prompt 0113): amount (token currency)
 * and network fee (native currency) are shown as SEPARATE rows with their
 * own units — never summed into one "Total", since they're not the same
 * currency — plus a "New account rent" row, shown ONLY when
 * `details.needsAta` is true (the recipient has no token account for this
 * mint yet and one will be created in the same transaction, sender-paid —
 * per this feature's explicit "jujur soal biaya, jangan diam-diam"
 * requirement, this row simply doesn't exist when there's no such cost).
 * Fee row label reflects `isMaxFee`: EVM's EIP-1559 fee (native AND
 * ERC-20 token sends alike) is an upper bound the actual charge may come
 * in under, so it's labeled "Max network fee" rather than Solana's exact
 * "Network fee".
 */
function renderSendConfirm(networkKey, wallet, asset, details) {
  const { to, amount, symbol, feeAmount, isMaxFee, isToken } = details;
  const label = networkLabel(networkKey);
  const precision = isToken ? asset.decimals : amountPrecisionFor(networkKey);
  const nativePrecision = amountPrecisionFor(networkKey);
  const feeLabel = isMaxFee ? 'Max network fee' : 'Network fee';

  const summaryRows = isToken
    ? `
      <div class="confirm-row"><span>Amount</span><span>${escapeHtml(trimAmount(amount, precision))} ${escapeHtml(symbol)}</span></div>
      <div class="confirm-row"><span>${escapeHtml(feeLabel)}</span><span>${escapeHtml(trimAmount(feeAmount, nativePrecision))} ${escapeHtml(details.nativeSymbol)}</span></div>
      ${
        details.needsAta
          ? `<div class="confirm-row confirm-row--total"><span>New account rent</span><span>${escapeHtml(trimAmount(details.ataRentAmount, nativePrecision))} ${escapeHtml(details.nativeSymbol)}</span></div>`
          : ''
      }
    `
    : `
      <div class="confirm-row"><span>Amount</span><span>${escapeHtml(trimAmount(amount, precision))} ${escapeHtml(symbol)}</span></div>
      <div class="confirm-row"><span>${escapeHtml(feeLabel)}</span><span>${escapeHtml(trimAmount(feeAmount, precision))} ${escapeHtml(symbol)}</span></div>
      <div class="confirm-row confirm-row--total"><span>Total${isMaxFee ? ' (max)' : ''}</span><span>${escapeHtml(trimAmount(details.totalAmount, precision))} ${escapeHtml(symbol)}</span></div>
    `;

  app.innerHTML = `
    <div class="screen">
      <h1>Confirm Send</h1>
      <p class="desc">${escapeHtml(label)}${badgeMarkup(networkKey)}</p>

      <div class="address-label">To</div>
      <div class="address-box">${escapeHtml(to)}</div>

      ${summaryRows}

      <div class="error" id="confirmError"></div>
      <button class="primary" id="confirmBtn">Confirm &amp; Send</button>
      <button class="secondary" id="backBtn">Back</button>
    </div>
  `;

  document.getElementById('backBtn').addEventListener('click', () => renderSendForm(networkKey, wallet, asset, { to, amount }));

  const confirmBtn = document.getElementById('confirmBtn');
  const backBtn = document.getElementById('backBtn');
  const confirmError = document.getElementById('confirmError');

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    backBtn.disabled = true;
    confirmBtn.textContent = 'Sending…';
    confirmError.textContent = '';
    try {
      const result = await sendInternal('FLUXIO_INTERNAL_SEND_TRANSFER', {
        networkKey,
        to,
        amount,
        tokenAddress: isToken ? asset.address : undefined,
        // 0242 (catatan 18): plafon tampil ikut ke background — EVM wajib
        // (fail closed di handler), Solana tidak memilikinya (undefined).
        displayedMaxFeeWei: details.maxFeeWei
      });
      renderSendResult(networkKey, wallet, result);
    } catch (error) {
      if (isLockedError(error)) {
        renderUnlockPrompt((freshWallet) => renderSendConfirm(networkKey, freshWallet, asset, details), { onCancel: () => main() });
        return;
      }
      // "opsi coba lagi": the Confirm button itself, re-enabled, is the retry — no separate screen needed.
      confirmError.textContent = error.message || 'Failed to send transaction.';
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm & Send';
      backBtn.disabled = false;
    }
  });
}

/** Step 3 (success only — failure stays inline on the Confirm screen, see above): hash + explorer link (hidden entirely when the network has none, e.g. ethereum-local — see evmExplorerUrl in evmTransactionService.js), then a bounded background poll that upgrades the note to "Confirmed" without blocking either button. */
function renderSendResult(networkKey, wallet, { hash, explorerUrl }) {
  const label = networkLabel(networkKey);
  const hashLabel = networkAccountType(networkKey) === 'evm' ? 'Transaction hash' : 'Signature';
  app.innerHTML = `
    <div class="screen">
      <h1>Sent</h1>
      <p class="desc">Your transaction was broadcast to ${escapeHtml(label)}${badgeMarkup(networkKey)}.</p>

      <div class="address-label">${escapeHtml(hashLabel)}</div>
      <div class="address-box">${escapeHtml(hash)}</div>

      ${explorerUrl ? '<button class="primary" id="viewExplorer">View on Explorer</button>' : ''}
      <button class="secondary" id="doneBtn">Done</button>

      <p class="desc send-result__note" id="confirmingNote">Confirming on-chain…</p>
    </div>
  `;

  if (explorerUrl) {
    document.getElementById('viewExplorer').addEventListener('click', () => {
      window.open(explorerUrl, '_blank', 'noopener,noreferrer');
    });
  }
  // Re-renders the wallet screen, which always fetches every visible
  // network's balance fresh on render — satisfies "refresh the balance
  // for that network after a successful send" with no special-cased path.
  document.getElementById('doneBtn').addEventListener('click', () => renderWalletReady(wallet));

  pollConfirmation(networkKey, hash);
}

/** Bounded, best-effort confirmation poll — a timeout or transient RPC hiccup is never shown as a failure (the transaction already broadcast successfully; the explorer link, when there is one, is always there as a fallback way to check). Solana reports 'confirmed'/'finalized' as success states; EVM only ever reports 'finalized' (see getEvmTransactionStatus) — checking both covers either chain with no branching needed here. */
async function pollConfirmation(networkKey, hash) {
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(2000);
    const note = document.getElementById('confirmingNote');
    if (!note) return; // user navigated away from the result screen
    try {
      const status = await sendInternal('FLUXIO_INTERNAL_TRANSFER_STATUS', { networkKey, hash });
      if (status.status === 'confirmed' || status.status === 'finalized') {
        note.textContent = 'Confirmed ✓';
        return;
      }
      if (status.err) {
        note.textContent = 'Transaction failed on chain. Check the explorer for details.';
        return;
      }
    } catch {
      // Transient RPC hiccup while polling — not fatal, just keep trying.
    }
  }
  const note = document.getElementById('confirmingNote');
  if (note) note.textContent = 'Still confirming. Check the explorer for the latest status.';
}

// ---- Swap flow (prompt 0115 quotes; prompt 0200 real execution — Solana mainnet only) ----

function getSwapSlippageBps() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SWAP_SLIPPAGE_STORAGE_KEY], (result) => {
      const stored = result?.[SWAP_SLIPPAGE_STORAGE_KEY];
      resolve(Number.isInteger(stored) && stored >= SWAP_MIN_SLIPPAGE_BPS && stored <= SWAP_MAX_SLIPPAGE_BPS ? stored : SWAP_DEFAULT_SLIPPAGE_BPS);
    });
  });
}

function setSwapSlippageBps(bps) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SWAP_SLIPPAGE_STORAGE_KEY]: bps }, () => resolve());
  });
}

/** Step 0: pick a network — Jupiter is Solana-mainnet-only (see swapService.js), so this exists purely to route a non-Solana pick to the "not available" notice below; there is no other "current network" concept anywhere in this popup to hang that check off of (see NATIVE_NETWORKS/DEV_NETWORKS's own comment). */
function renderSwapNetworkPicker(wallet, visibleNetworks) {
  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Swap</h1>
      <p class="desc">Choose a network.</p>
      <div class="network-picker">
        ${visibleNetworks
          .map(
            (n) => `
          <button class="secondary" id="swap-pick-${n.key}">
            <img class="network-picker__logo" src="${chainLogoSrc(n.key)}" alt="" />
            <span>${escapeHtml(n.label)}${badgeMarkup(n.key)}</span>
          </button>`
          )
          .join('')}
      </div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => renderWalletReady(wallet));
  visibleNetworks.forEach((n) => {
    document.getElementById(`swap-pick-${n.key}`).addEventListener('click', () => {
      if (n.key === 'solana') {
        renderSwapScreen(wallet);
      } else if (isEvmSwapNetworkKey(n.key)) {
        // Prompt 0219 tahap A opened 'bnb'; 0227 (0225 K1) routes every
        // EVM_SWAP_NETWORK_KEYS member into the SAME screen — the key
        // rides inside the screen state.
        renderSwapScreen(wallet, { networkKey: n.key });
      } else {
        renderSwapUnavailable(wallet, n.key, visibleNetworks);
      }
    });
  });
}

/** Shown for any picked network other than plain 'solana' (mainnet) — including solana-devnet/solana-local, which are Solana-family but still not what Jupiter serves (it only ever routes real mainnet liquidity). Prompt 0200 fase 2: the Solana-family testnets get the clearer "mainnet only" copy, since "Solana only" would read as a contradiction on a Solana devnet. */
function renderSwapUnavailable(wallet, networkKey, visibleNetworks) {
  const label = networkLabel(networkKey);
  const isSolanaFamily = networkKey.startsWith('solana');
  const notice = isSolanaFamily
    ? `Swap is available on mainnet only. ${escapeHtml(label)}${badgeMarkup(networkKey)} isn't supported.`
    : `Swap is available on Solana, Ethereum, BNB Chain and Base. ${escapeHtml(label)}${badgeMarkup(networkKey)} isn't supported.`;
  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Swap</h1>
      <p class="desc">${notice}</p>
      <button class="primary" id="switchToSolana">Switch to Solana</button>
      <button class="secondary" id="cancelBtn">Cancel</button>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => renderSwapNetworkPicker(wallet, visibleNetworks));
  document.getElementById('switchToSolana').addEventListener('click', () => renderSwapScreen(wallet));
  document.getElementById('cancelBtn').addEventListener('click', () => renderWalletReady(wallet));
}

/**
 * The main Swap screen: "You pay" (native SOL + every held SPL token) /
 * "You receive" (Jupiter's verified-tag list only — no paste-a-mint-
 * address path yet, an explicit scope cut) with a flip button between
 * them, an amount input with MAX, an auto-refreshing quote panel, and a
 * slippage control. `state` carries the previous selection back across a
 * re-render (returning from Review, or after an inline unlock) — same
 * `prefill` pattern the Send flow already uses.
 */
async function renderSwapScreen(wallet, state = {}) {
  // Prompt 0219: the SAME screen serves Solana (default, unchanged) and
  // BNB Chain quotes — the key rides inside `state` so every existing
  // re-render path (flip, pickers, unlock, Back from Review) carries it
  // without new plumbing.
  const networkKey = normalizeSwapNetworkKey(state.networkKey);
  const isEvm = isEvmSwapNetworkKey(networkKey);
  state = { ...state, networkKey };

  app.innerHTML = `<div class="screen"><h1>Swap</h1><div class="loading">Loading assets…</div></div>`;

  // Three independent fetches, settled (not Promise.all'd) — a
  // getTokenAccountsByOwner failure on the mainnet RPC endpoint (real,
  // confirmed live — see tokenService.js's own KNOWN ISSUE comment and
  // prompt 0116's report) must never take the whole Swap screen down: a
  // quote never needed a held-token balance in the first place. Native
  // balance and the verified token list ARE load-bearing (see
  // resolveSwapAssetSources' own header comment for why) — a failure in
  // either one still shows the full-screen error/unlock-prompt this
  // screen always has.
  const [nativeSettled, tokenSettled, verifiedSettled] = await Promise.allSettled([
    sendInternal('FLUXIO_INTERNAL_GET_BALANCE', { networkKey }),
    sendInternal('FLUXIO_INTERNAL_GET_TOKEN_BALANCES', { networkKey }),
    sendInternal('FLUXIO_INTERNAL_GET_SWAP_TOKENS', { networkKey })
  ]);
  const resolved = resolveSwapAssetSources({ nativeSettled, tokenSettled, verifiedSettled });

  if (resolved.fatal) {
    const error = resolved.error;
    if (isLockedError(error)) {
      renderUnlockPrompt((freshWallet) => renderSwapScreen(freshWallet, state), { onCancel: () => main() });
      return;
    }
    app.innerHTML = `
      <div class="screen">
        <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
        <h1>Swap</h1>
        <div class="error">${escapeHtml(error.message || 'Could not load swap data.')}</div>
      </div>
    `;
    document.getElementById('backBtn').addEventListener('click', () => renderWalletReady(wallet));
    return;
  }

  const { nativeBalance, nativeSymbol, tokens, verifiedTokens, tokenBalancesDegraded, tokenBalancesError } = resolved;

  const payAssets = [
    isEvm
      ? { type: 'native', address: 'native', symbol: nativeSymbol, decimals: 18, balance: nativeBalance }
      : { type: 'native', address: SWAP_NATIVE_SOL_MINT, symbol: nativeSymbol, decimals: 9, balance: nativeBalance },
    ...tokens.map((t) => ({ type: 'token', address: t.address, symbol: t.symbol, decimals: t.decimals, balance: t.amountFormatted }))
  ];
  // Never trust a stale balance carried over in `state` across a
  // re-render — re-resolve the CURRENT pay asset against the fresh
  // fetch above. Prompt 0206 (owner rancangan b): a pay asset that is
  // NOT held anymore renders as itself with balance 0 (MAX disabled,
  // Review disabled, a short note) instead of silently falling back to
  // SOL — the old fallback was exactly why Switch direction felt dead.
  const foundPay = state.payAsset && payAssets.find((a) => a.type === state.payAsset.type && a.address === state.payAsset.address);
  const payAsset =
    foundPay ||
    (state.payAsset
      ? { type: state.payAsset.type, address: state.payAsset.address, symbol: state.payAsset.symbol, decimals: state.payAsset.decimals, balance: '0', held: false }
      : payAssets[0]);
  const payHeld = payAsset.held !== false;
  const receiveAsset = state.receiveAsset || null;
  const slippageBps = state.slippageBps ?? (await getSwapSlippageBps());

  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>Swap</h1>
      <p class="desc">${escapeHtml(networkLabel(networkKey))}</p>

      <div class="swap-box">
        <div class="swap-box__header"><span>You pay</span><span class="swap-box__balance">${escapeHtml(trimAmount(payAsset.balance))} ${escapeHtml(payAsset.symbol)}</span></div>
        <div class="swap-box__row">
          <input type="text" id="payAmountInput" placeholder="0.00" value="${escapeHtml(state.amount || '')}" autocomplete="off" inputmode="decimal" />
          <button class="swap-asset-btn" id="payAssetBtn" type="button">${tokenLogoMarkup(payAsset.address, payAsset.symbol, { native: payAsset.type === 'native', networkKey })}${escapeHtml(payAsset.symbol)} ${ICONS.chevronDown}</button>
          <button class="link" id="payMaxBtn" type="button" ${payHeld ? '' : 'disabled'}>MAX</button>
        </div>
        ${payHeld ? '' : '<p class="swap-box__note">You do not hold this token yet</p>'}
        ${
          tokenBalancesDegraded
            ? `<p class="swap-box__note">Token balances unavailable. You can still swap from ${escapeHtml(nativeSymbol)}. (${escapeHtml(tokenBalancesError)})</p>`
            : ''
        }
      </div>

      <button class="swap-flip-btn" id="flipBtn" type="button" title="Switch direction" aria-label="Switch direction" ${receiveAsset ? '' : 'disabled'}>${ICONS.swap}</button>
      ${receiveAsset ? '' : '<p class="swap-box__note swap-flip-hint">Pick a receive token first</p>'}

      <div class="swap-box">
        <div class="swap-box__header"><span>You receive</span></div>
        <div class="swap-box__row">
          <div class="swap-box__estimate" id="receiveEstimate">${receiveAsset ? '0.00' : '—'}</div>
          <button class="swap-asset-btn" id="receiveAssetBtn" type="button">${receiveAsset ? `${tokenLogoMarkup(receiveAsset.address, receiveAsset.symbol, { networkKey })}${escapeHtml(receiveAsset.symbol)}` : 'Select token'} ${ICONS.chevronDown}</button>
        </div>
      </div>

      <div class="swap-quote-panel" id="quotePanel"></div>

      <div class="swap-settings-row">
        <button class="link" id="slippageBtn" type="button">${ICONS.settings} Slippage: ${trimAmount(String(slippageBps / 100))}%</button>
      </div>
      ${isEvm ? '<p class="desc">Fluxio fee 0.85% included</p>' : ''}
      <div class="swap-slippage-panel" id="slippagePanel" hidden>
        ${SWAP_SLIPPAGE_PRESETS_BPS.map(
          (bps) => `<button class="secondary swap-slippage-preset${bps === slippageBps ? ' swap-slippage-preset--active' : ''}" data-bps="${bps}" type="button">${bps / 100}%</button>`
        ).join('')}
        <div class="swap-slippage-custom">
          <input type="text" id="customSlippageInput" placeholder="Custom %" autocomplete="off" inputmode="decimal" />
          <button class="secondary" id="customSlippageApply" type="button">Set</button>
        </div>
      </div>

      <div class="error" id="swapError"></div>
      <button class="primary" id="reviewBtn" disabled>Review Swap</button>
      <p class="swap-box__note" id="swapBalanceNote" hidden>Not enough balance for this swap.</p>
      <p class="swap-box__note" id="feeAccountNote" hidden>This pair is temporarily unavailable. Please try again later.</p>
    </div>
  `;

  const payAmountInput = document.getElementById('payAmountInput');
  const receiveEstimate = document.getElementById('receiveEstimate');
  const quotePanel = document.getElementById('quotePanel');
  const swapError = document.getElementById('swapError');
  const reviewBtn = document.getElementById('reviewBtn');
  const feeAccountNote = document.getElementById('feeAccountNote');
  const slippagePanel = document.getElementById('slippagePanel');

  // Mutable current-selection state, threaded through re-renders of THIS
  // screen instance via the closures below (picking an asset re-invokes
  // renderSwapScreen with an updated `state`, so this local copy only
  // ever needs to last until the next such call).
  let currentSlippageBps = slippageBps;
  let currentReceive = receiveAsset;
  let lastQuote = null;
  let lastQuoteAt = 0; // when lastQuote was minted — Review's own expiry countdown starts from this
  let refreshIntervalId = null;
  let quoteRequestSeq = 0;

  function stopAutoRefresh() {
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
      refreshIntervalId = null;
    }
  }
  function startAutoRefresh() {
    stopAutoRefresh();
    refreshIntervalId = setInterval(fetchQuote, SWAP_QUOTE_REFRESH_MS);
  }
  function leaveScreen(next) {
    stopAutoRefresh();
    next();
  }

  document.getElementById('backBtn').addEventListener('click', () => leaveScreen(() => renderWalletReady(wallet)));

  async function fetchQuote() {
    const amountText = payAmountInput.value.trim();
    if (!amountText || !currentReceive || !(Number(amountText) > 0)) {
      quotePanel.innerHTML = '';
      receiveEstimate.textContent = currentReceive ? '0.00' : '—';
      feeAccountNote.hidden = true;
      const idleBalanceNote = document.getElementById('swapBalanceNote');
      if (idleBalanceNote) idleBalanceNote.hidden = true;
      reviewBtn.disabled = true;
      return;
    }
    const mySeq = ++quoteRequestSeq;
    quotePanel.innerHTML = '<div class="loading">Fetching quote…</div>';
    try {
      const result = await sendInternal('FLUXIO_INTERNAL_GET_SWAP_QUOTE', {
        networkKey,
        inputMint: payAsset.address,
        outputMint: currentReceive.address,
        amount: amountText,
        inputDecimals: payAsset.decimals,
        outputDecimals: currentReceive.decimals,
        slippageBps: currentSlippageBps,
        // Display names for the eventual Activity entry (prompt 0200) —
        // cached alongside the quote in background.js, same trust note as
        // the decimals params above.
        inputSymbol: payAsset.symbol,
        outputSymbol: currentReceive.symbol
      });
      if (mySeq !== quoteRequestSeq) return; // superseded by a newer request — drop this stale response
      if (result && result.code === 'SWAP_FEE_ACCOUNT_UNAVAILABLE') {
        // Fee-account guard refusal (prompt 0209, owner decision 3):
        // the background answered WITHOUT quoting Jupiter. The note
        // under the Review button carries the message; Review stays
        // disabled, MAX stays usable, and the 15s refresh keeps running
        // so recovery is picked up on its own.
        lastQuote = null;
        quotePanel.innerHTML = '';
        receiveEstimate.textContent = currentReceive ? '0.00' : '—';
        swapError.textContent = '';
        feeAccountNote.hidden = false;
        reviewBtn.disabled = true;
        return;
      }
      feeAccountNote.hidden = true;
      lastQuote = result;
      lastQuoteAt = Date.now();
      receiveEstimate.textContent = trimAmount(result.outAmountFormatted);
      quotePanel.innerHTML = `
        <div class="confirm-row"><span>Rate</span><span>1 ${escapeHtml(payAsset.symbol)} ≈ ${escapeHtml(trimAmount(rateOf(result, payAsset)))} ${escapeHtml(currentReceive.symbol)}</span></div>
        <div class="confirm-row"><span>Minimum received</span><span>${escapeHtml(trimAmount(result.minReceivedFormatted))} ${escapeHtml(currentReceive.symbol)}</span></div>
        <div class="confirm-row"><span>Price impact</span><span>${escapeHtml(formatPriceImpact(result.priceImpactPct))}</span></div>
      `;
      swapError.textContent = '';
      // A quote for an unheld pay asset is still shown (informational —
      // the user just flipped into it), but Review stays disabled: there
      // is nothing to actually pay with (prompt 0206 butir 1).
      // Balance gate (prompt 0220 keputusan 4 / opsi D1, BOTH chains at
      // this one point — 0219 Revisi 1 proved neither had one): a token
      // pay needs amount <= balance; a native pay also reserves the
      // displayed max fee (Solana: the static base + priority cap the
      // Review row promises; EVM: the static reserve constant above).
      const nativeFeeMaxRaw = isEvm
        ? evmSwapReserves(networkKey).native
        : BigInt(SWAP_BASE_FEE_LAMPORTS + SWAP_PRIORITY_FEE_CAP_LAMPORTS);
      // Tahap C (owner K3): an EVM token pay must ALSO hold the BNB that
      // its approve + swap legs will burn as gas — checked here against
      // the doubled static reserve; Solana token pays keep the pre-0223
      // behavior (no native-side params), per the keputusan's own scope.
      const isEvmTokenPay = isEvm && payAsset.type !== 'native';
      const sufficient = hasSufficientPayBalance({
        isNativePay: payAsset.type === 'native',
        amount: amountText,
        balance: payAsset.balance,
        decimals: payAsset.decimals,
        feeMaxRaw: nativeFeeMaxRaw,
        nativeBalance: isEvmTokenPay ? nativeBalance : undefined,
        nativeDecimals: isEvmTokenPay ? 18 : undefined,
        nativeFeeNeededRaw: isEvmTokenPay ? evmSwapReserves(networkKey).tokenIn : undefined
      });
      const balanceNote = document.getElementById('swapBalanceNote');
      if (balanceNote) balanceNote.hidden = !payHeld || sufficient;
      reviewBtn.disabled = !payHeld || !sufficient;
    } catch (error) {
      if (mySeq !== quoteRequestSeq) return;
      if (isLockedError(error)) {
        leaveScreen(() =>
          renderUnlockPrompt(
            (freshWallet) =>
              renderSwapScreen(freshWallet, { networkKey, payAsset, receiveAsset: currentReceive, amount: amountText, slippageBps: currentSlippageBps }),
            { onCancel: () => main() }
          )
        );
        return;
      }
      quotePanel.innerHTML = '';
      receiveEstimate.textContent = '—';
      feeAccountNote.hidden = true;
      swapError.textContent = error.message || 'Could not fetch a quote.';
      reviewBtn.disabled = true;
    }
  }

  function scheduleQuote() {
    reviewBtn.disabled = true;
    fetchQuote();
    startAutoRefresh();
  }

  payAmountInput.addEventListener('input', scheduleQuote);

  document.getElementById('payMaxBtn').addEventListener('click', () => {
    if (payAsset.type === 'native' && !isEvm) {
      // Reserve = wrap rent + base fee + priority headroom — see
      // swapNativeMaxReserveLamports()'s own comment for the formula.
      const reserveSol = swapNativeMaxReserveLamports() / 1_000_000_000;
      const maxNative = Math.max(0, Number(payAsset.balance) - reserveSol);
      payAmountInput.value = maxNative > 0 ? String(maxNative) : '0';
    } else if (payAsset.type === 'native' && isEvm) {
      // Tahap B (prompt 0220): EVM native MAX now reserves the same
      // static fee ceiling the Review gate uses — exact BigInt string
      // math, never floats (the 0214 stripTrailingZeros rule still
      // applies: only trailing zeros ever disappear).
      const balanceRaw = decimalToRaw(payAsset.balance, payAsset.decimals) ?? 0n;
      const reserveWei = evmSwapReserves(networkKey).native;
      const maxRaw = balanceRaw > reserveWei ? balanceRaw - reserveWei : 0n;
      payAmountInput.value = rawToDecimal(maxRaw, payAsset.decimals);
    } else {
      // Tokens never reserve for gas (paid in native).
      payAmountInput.value = stripTrailingZeros(payAsset.balance);
    }
    scheduleQuote();
  });

  document.getElementById('flipBtn').addEventListener('click', () => {
    if (!currentReceive) return; // button is disabled in this state; guard kept as a safety net
    // Flipping a "Solana" (native SOL) receive selection into the pay
    // side must land on the REAL native entry, not a synthetic 0-balance
    // token row: the verified receive list carries SOL as the wrapped
    // mint address, and payAssets' native entry matches that address only
    // with type 'native' (prompt 0206 butir 1).
    const flippedType = currentReceive.address === SWAP_NATIVE_SOL_MINT || (isEvm && currentReceive.address === 'native') ? 'native' : 'token';
    leaveScreen(() =>
      renderSwapScreen(wallet, {
        networkKey,
        payAsset: { type: flippedType, address: currentReceive.address, symbol: currentReceive.symbol, decimals: currentReceive.decimals },
        receiveAsset: { type: payAsset.type, address: payAsset.address, symbol: payAsset.symbol, decimals: payAsset.decimals },
        amount: '',
        slippageBps: currentSlippageBps
      })
    );
  });

  document.getElementById('payAssetBtn').addEventListener('click', () => {
    // Full current state (not just the asset being picked) is threaded
    // through so the picker's own Back button can restore everything —
    // amount/receiveAsset/slippage — rather than silently dropping
    // whatever was already typed/selected.
    const fullState = { networkKey, payAsset, receiveAsset: currentReceive, amount: payAmountInput.value, slippageBps: currentSlippageBps };
    leaveScreen(() => renderSwapPayPicker(wallet, payAssets, fullState, (picked) => renderSwapScreen(wallet, { ...fullState, payAsset: picked })));
  });

  document.getElementById('receiveAssetBtn').addEventListener('click', () => {
    const fullState = { networkKey, payAsset, receiveAsset: currentReceive, amount: payAmountInput.value, slippageBps: currentSlippageBps };
    leaveScreen(() =>
      renderSwapReceivePicker(wallet, verifiedTokens, fullState, (picked) => renderSwapScreen(wallet, { ...fullState, receiveAsset: picked }))
    );
  });

  const slippageBtn = document.getElementById('slippageBtn');
  slippageBtn.addEventListener('click', () => {
    slippagePanel.hidden = !slippagePanel.hidden;
  });
  slippagePanel.querySelectorAll('.swap-slippage-preset').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const bps = Number(btn.dataset.bps);
      currentSlippageBps = bps;
      await setSwapSlippageBps(bps);
      slippageBtn.innerHTML = `${ICONS.settings} Slippage: ${trimAmount(String(bps / 100))}%`;
      slippagePanel.hidden = true;
      slippagePanel.querySelectorAll('.swap-slippage-preset').forEach((b) => b.classList.toggle('swap-slippage-preset--active', b === btn));
      scheduleQuote();
    });
  });
  document.getElementById('customSlippageApply').addEventListener('click', async () => {
    const input = document.getElementById('customSlippageInput');
    const pct = Number(input.value.trim());
    if (!Number.isFinite(pct) || pct <= 0 || pct > SWAP_MAX_SLIPPAGE_BPS / 100) {
      swapError.textContent = 'Enter a slippage percentage between 0.01% and 50%.';
      return;
    }
    const bps = Math.round(pct * 100);
    currentSlippageBps = bps;
    await setSwapSlippageBps(bps);
    slippageBtn.innerHTML = `${ICONS.settings} Slippage: ${trimAmount(String(bps / 100))}%`;
    slippagePanel.hidden = true;
    slippagePanel.querySelectorAll('.swap-slippage-preset').forEach((b) => b.classList.remove('swap-slippage-preset--active'));
    swapError.textContent = '';
    scheduleQuote();
  });

  reviewBtn.addEventListener('click', () => {
    if (!lastQuote || !currentReceive) return;
    leaveScreen(() =>
      renderSwapReview(wallet, {
        networkKey,
        payAsset,
        receiveAsset: currentReceive,
        amount: payAmountInput.value.trim(),
        slippageBps: currentSlippageBps,
        quote: lastQuote,
        quotedAt: lastQuoteAt
      })
    );
  });

  // Kick off an initial quote only if a receive asset AND amount already
  // carried over from a prior render (e.g. Back from Review) — otherwise
  // there's nothing to quote yet, and the panel/estimate above already
  // render their empty state.
  if (currentReceive && payAmountInput.value.trim()) {
    scheduleQuote();
  }
}

/** "1 <pay symbol> ≈ N <receive symbol>" — computed from the two ALREADY-formatted decimal strings background.js returned (never raw BigInt math here, popup.js can't do that), so this is plain floating-point display arithmetic — acceptable here since it only ever feeds a human-readable rate label, never an amount that gets sent anywhere. */
function rateOf(quoteResult, payAsset) {
  const inAmount = Number(quoteResult.inAmountFormatted);
  const outAmount = Number(quoteResult.outAmountFormatted);
  if (!(inAmount > 0)) return '0';
  return String(outAmount / inAmount);
}

/**
 * "You pay" asset picker — native SOL + every held SPL token, same data/
 * markup pattern as renderSendAssetPicker (Send flow), scoped to Solana
 * only. `fullState` is the CALLER's entire current selection (asset,
 * amount, slippage, ...), not just the asset being picked — Back needs
 * to restore all of it, not just fall back to whichever asset was active.
 */
function renderSwapPayPicker(wallet, payAssets, fullState, onPick) {
  const currentAsset = fullState.payAsset;
  // 0223 Revisi 2: the native row's chain logo follows the ACTIVE network
  // (BNB on BNB Chain, SOL on Solana) — this call site predates 0219 and
  // never passed networkKey, so tokenLogoMarkup's 'solana' default put
  // the Solana logo on the BNB row (the receive picker and the main swap
  // screen always passed it; only this list missed it).
  const pickerNetworkKey = normalizeSwapNetworkKey(fullState.networkKey);
  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>You pay</h1>
      <p class="desc">Choose an asset you hold.</p>
      <div class="network-picker">
        ${payAssets
          .map((a, idx) => {
            const active = a.type === currentAsset.type && a.address === currentAsset.address ? ' network-picker--active' : '';
            return `
          <button class="secondary${active}" id="pay-asset-${idx}">
            ${tokenLogoMarkup(a.address, a.symbol, { native: a.type === 'native', networkKey: pickerNetworkKey })}
            <span>${escapeHtml(a.symbol)}</span>
            <span class="network-picker__balance">${escapeHtml(trimAmount(a.balance))}</span>
          </button>`;
          })
          .join('')}
      </div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => renderSwapScreen(wallet, fullState));
  payAssets.forEach((a, idx) => {
    document.getElementById(`pay-asset-${idx}`).addEventListener('click', () => onPick(a));
  });
}

/**
 * "You receive" asset picker — Jupiter's verified-tag token list ONLY
 * (no paste-a-mint-address path this phase, an explicit scope cut). The
 * list can be several thousand entries (see swapService.js's own header
 * comment for a real observed count), so nothing is rendered until at
 * least 2 characters are typed, and results are capped — an unfiltered
 * few-thousand-row render would be a real popup-performance problem, not
 * a hypothetical one. `fullState` is the caller's entire current
 * selection (see renderSwapPayPicker's own comment for why Back needs
 * the whole thing, not just the asset being picked).
 */
function renderSwapReceivePicker(wallet, verifiedTokens, fullState, onPick) {
  const MAX_RESULTS = 30;
  const currentAsset = fullState.receiveAsset;
  // Prompt 0219: on BNB Chain the list is tiny (native + registry +
  // custom, keputusan 0218) — shown in full with no 2-character search
  // gate; Solana keeps the verified-list search exactly as before.
  const pickerNetworkKey = normalizeSwapNetworkKey(fullState.networkKey);
  const isEvmPicker = isEvmSwapNetworkKey(pickerNetworkKey);
  app.innerHTML = `
    <div class="screen">
      <div class="back-row"><button class="back-btn" id="backBtn">${ICONS.back}<span>Back</span></button></div>
      <h1>You receive</h1>
      <p class="desc">${isEvmPicker ? `Tokens on ${networkLabel(pickerNetworkKey)}.` : 'Jupiter-verified tokens only.'}</p>
      <input type="text" id="tokenSearchInput" placeholder="Search by symbol or name…" autocomplete="off" spellcheck="false" />
      <div class="network-picker" id="tokenResults"></div>
    </div>
  `;
  document.getElementById('backBtn').addEventListener('click', () => renderSwapScreen(wallet, fullState));

  const searchInput = document.getElementById('tokenSearchInput');
  const results = document.getElementById('tokenResults');

  function renderResults() {
    const query = searchInput.value.trim().toLowerCase();
    if (!isEvmPicker && query.length < 2) {
      results.innerHTML = '<p class="desc">Type at least 2 characters to search.</p>';
      return;
    }
    const matches = (query.length
      ? verifiedTokens.filter((t) => t.symbol?.toLowerCase().includes(query) || t.name?.toLowerCase().includes(query))
      : verifiedTokens
    ).slice(0, MAX_RESULTS);
    if (!matches.length) {
      results.innerHTML = '<p class="desc">No verified tokens match.</p>';
      return;
    }
    results.innerHTML = matches
      .map((t, idx) => {
        const active = currentAsset && t.address === currentAsset.address ? ' network-picker--active' : '';
        return `
        <button class="secondary${active}" id="receive-token-${idx}">
          ${tokenLogoMarkup(t.address, t.symbol, { networkKey: pickerNetworkKey })}
          <span>${escapeHtml(t.symbol)} <span class="network-picker__hint">${t.name ? `· ${escapeHtml(t.name)}` : ''}</span></span>
        </button>`;
      })
      .join('');
    matches.forEach((t, idx) => {
      document.getElementById(`receive-token-${idx}`).addEventListener('click', () => onPick(t));
    });
  }

  searchInput.addEventListener('input', renderResults);
  renderResults();
}

// How long a background-minted quoteId stays executable — mirrors
// background.js's own SWAP_QUOTE_TTL_MS (the background is the enforcer;
// this copy only drives the Review screen's "Refresh quote" morph so the
// user is told BEFORE hitting the server-side SWAP_QUOTE_EXPIRED).
const SWAP_QUOTE_UI_TTL_MS = 60_000;

/** Maps an EXECUTE_SWAP/SWAP_STATUS error message (code embedded in the text — see background.js) to the sentence the Failed screen shows. */
function swapErrorDisplayMessage(raw) {
  const text = String(raw || '');
  const rest = text.replace(/^(?:EVM_)?SWAP_[A-Z_]+:\s*/, '');
  // Every EVM_SWAP_* message is already written as honest user-facing
  // copy server-side (tahap B, prompt 0220) — show it minus the code.
  if (/EVM_SWAP_[A-Z_]+:/.test(text)) return rest;
  if (text.includes('SWAP_QUOTE_EXPIRED')) return 'Your quote expired before the swap was submitted. Refresh the quote and try again.';
  if (text.includes('SWAP_SIMULATION_FAILED')) return rest; // already readable, slippage (0x1771) called out by background.js
  if (text.includes('SWAP_BLOCKHASH_EXPIRED')) return 'The network did not include the swap in time (blockhash expired). No funds moved. Try again.';
  if (text.includes('SWAP_FEE_ACCOUNT_UNAVAILABLE')) return 'The swap was not started because this pair is temporarily unavailable. Please try again later.'; // prompt 0209 guard — a "No funds moved" class, nothing was signed
  if (text.includes('SWAP_SEND_FAILED')) return `The swap could not be broadcast: ${rest}`;
  if (text.includes('SWAP_NETWORK_UNSUPPORTED')) return 'Swap is available on mainnet only.';
  if (text.includes('SWAP_EXECUTION_DISABLED')) return 'Swap execution is not enabled in this build.';
  return text || 'The swap failed.';
}

/**
 * Review/confirm screen — real execution as of prompt 0200 fase 2.
 * Amount + fee rows in TWO different currencies stay SEPARATE rows, never
 * summed (prompt 0113's rule). "You receive (est.)" is Jupiter's own
 * outAmount, which for ExactIn is ALREADY NET of the platform fee (owner
 * note on 0199's live evidence) — so the "Fluxio fee (0.85%)" row is
 * informational only, marked "included", never subtracted again, and its
 * amount is formatted on the fee SIDE's own decimals/symbol (feeSide,
 * phase 1). "Network fee (max)" is a HARD CEILING (prompt 0206 butir 5):
 * base 5000 + the 150000-lamport priority cap every build request now
 * carries (see SWAP_PRIORITY_FEE_CAP_LAMPORTS) — shown statically with
 * no "~", because the real fee can never exceed it (swapService rejects
 * an above-cap build pre-sign). This replaced 0200's "~real preview
 * number" display after the 0205 real-money round showed the previewed
 * prioritization routinely differing from the executed one (two separate
 * builds, market moves between them). If the quote's TTL lapses while
 * the user sits here, Confirm morphs into "Refresh quote" instead of
 * failing server-side.
 */
function renderSwapReview(wallet, details) {
  const { payAsset, receiveAsset, amount, slippageBps, quote, quotedAt, reviewNote } = details;
  // Prompt 0219 tahap A: the SAME Review serves BNB Chain quotes, with
  // Confirm permanently disabled (execution is tahap B) — see the isEvm
  // branches below for exactly what differs from the Solana rows.
  const reviewNetworkKey = normalizeSwapNetworkKey(details.networkKey);
  const isEvm = isEvmSwapNetworkKey(reviewNetworkKey);
  const feeSymbol = quote.feeSide === 'input' ? payAsset.symbol : receiveAsset.symbol;

  app.innerHTML = `
    <div class="screen">
      <h1>Review Swap</h1>
      <p class="desc">${escapeHtml(networkLabel(reviewNetworkKey))}</p>
      ${reviewNote ? `<p class="desc">${escapeHtml(reviewNote)}</p>` : ''}

      <div class="confirm-row"><span>You pay</span><span>${escapeHtml(trimAmount(amount, payAsset.decimals))} ${escapeHtml(payAsset.symbol)}</span></div>
      <div class="confirm-row"><span>You receive (est.)</span><span>${escapeHtml(trimAmount(quote.outAmountFormatted, receiveAsset.decimals))} ${escapeHtml(receiveAsset.symbol)}</span></div>
      <div class="confirm-row"><span>Rate</span><span>1 ${escapeHtml(payAsset.symbol)} ≈ ${escapeHtml(trimAmount(rateOf(quote, payAsset)))} ${escapeHtml(receiveAsset.symbol)}</span></div>
      <div class="confirm-row"><span>Slippage</span><span>${trimAmount(String(slippageBps / 100))}%</span></div>
      <div class="confirm-row"><span>${isEvm ? 'Minimum received (est.)' : 'Minimum received'}</span><span>${escapeHtml(trimAmount(quote.minReceivedFormatted))} ${escapeHtml(receiveAsset.symbol)}</span></div>
      ${
        isEvm
          ? `<div class="confirm-row"><span>Max network fee</span><span id="evmSwapFeeValue">…</span></div>`
          : `<div class="confirm-row"><span>Network fee (max)</span><span>${trimAmount(String((SWAP_BASE_FEE_LAMPORTS + SWAP_PRIORITY_FEE_CAP_LAMPORTS) / 1_000_000_000), 9)} SOL</span></div>`
      }
      ${
        // 0242 (catatan 23, keputusan pemilik Opsi 2: margin x2 TETAP,
        // kosmetik saja): plafon token masuk memakai stand-in gas quote x2
        // (simulasi mustahil sebelum approve mendarat), jadi angkanya kerap
        // 2 sampai 3 kali fee nyata — satu kalimat kecil menjelaskannya,
        // HANYA untuk token masuk (plafon native masuk dari estimateGas
        // nyata sejak 0227 Revisi 1, tidak butuh keterangan ini).
        isEvm && payAsset.address !== 'native'
          ? `<p class="desc">This is an upper limit. The actual fee is usually much lower.</p>`
          : ''
      }
      <div id="rentRowSlot"></div>
      ${
        isEvm
          ? `<div class="confirm-row confirm-row--total"><span>Fluxio fee (0.85%)</span><span>${escapeHtml(trimAmount(quote.feeAmountFormatted ?? '0', 18))} ${escapeHtml(payAsset.symbol)} (included)</span></div>`
          : quote.feeIncluded
            ? `<div class="confirm-row confirm-row--total"><span>Fluxio fee (0.85%)</span><span>${escapeHtml(trimAmount(quote.feeAmountFormatted))} ${escapeHtml(feeSymbol)} (included)</span></div>`
            : ''
      }

      <p class="desc" id="twoTxNote" hidden>This swap sends two transactions: an approval and the swap.</p>
      <div class="error" id="swapReviewNote"></div>
      <button class="primary" id="confirmSwapBtn" ${isEvm && payAsset.address !== 'native' && receiveAsset.address !== 'native' ? 'disabled' : ''}>Confirm Swap</button>
      <button class="secondary" id="backBtn">Back</button>
    </div>
  `;

  const confirmBtn = document.getElementById('confirmSwapBtn');
  const note = document.getElementById('swapReviewNote');
  // Tahap C (prompt 0223, owner K5): token-in to NATIVE out executes for
  // real now (an approve leg first when the allowance needs it); only
  // token to token keeps the disabled Confirm and the honest note.
  const isEvmTokenIn = isEvm && payAsset.address !== 'native';
  const isEvmTokenToToken = isEvmTokenIn && receiveAsset.address !== 'native';
  if (isEvmTokenToToken) {
    note.textContent = 'Swapping a token to another token is coming soon.';
  }
  // 0241 Opsi A (akar insiden 22 Oktober, catatan 22): Confirm must never
  // leave before THIS render's PREVIEW has written the fee ceilings onto
  // the cached quote — the incident executed a quote whose preview had not
  // landed, so the picker signed an unbounded fee (pre-P1) while the
  // screen showed a STALE number written by an older render's late
  // preview response. Two guards close both halves: (1) the Confirm
  // button is held disabled until this render's preview succeeds, with a
  // matching non-silent guard inside the click handler (the 0223 Revisi 2
  // rule: no silent exit); (2) swapReviewRenderEpoch marks each render,
  // and a preview response whose epoch is no longer current writes
  // NOTHING — a late response from an old quote can never overwrite the
  // new render's number or re-enable its button. The 0231 fail closed
  // gate in the background stays as the safety net behind all of this.
  swapReviewRenderEpoch += 1;
  const renderEpoch = swapReviewRenderEpoch;
  let evmPreviewReady = !isEvm;
  let evmPreviewFailed = false;
  if (isEvm && !isEvmTokenToToken) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Estimating network fee…';
  }

  let quoteExpired = false;
  let expiryTimerId = null;
  function markQuoteExpired() {
    quoteExpired = true;
    confirmBtn.textContent = 'Refresh quote';
    note.textContent = 'This quote has expired. Refresh to get a current price.';
  }
  if (!isEvm) {
    const remainingMs = Math.max(0, SWAP_QUOTE_UI_TTL_MS - (Date.now() - (quotedAt || 0)));
    if (remainingMs === 0) {
      markQuoteExpired();
    } else {
      expiryTimerId = setTimeout(markQuoteExpired, remainingMs);
    }
  }
  function leaveReview(next) {
    if (expiryTimerId) clearTimeout(expiryTimerId);
    next();
  }

  // The "Network fee (max)" row above is STATIC (prompt 0206 butir 5) —
  // base + priority cap, a hard ceiling the build request itself enforces
  // — so this preview call no longer feeds the fee display. It still
  // matters for three things: the rent row below, the live rent figure
  // and last real priority fee behind the MAX reserve, and catching an
  // already-expired quote early. Prompt 0205: the response says whether
  // THIS swap will create a new token account for the output (rent
  // charged permanently, on top of the network fee — the real incident:
  // a first swap into a token silently cost ~0.0015 SOL more than Review
  // showed). Fail SAFE per owner decision: any failure shows the row as
  // "may apply" rather than silently dropping it; a hardcoded rent
  // number is never shown.
  const rentSlot = document.getElementById('rentRowSlot');
  // Plain confirm-row, NOT confirm-row--total (prompt 0205 Revisi 2,
  // owner's visual call): the rent is a network cost in SOL like the
  // "Network fee" row right above it — same gray label, same bottom
  // separator, not bold — so only "Fluxio fee (0.85%)" stays the single
  // bold row. (The Send screen's own rent row is untouched.)
  function renderRentRow(text) {
    rentSlot.innerHTML = `<div class="confirm-row"><span>New token account rent</span><span>${escapeHtml(text)}</span></div>`;
  }
  (async () => {
    // EVM branch (prompt 0219): the preview only fills the "Max network
    // fee" value (gasEstimate × 1,2 × maxFeePerGas, the 0213 Send math)
    // — no build, no rent concept, no priority-fee feedback. Full
    // 18-decimal-capable trim, same reasoning as the Send screen.
    if (isEvm) {
      try {
        const preview = await sendInternal('FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.quoteId });
        // 0241 Opsi A: a response landing after a NEWER Review render
        // belongs to an old quote — it writes nothing and enables nothing
        // (the incident's displayed number was exactly such a stale write).
        if (renderEpoch !== swapReviewRenderEpoch) return;
        const el = document.getElementById('evmSwapFeeValue');
        // Token-in (tahap C, owner K3): the preview's total already SUMS
        // the approve ceiling (live estimateGas x1,2) and the swap ceiling
        // (quote gas x1,5) — one combined "Max network fee" row.
        if (el) el.textContent = `${trimAmount(preview.maxFeeFormatted, 18)} ${preview.nativeSymbol}`;
        // K5: the transaction-count sentence shows ONLY when an approve
        // is actually needed (a live allowance already covering the
        // amount makes this a plain one-transaction swap). 0227 (0225
        // K8): a partial allowance adds the reset leg, so the sentence
        // then names all three transactions.
        if (preview.tokenIn && preview.approveNeeded) {
          const twoTx = document.getElementById('twoTxNote');
          if (twoTx) {
            if (preview.approveResetNeeded) {
              twoTx.textContent = 'This swap sends three transactions: a reset, an approval and the swap.';
            }
            twoTx.hidden = false;
          }
        }
        // 0241 Opsi A: only now has THIS quote's ceiling reached the
        // cached entry — Confirm may go (token to token stays blocked).
        evmPreviewReady = true;
        if (!isEvmTokenToToken) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Confirm Swap';
        }
      } catch {
        if (renderEpoch !== swapReviewRenderEpoch) return;
        evmPreviewFailed = true;
        const el = document.getElementById('evmSwapFeeValue');
        if (el) el.textContent = 'unavailable';
        // 0241 Opsi A: no ceiling ever reached the entry — Confirm stays
        // held (executing now would only bounce off the 0231 fail closed
        // gate, or worse on a pre-P1 build). Short, dash free sentence.
        note.textContent = 'Fee estimate failed. Go back and try again.';
        confirmBtn.textContent = 'Confirm Swap';
      }
      return;
    }
    try {
      const preview = await sendInternal('FLUXIO_INTERNAL_PREVIEW_SWAP_FEES', { quoteId: quote.quoteId });
      lastSwapPriorityFeeLamports = preview.prioritizationFeeLamports || 0;
      if (preview.tokenAccountRentLamports) {
        lastTokenAccountRentLamports = Number(preview.tokenAccountRentLamports) || 0; // feeds the MAX reserve's live figure
      }
      const rent = preview.newTokenAccountRent;
      if (rent && rent.status === 'none') {
        rentSlot.innerHTML = ''; // provably no new account — no row
      } else if (rent && rent.status === 'required' && rent.rentSolFormatted) {
        // Full 9-decimal precision, mirroring the Send confirm screen's
        // own "New account rent" row — the default 6-decimal trim would
        // silently understate 0.00148844 as 0.001488.
        renderRentRow(`${rent.approx ? '~' : ''}${trimAmount(rent.rentSolFormatted, 9)} SOL`);
      } else {
        renderRentRow('may apply'); // 'unknown', or amount unavailable
      }
    } catch (error) {
      if (String(error.message || '').includes('SWAP_QUOTE_EXPIRED')) {
        markQuoteExpired();
      }
      renderRentRow('may apply');
    }
  })();

  document.getElementById('backBtn').addEventListener('click', () =>
    leaveReview(() => renderSwapScreen(wallet, { networkKey: reviewNetworkKey, payAsset, receiveAsset, amount, slippageBps }))
  );

  confirmBtn.addEventListener('click', () => {
    // 0223 Revisi 2 rule: NO silent exit on the Confirm path — every way
    // out of this handler puts text on screen. The real incident: the
    // tahap B belt here still read `isEvmTokenIn` and returned SILENTLY,
    // so a token-in Confirm did nothing at all (no spinner, no error, no
    // console line) while the button looked active — and the source-text
    // test could never catch a dead button (lesson recorded in the 0223
    // archive). Only token to token stays blocked, and it SAYS so.
    if (isEvmTokenToToken) {
      note.textContent = 'Swapping a token to another token is coming soon.';
      return;
    }
    // 0241 Opsi A: the handler mirror of the disabled button — a real DOM
    // never fires a disabled button, but the guard must live HERE too (the
    // 0223 lesson: the click path itself is what gets tested). Non silent:
    // the note says exactly why nothing happened.
    if (isEvm && !evmPreviewReady) {
      note.textContent = evmPreviewFailed ? 'Fee estimate failed. Go back and try again.' : 'Estimating network fee…';
      return;
    }
    if (quoteExpired) {
      // Back to the swap screen with everything preserved — its own
      // initial-quote kickoff re-quotes immediately.
      leaveReview(() => renderSwapScreen(wallet, { networkKey: reviewNetworkKey, payAsset, receiveAsset, amount, slippageBps }));
      return;
    }
    leaveReview(() => beginSwapExecution(wallet, { ...details, networkKey: reviewNetworkKey }));
  });
}

/** Confirm pressed: neutral progress screen while EXECUTE_SWAP runs, then Swapped or Failed. Serves Solana and (tahap B) BNB Chain native-in alike — the network rides inside `details`. */
async function beginSwapExecution(wallet, details) {
  const execNetworkKey = normalizeSwapNetworkKey(details.networkKey);
  const execNetworkLabel = networkLabel(execNetworkKey);
  app.innerHTML = `
    <div class="screen">
      <h1>Swapping…</h1>
      <p class="desc">${escapeHtml(execNetworkLabel)}</p>
      <div class="loading">Submitting your swap…</div>
      <p class="desc">This usually takes a few seconds. Keep this window open.</p>
    </div>
  `;
  try {
    const result = await sendInternal('FLUXIO_INTERNAL_EXECUTE_SWAP', {
      quoteId: details.quote.quoteId,
      networkKey: execNetworkKey
    });
    // Prompt 0205 Revisi 4 — EXECUTE_SWAP re-quotes at Confirm. Two
    // structured non-error outcomes come back instead of a signature:
    if (result.quoteChanged) {
      // The fresh quote dropped more than 0.1% below what Review showed:
      // nothing was signed; the old quoteId is dead; re-render Review
      // with the NEW cached quote (rent + network fee re-fetch via
      // PREVIEW as on any Review entry) and a neutral note.
      renderSwapReview(wallet, {
        networkKey: execNetworkKey,
        payAsset: details.payAsset,
        receiveAsset: details.receiveAsset,
        amount: details.amount,
        slippageBps: details.slippageBps,
        quote: result.quote,
        quotedAt: Date.now(),
        // g2's own code (0223 Revisi 3 tambahan): the fee ceiling rose —
        // the amounts may be identical, so the note names the FEE. The
        // re-entered Review fetches a fresh PREVIEW, so the new ceiling
        // is exactly what the row then shows.
        reviewNote:
          result.code === 'EVM_SWAP_FEE_ABOVE_DISPLAYED'
            ? 'Network fee is now higher than shown. Review the new fee.'
            : 'Quote updated. Review the new amounts.'
      });
      return;
    }
    if (result.requoteFailed) {
      // The fresh quote could not be fetched: nothing was signed and the
      // displayed quote is still alive — back to Review to try again.
      renderSwapReview(wallet, { ...details, reviewNote: 'Could not refresh the quote. Try again.' });
      return;
    }
    if (result.stage === 'approve' || result.stage === 'approveReset') {
      // Tahap C (prompt 0223): the approve leg is broadcast; the swap leg
      // is signed by the background once the approve confirms — the
      // staged progress screen follows the state from there. 0227 (0225
      // K8): a reset leg in front arrives as stage 'approveReset' and the
      // same screen shows it as step 1 of 3.
      renderSwapTwoStepProgress(wallet, details, result);
      return;
    }
    if (result.prioritizationFeeLamports) {
      lastSwapPriorityFeeLamports = result.prioritizationFeeLamports;
    }
    renderSwapBroadcasting(wallet, details, result);
  } catch (error) {
    if (isLockedError(error)) {
      renderUnlockPrompt((freshWallet) => renderSwapScreen(freshWallet, {
        networkKey: execNetworkKey,
        payAsset: details.payAsset,
        receiveAsset: details.receiveAsset,
        amount: details.amount,
        slippageBps: details.slippageBps
      }), { onCancel: () => main() });
      return;
    }
    renderSwapFailed(wallet, details, error);
  }
}

/**
 * Two-step progress screen (tahap C, prompt 0223 — owner K2/K5): shown
 * when EXECUTE_SWAP broadcast an APPROVE leg and the background will sign
 * the swap leg itself once the approve receipt is 0x1. Drives itself off
 * GET_ACTIVE_SWAP's staged state: stage 'approve' keeps step 1 on screen
 * (the GET_ACTIVE_SWAP call doubling as the loop's resume nudge), stage
 * 'swap' hands over to the normal broadcasting screen labeled step 2, and
 * a 'halted' record maps to its own honest sentence. Hiding this screen
 * never stops anything — the legs live entirely in the background.
 */
function renderSwapTwoStepProgress(wallet, details, result) {
  const { payAsset } = details;
  const progressNetworkKey = normalizeSwapNetworkKey(details.networkKey);
  // 0227 (0225 K8): a reset leg in front makes this a THREE step flow —
  // known from the EXECUTE result here, and re-derived from the staged
  // state's own resetHash on every tick (a reopened popup has no result).
  let hasReset = result.stage === 'approveReset' || result.threeStep === true;
  const initialStep = hasReset ? 'Step 1 of 3: Reset approval' : `Step 1 of 2: Approve ${payAsset.symbol}`;
  const initialStatus = hasReset ? 'Waiting for the reset to confirm…' : 'Waiting for the approval to confirm…';
  app.innerHTML = `
    <div class="screen">
      <h1>Swapping…</h1>
      <p class="desc">${escapeHtml(networkLabel(progressNetworkKey))}</p>
      <p class="desc" id="swapStepValue">${escapeHtml(initialStep)}</p>
      <div class="loading" id="swapStepStatus">${escapeHtml(initialStatus)}</div>
      <p class="desc" id="swapStepNote" hidden>Your approval is taking longer than usual. It may still confirm. Check again in a moment.</p>
      <p class="desc">The swap continues in the background once the approval confirms. You can hide this screen.</p>
      <button class="secondary" id="hideBtn">Hide</button>
    </div>
  `;
  const stepValue = document.getElementById('swapStepValue');
  const stepStatus = document.getElementById('swapStepStatus');
  const stepNote = document.getElementById('swapStepNote');
  let stopped = false;
  let timerId = null;
  let lastSwapSig = null;
  let lastExplorer = null;
  const startedMs = Date.now();
  // Owner K5 sentences, one per terminal reason — each money-honest for
  // its own class (an approve failing on chain moved no tokens, only its
  // network fee; every "not sent" class signed nothing further).
  function haltText(reason) {
    if (reason === 'APPROVE_FAILED') {
      return `The approval failed on chain. Your ${payAsset.symbol} was not moved. Only the network fee was charged.`;
    }
    if (reason === 'APPROVE_RESET_FAILED') {
      return `The approval reset failed on chain. Your ${payAsset.symbol} was not moved. Only the network fee was charged.`;
    }
    if (reason === 'APPROVE_NOT_SENT') {
      return 'The approval was not sent. Start again from the Swap screen.';
    }
    if (reason === 'APPROVE_PENDING_TIMEOUT') {
      return 'Your approval is taking longer than usual. It may still confirm. The swap was not sent. Start again from the Swap screen once the approval confirms.';
    }
    if (reason === 'SWAP_QUOTE_CHANGED_AFTER_APPROVE') {
      return 'Quote changed after the approval. No swap was sent. Start again from the Swap screen.';
    }
    if (reason === 'EVM_SWAP_FEE_ABOVE_DISPLAYED') {
      return 'Network fee is now higher than shown. No swap was sent. Start again from the Swap screen.';
    }
    if (reason === 'STATE_GONE') {
      return 'The swap continued in the background. Check Activity for the result.';
    }
    return 'Approval confirmed. Swap not sent. Start again from the Swap screen.';
  }
  function renderHalted(reason) {
    app.innerHTML = `
      <div class="screen">
        <h1>Swap stopped</h1>
        <p class="desc">${escapeHtml(networkLabel(progressNetworkKey))}</p>
        <p class="desc">${escapeHtml(haltText(reason))}</p>
        <button class="primary" id="backToSwapBtn">Back to Swap</button>
        <button class="secondary" id="doneBtn">Done</button>
      </div>
    `;
    document.getElementById('backToSwapBtn').addEventListener('click', () =>
      renderSwapScreen(wallet, {
        networkKey: progressNetworkKey,
        payAsset: details.payAsset,
        receiveAsset: details.receiveAsset,
        amount: details.amount,
        slippageBps: details.slippageBps
      })
    );
    document.getElementById('doneBtn').addEventListener('click', () => renderWalletReady(wallet));
  }
  async function tick() {
    try {
      const active = await sendInternal('FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
      if (stopped) return;
      if (active.active && active.resetHash) hasReset = true;
      if (active.active && active.stage === 'approveReset') {
        stepValue.textContent = 'Step 1 of 3: Reset approval';
        stepStatus.textContent = `Waiting for the reset to confirm… retry ${active.attempts || 0}`;
        if (Date.now() - startedMs >= 60000) stepNote.hidden = false;
      } else if (active.active && active.stage === 'approve') {
        stepValue.textContent = hasReset ? `Step 2 of 3: Approve ${payAsset.symbol}` : `Step 1 of 2: Approve ${payAsset.symbol}`;
        stepStatus.textContent = `Waiting for the approval to confirm… retry ${active.attempts || 0}`;
        if (Date.now() - startedMs >= 60000) stepNote.hidden = false;
      } else if (active.active && active.stage === 'swap') {
        lastSwapSig = active.signature;
        lastExplorer = active.explorerUrl;
        renderSwapBroadcasting(wallet, details, { signature: active.signature, explorerUrl: active.explorerUrl }, { stepNote: hasReset ? 'Step 3 of 3: Swap' : 'Step 2 of 2: Swap' });
        return;
      } else if (active.active && active.stage === 'halted') {
        renderHalted(active.haltReason);
        return;
      } else if (!active.active) {
        // The background finished and cleared the state between polls —
        // when the swap hash was seen, the Swapped screen's own poll takes
        // over; otherwise Activity holds the ground truth.
        if (lastSwapSig) {
          renderSwapSuccess(wallet, details, { signature: lastSwapSig, explorerUrl: lastExplorer });
          return;
        }
        renderHalted('STATE_GONE');
        return;
      }
    } catch {
      // Transient messaging hiccup — keep ticking quietly.
    }
    if (!stopped) timerId = setTimeout(tick, 2000);
  }
  tick();
  document.getElementById('hideBtn').addEventListener('click', () => {
    stopped = true;
    if (timerId) clearTimeout(timerId);
    renderWalletReady(wallet);
  });
}

/**
 * Broadcast-in-progress screen (prompt 0203 Revisi 1) — shown right
 * after EXECUTE_SWAP returns, WHILE the background's re-broadcast loop
 * keeps re-sending the same signed bytes (see background.js's
 * runSwapRebroadcastLoop — born from a real mainnet incident where a
 * single broadcast was silently dropped and never landed). Polls
 * SWAP_STATUS for the verdict and GET_ACTIVE_SWAP for the retry counter;
 * the GET_ACTIVE_SWAP call each tick doubles as the loop's popup-side
 * resume nudge if the service worker restarted mid-swap. Hide only
 * hides this screen — the loop lives in the background and is entirely
 * unaffected; the verdict then lands on the Activity entry via the
 * background's own sweep/piggyback.
 */
function renderSwapBroadcasting(wallet, details, result, { stepNote } = {}) {
  const bcastNetworkKey = normalizeSwapNetworkKey(details.networkKey);
  app.innerHTML = `
    <div class="screen">
      <h1>Swapping…</h1>
      <p class="desc">${escapeHtml(networkLabel(bcastNetworkKey))}</p>
      ${stepNote ? `<p class="desc">${escapeHtml(stepNote)}</p>` : ''}
      <div class="loading" id="swapSendingValue">Sending… retry 0</div>
      <p class="desc">The swap is sent again every few seconds until the network includes it. You can hide this screen. Sending continues in the background.</p>
      <button class="secondary" id="hideBtn">Hide</button>
    </div>
  `;
  const sendingValue = document.getElementById('swapSendingValue');
  let uiTimerId = null;
  let stopped = false;
  async function tick() {
    try {
      const status = await sendInternal('FLUXIO_INTERNAL_SWAP_STATUS', {
        signature: result.signature,
        lastValidBlockHeight: result.lastValidBlockHeight,
        networkKey: bcastNetworkKey
      });
      if (stopped) return;
      if (status.expired) {
        renderSwapFailed(wallet, details, new Error('SWAP_BLOCKHASH_EXPIRED: The network did not include the swap in time.'));
        return;
      }
      if (status.err) {
        renderSwapFailed(wallet, details, new Error('The swap failed on chain.'), { onChainFailure: true });
        return;
      }
      if (status.status === 'confirmed' || status.status === 'finalized') {
        renderSwapSuccess(wallet, details, result);
        return;
      }
      const active = await sendInternal('FLUXIO_INTERNAL_GET_ACTIVE_SWAP');
      if (stopped) return;
      if (active.active) {
        sendingValue.textContent = `Sending… retry ${active.attempts}`;
      } else {
        // The ~60s re-broadcast window closed without a verdict (the
        // blockhash can outlive it slightly) — fall through to the
        // Swapped screen, whose own poll keeps watching until the
        // definitive confirmed/expired verdict arrives.
        renderSwapSuccess(wallet, details, result);
        return;
      }
    } catch {
      // Transient messaging/RPC hiccup — keep ticking quietly.
    }
    if (!stopped) uiTimerId = setTimeout(tick, 2000);
  }
  tick();
  document.getElementById('hideBtn').addEventListener('click', () => {
    stopped = true;
    if (uiTimerId) clearTimeout(uiTimerId);
    // Hide ONLY: the background re-broadcast loop is untouched, and the
    // Activity entry still gets its verdict from the background sweep.
    renderWalletReady(wallet);
  });
}

/**
 * Swapped — the broadcast succeeded. The status line then advances live
 * via FLUXIO_INTERNAL_SWAP_STATUS (which also gives the DEFINITIVE
 * blockhash-expired verdict a plain send poll can't), reusing the same
 * poll-until-final pattern as the Send result screen. "You received" is
 * the quote's own estimate (net of any platform fee — see renderSwapReview)
 * until confirmation; the exact settled amount lives on the explorer.
 */
function renderSwapSuccess(wallet, details, result) {
  const { payAsset, receiveAsset, amount, quote } = details;
  const successNetworkKey = normalizeSwapNetworkKey(details.networkKey);
  app.innerHTML = `
    <div class="screen">
      <h1>Swapped</h1>
      <p class="desc">${escapeHtml(networkLabel(successNetworkKey))}</p>

      <div class="confirm-row"><span>You paid</span><span>${escapeHtml(trimAmount(amount, payAsset.decimals))} ${escapeHtml(payAsset.symbol)}</span></div>
      <div class="confirm-row"><span id="receivedLabel">You received (est.)</span><span id="receivedValue">${escapeHtml(trimAmount(quote.outAmountFormatted, receiveAsset.decimals))} ${escapeHtml(receiveAsset.symbol)}</span></div>
      <div class="confirm-row"><span>Status</span><span id="swapStatusValue">Pending confirmation…</span></div>

      <p class="desc" id="pendingNote" hidden>Your swap is taking longer than usual. It may still confirm. Check again in a moment.</p>
      <button class="secondary" id="checkAgainBtn" hidden>Check again</button>
      ${result.explorerUrl ? `<a class="secondary swap-explorer-link" id="explorerLink" href="${escapeHtml(result.explorerUrl)}" target="_blank" rel="noopener noreferrer">View on explorer</a>` : ''}
      <button class="primary" id="doneBtn">Done</button>
    </div>
  `;

  const statusValue = document.getElementById('swapStatusValue');
  const receivedLabel = document.getElementById('receivedLabel');
  const receivedValue = document.getElementById('receivedValue');
  const pendingNote = document.getElementById('pendingNote');
  const checkAgainBtn = document.getElementById('checkAgainBtn');
  let pollTimerId = null;
  let stopped = false;
  let realAmountRetries = 0; // prompt 0205: after Confirmed, keep polling briefly for the REAL received amount
  // Honest-pending window (tahap B, owner keputusan B1/C1): an EVM tx has
  // no expiry — past 10 minutes without a receipt the auto-poll stops and
  // the screen says so honestly, with a manual Check again (never a
  // failure verdict; the tx can still land).
  const pendingSinceMs = Date.now();
  const EVM_PENDING_UI_WINDOW_MS = 600000;
  async function pollOnce() {
    try {
      const status = await sendInternal('FLUXIO_INTERNAL_SWAP_STATUS', {
        signature: result.signature,
        lastValidBlockHeight: result.lastValidBlockHeight,
        networkKey: successNetworkKey
      });
      if (stopped) return;
      if (status.expired) {
        statusValue.textContent = 'Failed, not included in time';
        return;
      }
      if (status.err) {
        statusValue.textContent = 'Failed on chain';
        return;
      }
      if (status.status === 'confirmed' || status.status === 'finalized') {
        statusValue.textContent = 'Confirmed';
        pendingNote.hidden = true;
        checkAgainBtn.hidden = true;
        // Prompt 0205: swap the estimate for the chain's real number the
        // moment the background has parsed it; until then the label
        // honestly stays "(est.)" and a few more polls give it a chance.
        if (status.receivedRealFormatted) {
          receivedLabel.textContent = 'You received';
          receivedValue.textContent = `${trimAmount(status.receivedRealFormatted, receiveAsset.decimals)} ${receiveAsset.symbol}`;
          return;
        }
        if (realAmountRetries++ < 5) {
          pollTimerId = setTimeout(pollOnce, 3000);
        }
        return;
      }
      if (isEvmSwapNetworkKey(successNetworkKey) && Date.now() - pendingSinceMs >= EVM_PENDING_UI_WINDOW_MS) {
        statusValue.textContent = 'Still pending';
        pendingNote.hidden = false;
        checkAgainBtn.hidden = false;
        return; // manual Check again from here — no auto-poll
      }
      pollTimerId = setTimeout(pollOnce, 3000);
    } catch {
      if (!stopped) pollTimerId = setTimeout(pollOnce, 5000); // transient RPC hiccup — keep trying quietly
    }
  }
  checkAgainBtn.addEventListener('click', () => {
    statusValue.textContent = 'Checking…';
    pollOnce();
  });
  pollOnce();

  document.getElementById('doneBtn').addEventListener('click', () => {
    stopped = true;
    if (pollTimerId) clearTimeout(pollTimerId);
    renderWalletReady(wallet);
  });
}

/**
 * Failed — the mapped reason plus a Try again that goes back to a FRESH
 * quote (never replays the old one; quoteIds are single-use server-side
 * anyway). Per-class honesty about money (prompt 0205 Revisi 4, audited
 * class by class against the code paths):
 *  - onChainFailure: the transaction LANDED and failed — atomically
 *    reverted, so the swap moved nothing but the network fee WAS charged
 *    (live-proven by 4bTgMW5…: −105,000 lamports, zero token delta) →
 *    the exact owner-approved sentence below.
 *  - default ("No funds moved"): every pre-inclusion class — quote
 *    expired/changed (nothing built), simulation failed (never signed),
 *    build/identity/broadcast rejection (never accepted by the network),
 *    blockhash expired (never included) — genuinely charges NOTHING.
 *  - fundsMayHaveMoved: the cautious middle kept for any future caller
 *    that genuinely cannot tell; deliberately NOT the on-chain sentence
 *    (it must never claim a fee was charged without evidence).
 */
function renderSwapFailed(wallet, details, error, { fundsMayHaveMoved = false, onChainFailure = false } = {}) {
  const { payAsset, receiveAsset, amount, slippageBps } = details;
  const failedNetworkKey = normalizeSwapNetworkKey(details.networkKey);
  const moneyLine = onChainFailure
    ? 'Your funds were not swapped. Only the network fee was charged. You can try again with a fresh quote.'
    : fundsMayHaveMoved
      ? 'Check the explorer for details. You can try again with a fresh quote.'
      : 'No funds moved. You can try again with a fresh quote.';
  app.innerHTML = `
    <div class="screen">
      <h1>Swap failed</h1>
      <p class="desc">${escapeHtml(networkLabel(failedNetworkKey))}</p>
      <div class="error">${escapeHtml(swapErrorDisplayMessage(error.message))}</div>
      <p class="desc">${moneyLine}</p>
      <button class="primary" id="tryAgainBtn">Try again</button>
      <button class="secondary" id="cancelBtn">Back to wallet</button>
    </div>
  `;
  document.getElementById('tryAgainBtn').addEventListener('click', () =>
    renderSwapScreen(wallet, { networkKey: failedNetworkKey, payAsset, receiveAsset, amount, slippageBps })
  );
  document.getElementById('cancelBtn').addEventListener('click', () => renderWalletReady(wallet));
}

// Test-only seam (0223 Revisi 2) — the same __FLUXIO_TEST_* convention
// background.js already uses: a vitest harness sets the flag BEFORE
// importing this module to reach render functions directly, so the
// Confirm CLICK PATH itself is testable (the real incident: a silent
// return left the button dead and no source-text test could see it).
// The real popup page never sets the flag, and nothing on a webpage can
// reach this document's globalThis — in production this block is inert.
if (globalThis.__FLUXIO_POPUP_TEST_HOOKS__) {
  globalThis.__FLUXIO_POPUP_HOOKS__ = { renderSwapReview, renderSwapPayPicker, beginSwapExecution, renderSendConfirm };
}

main();
