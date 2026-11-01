import React from 'react';
import { Link } from 'react-router-dom';
import MarketingNav from '../../components/MarketingNav.jsx';
import MarketingFooter from '../../components/MarketingFooter.jsx';
import PrivacyDataFlow from '../../components/PrivacyDataFlow.jsx';
import Icon from '../../components/Icon.jsx';

/**
 * Privacy Policy (prompt 0122) — a real, static content page for the
 * extension's Chrome Web Store listing, not a marketing section. Reuses
 * the marketing site's chrome (MarketingNav/MarketingFooter, the .mkt-page
 * dark theme) for visual consistency, but its own content is plain,
 * readable text with no animation/motion — see .privacy-page in
 * design.css.
 *
 * Every factual claim below was verified directly against this repo's
 * own source before being written (encryption params, storage keys,
 * outbound network calls, manifest.json permissions) — see this
 * feature's own prompt archive entry (prompt/0122-privacy-policy-page.md)
 * for the full fact-to-source audit table. This file should never be
 * hand-edited to add a claim that hasn't been verified the same way —
 * update the source behavior first, then this page, not the other way
 * around.
 *
 * Revision 1 (visual pass, same prompt archive entry): the original
 * version was "semua teks" per the user's own feedback — this pass adds
 * a data-flow diagram (PrivacyDataFlow.jsx, right after "The short
 * version," illustrating exactly the same claims the surrounding text
 * makes, never a new one) and a small consistent outline &lt;Icon&gt; next
 * to every section heading below. The POLICY WORDING ITSELF is
 * byte-for-byte unchanged from the original version — every &lt;p&gt;/&lt;li&gt;
 * string below is identical to before this revision; only headings
 * (which gained an inline icon) and the new diagram section were
 * touched.
 *
 * prompt 0207: dash sweep on the visible policy text (the owner's public
 * text rule — no em dashes and no "-" inside sentences): every em-dash
 * entity became a sentence break, comma, colon, or parentheses, and plain
 * English hyphenated words lost their hyphens. NO factual claim was
 * added, removed, or reworded beyond that punctuation change; technical
 * standard names (AES-256-GCM, PBKDF2-HMAC-SHA256) keep their hyphens by
 * the owner's own decision (they read as code, not prose).
 *
 * prompt 0123: added an explicit "Back to home" link above the H1 — the
 * page had no way back to "/" besides the navbar's own logo link, which
 * user testing found too easy to miss. MarketingNav's logo already links
 * to "/" (unchanged), this is a second, more obvious way back.
 */
