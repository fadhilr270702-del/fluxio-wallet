import React from 'react';
import Icon from './Icon.jsx';
import solanaLogo from '../assets/vendor/images/chains/solana.png';
import ethereumLogo from '../assets/vendor/images/chains/ethereum.png';
import bnbLogo from '../assets/vendor/images/chains/bnb.png';
import baseLogo from '../assets/vendor/images/chains/base.png';

/**
 * Privacy Policy data-flow diagram — CENTRAL HUB composition (prompt 0122
 * Revision 1, layout-composition round). The prior six passes iterated on
 * one layout (a stacked device/session/action/destination grid) until the
 * user rejected the layout itself, not its details — three alternative
 * compositions were built as standalone preview mockups
 * (assets/privacy-layout-{A,B,C}.png), and the user picked Variant C:
 * Unlocked session as the crossing point of a cross/plus composition —
 * device facts to the north (boxed), actions -> destinations fanning
 * south, and the separate dApp request/approval/signed-result chain as
 * an east arm, row-aligned with the hub's own rows but NOT wired to the
 * hub directly (a real fact carried over from an earlier pass: a dApp
 * request originates externally, not from the session — the one
 * candidate line that WOULD touch the hub, Approval->Session, was
 * removed two passes ago as unfixably awkward and is deliberately not
 * reintroduced here just to complete the "hub" metaphor).
 *
 * CONTENT/FACTS/LABELS ARE UNCHANGED from the prior layout: same nodes,
 * same edges, same "Requires unlocked session" wording (see that
 * label's own history below), same Never-happens facts. Only the
 * COMPOSITION — where each node sits and how the connectors are routed
 * — is new. The aria-label below is copied verbatim for that reason.
 *
 * "Requires unlocked session" (not "uses your address"): verified
 * directly against `apps/extension/background/background.js` that only
 * Read balances and Broadcast transaction actually call
 * `walletService.getPublicWallet()` and use the resolved address as
 * data; Custom token metadata fetch, Price lookup, and Swap quote only
 * gate on `isUnlocked()` and never touch the address. The bus label
 * states the gate (true for all five, verified) rather than the
 * address-use claim (true for only two of five).
 *
 * VARIABLE CARD WIDTH: the four RPC nodes are visibly narrower
 * (COMPACT_W_PX) than every other card — needed because all three of
 * Custom token list/Broadcast transaction/Read balances converge onto
 * the SAME four RPC destinations directly below the action row's own
 * left-hand span, which is narrower than a full 108px-per-card row
 * could fit without touching. Every edge-anchor computation below
 * (`halfW`/`halfH`) is therefore per-node, not a single global
 * constant like the prior layout used — a real bug this composition's
 * own first draft hit (RPC cards overlapping) before the width was
 * narrowed and the anchor math made per-node.
 */

// ---- Design canvas: 1000 x 620 px (must stay in sync with
// .privacy-flow7__canvas's CSS height). Card widths: 108px standard,
// 52px compact (RPC nodes only, see above). Card height budget is kept
// uniform (96px) even for the visually-shorter compact/no-desc cards —
// deliberately conservative, since a taller anchor margin can only add
// extra clearance, never cause a collision. ----
const CANVAS_W_PX = 1000;
const CANVAS_H_PX = 620;
const CARD_W_PX = 108;
const CARD_H_PX = 96;
const COMPACT_W_PX = 52;
const MARGIN_X_PX = 18;
const MARGIN_Y_PX = 18;

function halfW(node) {
  return (((node.wPx || CARD_W_PX) / CANVAS_W_PX) / 2) * 100;
}
function halfH(node) {
  return (((node.hPx || CARD_H_PX) / CANVAS_H_PX) / 2) * 100;
}
const MARGIN_X = (MARGIN_X_PX / CANVAS_W_PX) * 100;
const MARGIN_Y = (MARGIN_Y_PX / CANVAS_H_PX) * 100;

