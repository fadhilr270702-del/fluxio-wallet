# Fluxio Wallet

Fluxio is a non custodial crypto wallet for Solana, Ethereum, BNB Chain and Base, shipped as a Chrome extension (Manifest V3). Your keys stay on your device: the seed phrase is generated locally with BIP 39, encrypted with your password using AES 256 GCM and PBKDF2 (600,000 iterations) through the browser's native Web Crypto API, and it never leaves the extension.

Install from the Chrome Web Store: https://chromewebstore.google.com/detail/fluxio-wallet/cifacmbjmpncihomdjblialanmleoeak

## What the wallet does

- Send and receive the native coin on every supported network, plus SPL tokens on Solana and ERC 20 tokens on EVM networks. Fluxio adds no fee on transfers; you only pay the network fee.
- Swap inside the wallet: Jupiter routes on Solana, KyberSwap routes on Ethereum, BNB Chain and Base. Swaps carry a 0.85% Fluxio fee, shown on the review screen before you confirm.
- Multiple accounts derived from one seed, activity history, a portfolio total priced through CoinGecko, and an announcements inbox.

## Supported networks

Solana, Ethereum, BNB Chain and Base mainnets, plus Solana devnet, Ethereum Sepolia and local development nodes behind a settings toggle.

## Repository layout

- `apps/extension/` is the wallet itself. `background/background.js` is bundled with esbuild into `background/background.bundle.js`, the service worker entry in `manifest.json`; the popup, onboarding and content script pages stay plain unbundled JavaScript.
- `packages/crypto/`, `packages/services/`, `packages/constants/` and `packages/utils/` are the workspace packages behind it: key derivation and the encrypted vault, transaction construction and broadcast, the network and token registries, and amount math on pure BigInt.
- `apps/web/` is the landing site at https://fluxiowallet.com.
- `admin/` and `backend/` are an internal announcements panel and its API. They are not part of the wallet and are not needed to build it.
- Several directories are planned layout that is still empty. The sections above are where the real code lives.

## Build from source

Requirements: Node 22.5 or newer and pnpm.

```
pnpm install
pnpm build:extension
```

Then load `apps/extension/` as an unpacked extension at `chrome://extensions` with Developer mode on.

Two optional build time values can be set in `apps/extension/.env.local` (see `apps/extension/.env.example`): `HELIUS_API_KEY` for a dedicated Solana RPC endpoint and `FLUXIO_BACKEND_BASE_URL` for the announcements backend. Both may be left empty: the build then falls back to public RPC endpoints and skips the announcements fetch. Missing values never break the build.

Run the test suites with `pnpm test`.

## Verify a store build against this source

The published store package can be checked against this repository honestly, with one documented caveat.

1. Check out the commit whose `apps/extension/manifest.json` version matches the store version you want to verify.
2. Obtain the store package (for example from your own Chrome profile's extensions directory after installing it) and extract it to a folder.
3. Build from source with `pnpm install` and `pnpm build:extension`.
4. Compare every file except the bundle byte per byte, for example:

```
diff -r --strip-trailing-cr store-folder apps/extension --exclude=background.bundle.js --exclude=background.bundle.js.map --exclude=node_modules --exclude=.env.local --exclude=release
```

   The flag `--strip-trailing-cr` neutralizes platform line ending differences between a Windows checkout and a Linux checkout; the content is otherwise identical.

   The store package only contains runtime files, so development files such as tests, `build.mjs`, `package.json` and `.env.example` will show up as present only in the source tree; that is expected. What matters is that every file inside the store package matches its source counterpart exactly.

5. The bundle `background/background.bundle.js` is deterministic: building the same commit twice produces an identical file. The only difference against the store bundle is the value of the two build time strings named above, which are injected from `.env.local` when the store build is made. Both values are plain strings inside the store bundle, so you can copy them into your own `apps/extension/.env.local`, rebuild, and compare the bundle byte per byte as well.
6. Comparing downloaded zip files directly is not meaningful because zip entries carry packaging timestamps; always compare the extracted trees.

## Security

See `SECURITY.md` for how to report a vulnerability privately. The cryptography is built on audited libraries (bip39, tweetnacl, ethers, the native Web Crypto API), but this codebase has not had an independent security audit yet.

## License

MIT, see `LICENSE`.