export default function Privacy() {
  return (
    <div className="mkt-page">
      <MarketingNav />

      <main className="privacy-page">
        <div className="privacy-page__inner">
          <Link to="/" className="privacy-page__back">&larr; Back to home</Link>

          <h1>Privacy Policy</h1>
          <p className="privacy-page__updated">Effective: August 20, 2026</p>

          <p className="privacy-page__lead">
            Fluxio Wallet (&ldquo;Fluxio,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) is a non custodial cryptocurrency wallet
            browser extension for Solana, Ethereum, BNB Chain, and Base. This page explains, in plain
            language, what happens to your data when you use it.
          </p>

          <h2><Icon name="zap" className="privacy-page__h-icon" /> The short version</h2>
          <p>
            Your recovery phrase and private keys are generated and encrypted entirely on your device.
            We never see them, and we have no way to recover them if you lose your password. The
            extension talks to your chosen blockchain&rsquo;s public network (to check balances and send
            transactions), to a couple of public pricing/quoting services, and periodically to our own
            backend to check for announcements. That&rsquo;s it. There&rsquo;s no Fluxio account, no cookies,
            no third party trackers, and (as of this version) no analytics calls from the
            extension at all.
          </p>

          <PrivacyDataFlow />

          <h2><Icon name="wallet" className="privacy-page__h-icon" /> What we store on your device</h2>
          <p>
            Everything below lives in your browser&rsquo;s own storage for this extension
            (<code>chrome.storage</code>), never on a Fluxio server:
          </p>
          <ul>
            <li>
              <strong>Your encrypted wallet vault.</strong> Your recovery phrase is sealed with
              AES-256-GCM authenticated encryption, using a key derived from your password via
              PBKDF2-HMAC-SHA256 with 600,000 iterations, a fresh random salt and nonce every time you
              create or change it. A wrong password or a tampered file fails to decrypt. It doesn&rsquo;t
              silently return garbage.
            </li>
            <li>
              <strong>A short lived unlocked session</strong>, kept only in memory only browser
              storage that&rsquo;s cleared automatically the moment the browser fully closes. It&rsquo;s never
              written to disk.
            </li>
            <li>
              <strong>Preferences</strong>: your chosen auto lock timer, display currency, whether
              testnets are shown, swap slippage tolerance, and whether the account card shows its
              accent artwork. None of these are sensitive.
            </li>
            <li>
              <strong>Custom token list</strong>: for any token you&rsquo;ve added manually, we store its
              address, symbol, name, and decimals, never a balance (balances are always fetched
              fresh from the network when needed).
            </li>
            <li>
              <strong>Local transaction history</strong>: a record of transactions sent from this
              browser profile (network, addresses, amount, status, timestamp), kept only to populate
              your own Activity screen, capped at the most recent 50 per network. This never leaves
              your device, and it disappears if you clear extension data or reinstall.
            </li>
          </ul>

          <h2><Icon name="lock" className="privacy-page__h-icon" /> What never leaves your device</h2>
          <p>
            Your recovery phrase and private keys are never transmitted anywhere, not even to us.
            Signing happens locally: when a transaction needs a signature, your key is derived in
            memory just long enough to sign it, then discarded. Only the already signed transaction
            (or, for a network read, your public address) is ever sent out, never the key that
            produced it.
          </p>

          <h2><Icon name="globe" className="privacy-page__h-icon" /> Network connections this extension makes</h2>
          <ul>
            <li>
              <strong>Blockchain RPC nodes</strong> (one per network you use: Solana, Ethereum, BNB
              Chain, Base, and their testnets). We send your public wallet address to read a balance,
              or an already signed transaction to broadcast it. This is how every blockchain wallet
              works. The RPC operator can see which public addresses are active from your
              connection, the same as any node operator can for any wallet.
            </li>
            <li>
              <strong>CoinGecko</strong> (<code>api.coingecko.com</code>), for price data. We send only
              the coin IDs and currency codes we need a price for (e.g. &ldquo;solana, usd-coin &rarr; usd&rdquo;),
              never your wallet address.
            </li>
            <li>
              <strong>Jupiter</strong> (<code>lite-api.jup.ag</code>), for Solana swaps. When you open
              the Swap screen and enter an amount, we request a price quote, and the quote refreshes
              automatically every 15 seconds while the screen stays open. A quote request carries only
              the two token addresses, the amount, and your slippage setting, plus our fee parameter
              when the pair includes USDC. When you open the review step, and again when you confirm,
              we ask Jupiter to build the swap transaction. That request includes your public Solana
              wallet address, because the transaction has to move funds from your account. Your private
              keys and seed phrase never leave your device. The transaction is signed locally and
              broadcast by the extension itself. On pairs that include USDC, a 0.85% Fluxio fee is
              shown before you confirm and is collected on chain into our own USDC account.
            </li>
            <li>
              <strong>KyberSwap</strong> (<code>aggregator-api.kyberswap.com</code>), for swaps on
              Ethereum, BNB Chain and Base. A quote request carries only the two token contract addresses, the amount you
              typed, and a static client label that identifies the Fluxio app itself. When you confirm
              a swap, the extension asks KyberSwap to build the transaction, and that build
              request includes your public wallet address as the sender and recipient of the swap.
              This mirrors how Solana swaps already work with Jupiter. KyberSwap never sees your seed
              phrase or private keys, and signing happens only inside the extension. When you swap
              from a token such as USDC or USDT, the extension first sends an approval transaction to the
              token contract that lets the KyberSwap router spend exactly the amount you are
              swapping, then sends the swap. Both transactions are signed inside the extension and
              appear in your Activity. The approval is never unlimited. Swaps on Ethereum, BNB Chain
              and Base carry a 0.85% Fluxio fee, taken from the amount you pay and sent to our
              treasury address inside the same transaction. It is shown before you confirm.
            </li>
            <li>
              <strong>Fluxio&rsquo;s own backend</strong>, to check for announcements, a small inbox of
              product notices you can read from the extension&rsquo;s own bell icon. This runs periodically
              in the background (roughly every 10 minutes, plus once whenever you open the extension if
              it&rsquo;s been a while), whether or not you ever open the inbox. The request carries no
              personal data, no wallet address, and no device identifier, only which platform is
              asking (the browser extension, as opposed to our web app). If this backend can&rsquo;t be
              reached, the extension quietly keeps showing whatever it last fetched; nothing about this
              is ever shown to you as an error.
            </li>
          </ul>
          <p>
            We do not run any tracking pixels, device fingerprinting, or third party advertising SDKs.
          </p>

          <h2><Icon name="eye-off" className="privacy-page__h-icon" /> Analytics</h2>
          <p>
            Fluxio&rsquo;s backend has an anonymous analytics endpoint that other parts of the Fluxio
            product may use. It can only ever record a randomly generated installation ID and which
            chains are configured, never a wallet address or personal information.{' '}
            <strong>As of this version, the browser extension does not call it.</strong> We checked the
            extension&rsquo;s own code directly to confirm this rather than assume it. There is currently
            no analytics or usage tracking call anywhere in the extension. The periodic announcements
            check described above is a separate, unrelated connection: it never sends an installation
            ID or any other identifier, and nothing about it is recorded per user or per device on our
            end. If that ever changes, this policy will be updated first.
          </p>

          <h2><Icon name="check-shield" className="privacy-page__h-icon" /> What we don&rsquo;t do</h2>
          <ul>
            <li>No account or sign up. The wallet is created and lives entirely on your device.</li>
            <li>No cookies.</li>
            <li>No third party analytics, tracking, or advertising SDKs.</li>
            <li>We never sell, rent, or share your data. We don&rsquo;t have any to sell.</li>
            <li>We can&rsquo;t recover your recovery phrase or password if you lose them. Nobody can.</li>
          </ul>

          <h2><Icon name="puzzle" className="privacy-page__h-icon" /> Permissions explained</h2>
          <p>Chrome extensions declare exactly what they can access. Here&rsquo;s what Fluxio requests and why:</p>
          <ul>
            <li><strong>storage</strong>: to keep your encrypted vault, session, and preferences on your device (see above).</li>
            <li><strong>alarms</strong>: powers three periodic, on device checks: the auto lock timer (locks your wallet after your chosen period of inactivity), the announcements check described above, and a short lived delivery check while a swap you confirmed is still being sent to the network.</li>
            <li><strong>windows</strong>: used only to open the approval popup when a website asks you to connect or sign something, so you can review and approve or reject it.</li>
            <li>
              <strong>Host permissions</strong> for <code>127.0.0.1</code> (local Solana/Ethereum test
              nodes, for development only), <code>lite-api.jup.ag</code> (swap quotes and swap transactions),{' '}
              <code>aggregator-api.kyberswap.com</code> (swap quotes and swap transactions on Ethereum, BNB Chain and Base), and{' '}
              <code>api.coingecko.com</code> (prices). Public mainnet/testnet RPC endpoints and
              Fluxio&rsquo;s own backend are contacted too (see above) but don&rsquo;t require a manifest
              permission, because they&rsquo;re designed to accept requests directly from any origin.
            </li>
          </ul>
          <p>
            We don&rsquo;t request access to your browsing history, other tabs, or any website&rsquo;s content
            beyond what&rsquo;s needed to relay a connect/sign request from a page that asks for one.
          </p>

          <h2><Icon name="clock" className="privacy-page__h-icon" /> Changes to this policy</h2>
          <p>
            If we materially change what data this extension stores or transmits, we&rsquo;ll update this
            page and the effective date above. Continued use after a change means you accept the
            update.
          </p>

          <h2><Icon name="mail" className="privacy-page__h-icon" /> Contact</h2>
          <p>
            Questions about this policy or how the extension handles your data:{' '}
            <a href="mailto:fluxio.wallet@gmail.com" className="privacy-page__contact-link">
              fluxio.wallet@gmail.com
            </a>
          </p>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