// ---- Columns (x%) ----
const COL = {
  preferences: 23.64,
  vault: 40.79,
  localactivity: 57.93,
  session: 40.79, // same column as vault — the hub sits directly below it
  custom: 16.02,
  broadcast: 28.4,
  read: 40.79, // same column as vault/session
  price: 53.17,
  swap: 65.55,
  solana: 19.12,
  ethereum: 25.31,
  bnb: 31.5,
  base: 37.69,
  arm: 83.64 // dApp / dApp request / Approval popup / Signed result
};

// ---- Rows (y%) ----
const ROW = {
  device: 14.52,
  session: 33.87,
  sessionbus: 48,
  action: 59,
  mergebus: 70,
  dest: 81
};

const DEVICE_NODES = [
  { id: 'vault', x: COL.vault, y: ROW.device, icon: 'lock', title: 'Encrypted vault', desc: 'AES-256-GCM, PBKDF2 600k' },
  { id: 'preferences', x: COL.preferences, y: ROW.device, icon: 'dashboard', title: 'Preferences', desc: 'No outgoing data' },
  { id: 'activity', x: COL.localactivity, y: ROW.device, icon: 'bell', title: 'Local activity', desc: 'No outgoing data' },
  { id: 'session', x: COL.session, y: ROW.session, icon: 'zap', title: 'Unlocked session', desc: 'Memory only, cleared on close' }
];

const ACTION_NODES = [
  { id: 'customtokens', x: COL.custom, y: ROW.action, icon: 'layers', title: 'Custom token list', desc: 'Metadata fetch' },
  { id: 'broadcast', x: COL.broadcast, y: ROW.action, icon: 'arrow-right', title: 'Broadcast transaction', desc: '→ signed transaction' },
  { id: 'read', x: COL.read, y: ROW.action, icon: 'search', title: 'Read balances', desc: '→ public address' },
  { id: 'pricelookup', x: COL.price, y: ROW.action, icon: 'globe', title: 'Price lookup', desc: '→ coin IDs + currency' },
  { id: 'swapquote', x: COL.swap, y: ROW.action, icon: 'swap', title: 'Swap quote', desc: '→ token pair + amount' }
];

const DEST_NODES = [
  { id: 'solana', x: COL.solana, y: ROW.dest, kind: 'chain', logo: solanaLogo, title: 'Solana', desc: 'RPC', wPx: COMPACT_W_PX },
  { id: 'ethereum', x: COL.ethereum, y: ROW.dest, kind: 'chain', logo: ethereumLogo, title: 'Ethereum', desc: 'RPC', wPx: COMPACT_W_PX },
  { id: 'bnb', x: COL.bnb, y: ROW.dest, kind: 'chain', logo: bnbLogo, title: 'BNB', desc: 'RPC', wPx: COMPACT_W_PX },
  { id: 'base', x: COL.base, y: ROW.dest, kind: 'chain', logo: baseLogo, title: 'Base', desc: 'RPC', wPx: COMPACT_W_PX },
  { id: 'coingecko', x: COL.price, y: ROW.dest, icon: 'search', title: 'CoinGecko', desc: 'Coin IDs + currency' },
  { id: 'jupiter', x: COL.swap, y: ROW.dest, icon: 'swap', title: 'Jupiter', desc: 'Token pair + amount' }
];

// The east arm — deliberately not wired to the hub (session); it starts
// from an external site, not from anything on this device.
const DAPP_ARM = [
  { id: 'dappexternal', x: COL.arm, y: ROW.device, icon: 'globe', title: 'dApp', desc: 'External site', type: 'plain' },
  { id: 'dapprequest', x: COL.arm, y: ROW.session, icon: 'link', title: 'dApp request', desc: 'connect / sign', type: 'sent' },
  { id: 'approval', x: COL.arm, y: ROW.action, icon: 'check-shield', title: 'Approval popup', desc: 'Blocks until you decide', type: 'sent' },
  { id: 'signedresult', x: COL.arm, y: ROW.dest, icon: 'key', title: 'Signed result → dApp', desc: 'Session signs, only after you approve', type: 'sent' }
];

const NEVER_NODES = [
  { icon: 'key', title: 'Seed/keys transmitted', desc: 'No network path ever carries them' },
  { icon: 'eye-off', title: 'Analytics beacon', desc: 'Endpoint exists server side; extension never calls it' },
  { icon: 'shield', title: 'Cookies & trackers', desc: 'No document.cookie, no tracking SDK' },
  { icon: 'wallet', title: 'Account / sign up', desc: 'Just your local wallet, nothing server side' }
];

const ALL_NODES = [...DEVICE_NODES, ...ACTION_NODES, ...DEST_NODES, ...DAPP_ARM];
const NODE_BY_ID = Object.fromEntries(ALL_NODES.map((n) => [n.id, n]));

function straightEdge(fromId, toId) {
  const a = NODE_BY_ID[fromId];
  const b = NODE_BY_ID[toId];
  if (a.x === b.x) {
    const dir = b.y > a.y ? 1 : -1;
    return `M ${a.x},${a.y + dir * halfH(a)} L ${b.x},${b.y - dir * halfH(b)}`;
  }
  const dir = b.x > a.x ? 1 : -1;
  return `M ${a.x + dir * halfW(a)},${a.y} L ${b.x - dir * halfW(b)},${b.y}`;
}

/** A one-source, N-target bus: a private trunk down from the source to a
 * shared horizontal line, then one branch per target (one arrowhead
 * each). Used for the Session -> 5 action nodes bus. */
function busEdges(sourceId, targetIds, busY) {
  const src = NODE_BY_ID[sourceId];
  const targets = targetIds.map((id) => NODE_BY_ID[id]);
  const trunk = `M ${src.x},${src.y + halfH(src)} L ${src.x},${busY}`;
  const xs = targets.map((t) => t.x);
  const bus = `M ${Math.min(...xs)},${busY} L ${Math.max(...xs)},${busY}`;
  const branches = targets.map((t) => `M ${t.x},${busY} L ${t.x},${t.y - halfH(t)}`);
  return { trunk, bus, branches };
}

/** Merges several sources onto ONE shared bus/target set — used for the
 * RPC bus (Custom token list + Broadcast transaction + Read balances,
 * all landing on the same 4 RPC nodes with exactly one arrow each). */
function mergedBusEdges(sourceIds, targetIds, busY) {
  const sources = sourceIds.map((id) => NODE_BY_ID[id]);
  const targets = targetIds.map((id) => NODE_BY_ID[id]);
  const trunks = sources.map((s) => `M ${s.x},${s.y + halfH(s)} L ${s.x},${busY}`);
  const xs = [...sources.map((s) => s.x), ...targets.map((t) => t.x)];
  const bus = `M ${Math.min(...xs)},${busY} L ${Math.max(...xs)},${busY}`;
  const branches = targets.map((t) => `M ${t.x},${busY} L ${t.x},${t.y - halfH(t)}`);
  return { trunks, bus, branches };
}

function NodeCard({ node, type }) {
  const isChain = node.kind === 'chain';
  const style = { left: `${node.x}%`, top: `${node.y}%` };
  if (node.wPx) style.width = `${node.wPx}px`;
  return (
    <div className={`privacy-flow7__node privacy-flow7__node--${type}${node.wPx ? ' privacy-flow7__node--compact' : ''}`} style={style}>
      <span className={`privacy-flow7__node-icon privacy-flow7__node-icon--${type}${isChain ? ' privacy-flow7__node-icon--chain' : ''}`}>
        {isChain ? <img src={node.logo} alt="" /> : <Icon name={node.icon} />}
      </span>
      <span className="privacy-flow7__node-title">{node.title}</span>
      {node.desc && <span className="privacy-flow7__node-desc">{node.desc}</span>}
    </div>
  );
}

function DesktopGraph() {
  const sessionBus = busEdges('session', ['customtokens', 'broadcast', 'read', 'pricelookup', 'swapquote'], ROW.sessionbus);
  const rpcBus = mergedBusEdges(['customtokens', 'broadcast', 'read'], ['solana', 'ethereum', 'bnb', 'base'], ROW.mergebus);

  const arrowedEdges = [
    straightEdge('vault', 'session'),
    straightEdge('dappexternal', 'dapprequest'),
    straightEdge('dapprequest', 'approval'),
    straightEdge('approval', 'signedresult'),
    straightEdge('pricelookup', 'coingecko'),
    straightEdge('swapquote', 'jupiter'),
    ...sessionBus.branches,
    ...rpcBus.branches
  ];
  const plainEdges = [sessionBus.trunk, sessionBus.bus, ...rpcBus.trunks, rpcBus.bus];

  // Device container box — wraps Vault/Preferences/Local activity/
  // Session, the hub's north arm. Bounds computed from the actual node
  // column/row positions plus a fixed pixel margin (MARGIN_X/MARGIN_Y),
  // not hand-picked percentages.
  const vaultN = NODE_BY_ID.vault, prefN = NODE_BY_ID.preferences, actN = NODE_BY_ID.activity, sessN = NODE_BY_ID.session;
  const boxLeft = prefN.x - halfW(prefN) - MARGIN_X;
  const boxRight = actN.x + halfW(actN) + MARGIN_X;
  const boxTop = vaultN.y - halfH(vaultN) - MARGIN_Y;
  const boxBottom = sessN.y + halfH(sessN) + MARGIN_Y;

  return (
    <div className="privacy-flow7__canvas">
      <div
        className="privacy-flow7__devicebox"
        style={{ left: `${boxLeft}%`, top: `${boxTop}%`, width: `${boxRight - boxLeft}%`, height: `${boxBottom - boxTop}%` }}
      >
        <span className="privacy-flow7__devicebox-title">Stays on your device</span>
      </div>

      <svg className="privacy-flow7__svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <marker id="flowArrow7" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="rgba(255,255,255,0.6)" />
          </marker>
        </defs>
        {plainEdges.map((d, i) => (
          <path key={`p${i}`} className="privacy-flow7__edge" d={d} />
        ))}
        {arrowedEdges.map((d, i) => (
          <path key={`a${i}`} className="privacy-flow7__edge" d={d} markerEnd="url(#flowArrow7)" />
        ))}
      </svg>

      <span className="privacy-flow7__buslabel" style={{ left: `${COL.session}%`, top: `${ROW.sessionbus}%` }}>
        Requires unlocked session
      </span>

      {DEVICE_NODES.map((n) => (
        <NodeCard key={n.id} node={n} type="plain" />
      ))}
      {ACTION_NODES.map((n) => (
        <NodeCard key={n.id} node={n} type="sent" />
      ))}
      {DEST_NODES.map((n) => (
        <NodeCard key={n.id} node={n} type="sent" />
      ))}
      {DAPP_ARM.map((n) => (
        <NodeCard key={n.id} node={n} type={n.type} />
      ))}
    </div>
  );
}

/** Mobile fallback — a genuinely simpler, separate markup tree, not the
 * desktop hub shrunk. Restructured into THREE clusters (device / sent
 * out / dApp flow) matching the hub's three arms, instead of the prior
 * layout's two — the dApp arm reads as its own independent chain on
 * desktop, so it gets its own titled cluster here too rather than being
 * folded into "sent out". */
function MobileStack() {
  return (
    <div className="privacy-flow7__mobile">
      <div className="privacy-flow7__mcluster privacy-flow7__mcluster--boxed">
        <h4 className="privacy-flow7__mcluster-title">Stays on your device</h4>
        <div className="privacy-flow7__mgrid">
          {DEVICE_NODES.map((n) => (
            <div className="privacy-flow7__mnode privacy-flow7__mnode--plain" key={n.id}>
              <span className="privacy-flow7__node-icon privacy-flow7__node-icon--plain">
                <Icon name={n.icon} />
              </span>
              <span className="privacy-flow7__node-title">{n.title}</span>
              <span className="privacy-flow7__node-desc">{n.desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="privacy-flow7__mtrunk" aria-hidden="true" />

      <div className="privacy-flow7__mcluster">
        <h4 className="privacy-flow7__mcluster-title">Sent out, triggered by an action</h4>
        <div className="privacy-flow7__mgrid">
          {[...ACTION_NODES, ...DEST_NODES].map((n) => (
            <div className="privacy-flow7__mnode privacy-flow7__mnode--sent" key={n.id}>
              <span className={`privacy-flow7__node-icon privacy-flow7__node-icon--sent${n.kind === 'chain' ? ' privacy-flow7__node-icon--chain' : ''}`}>
                {n.kind === 'chain' ? <img src={n.logo} alt="" /> : <Icon name={n.icon} />}
              </span>
              <span className="privacy-flow7__node-title">{n.title}</span>
              {n.desc && <span className="privacy-flow7__node-desc">{n.desc}</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="privacy-flow7__mtrunk" aria-hidden="true" />

      <div className="privacy-flow7__mcluster">
        <h4 className="privacy-flow7__mcluster-title">dApp flow</h4>
        <div className="privacy-flow7__mgrid">
          {DAPP_ARM.map((n) => (
            <div className={`privacy-flow7__mnode privacy-flow7__mnode--${n.type}`} key={n.id}>
              <span className={`privacy-flow7__node-icon privacy-flow7__node-icon--${n.type}`}>
                <Icon name={n.icon} />
              </span>
              <span className="privacy-flow7__node-title">{n.title}</span>
              <span className="privacy-flow7__node-desc">{n.desc}</span>
            </div>
          ))}
        </div>
        <p className="privacy-flow7__mnote">
          Read balances, Broadcast transaction, Custom token metadata fetches, Price lookups, and Swap quotes all require an
          unlocked session to run at all. Only Read balances and Broadcast transaction actually use your session&rsquo;s
          address as data, the other three just need the session to exist. A dApp&rsquo;s connect/sign request comes from an
          external site, reaches your session&rsquo;s signer only after you approve it in a popup, and returns a signed result.
        </p>
      </div>
    </div>
  );
}

export default function PrivacyDataFlow() {
  return (
    <div
      className="privacy-flow7"
      role="img"
      aria-label="Data flow diagram: your encrypted vault unlocks into a memory-only session. That session must be unlocked for reading balances, broadcasting a transaction, fetching custom token metadata, looking up prices, and getting swap quotes to run at all, though only reading balances and broadcasting actually use the session's address as data. Reading a balance sends only your public address to blockchain RPC nodes; broadcasting sends only the already-signed transaction; custom token metadata fetches go through the same RPC path. Price lookups send coin IDs to CoinGecko; swap quotes send a token pair to Jupiter. A request from an external dApp only reaches your session's signer after you approve it in a popup, producing a signed result sent back to the dApp. Preferences and local activity stay on your device with no outgoing connection at all. Your seed and keys are never transmitted, there is no analytics beacon calling out from the extension, no cookies or trackers, and no account or sign-up system."
    >
      <div className="privacy-flow7__legend">
        <span className="privacy-flow7__legend-item">
          <span className="privacy-flow7__legend-swatch privacy-flow7__legend-swatch--plain" />
          Stays on device
        </span>
        <span className="privacy-flow7__legend-item">
          <span className="privacy-flow7__legend-swatch privacy-flow7__legend-swatch--sent" />
          Sent out (public data only)
        </span>
        <span className="privacy-flow7__legend-item">
          <span className="privacy-flow7__legend-swatch privacy-flow7__legend-swatch--blocked" />
          Never happens
        </span>
      </div>

      <div className="privacy-flow7__graph-wrap">
        <DesktopGraph />
        <MobileStack />
      </div>

      <div className="privacy-flow7__never">
        <h3 className="privacy-flow7__never-title">Never happens</h3>
        <div className="privacy-flow7__never-grid">
          {NEVER_NODES.map((n) => (
            <div className="privacy-flow7__node privacy-flow7__node--blocked" key={n.title}>
              <span className="privacy-flow7__severed" aria-hidden="true">
                <span className="privacy-flow7__severed-line" />
                <span className="privacy-flow7__severed-mark">&#10005;</span>
              </span>
              <span className="privacy-flow7__node-icon privacy-flow7__node-icon--blocked">
                <Icon name={n.icon} />
              </span>
              <span className="privacy-flow7__node-title">{n.title}</span>
              <span className="privacy-flow7__node-desc">{n.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
