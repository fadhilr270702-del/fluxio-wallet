# scripts/

Standalone developer tooling — none of this is part of the app itself
(no package.json script runs anything here except `struktur:update`), and
none of it ships to users. Run these directly with `node scripts/<file>`.

## `devnet-transfer-demo.mjs` — manual Solana native-transfer proof

End-to-end proof that the real SOL transfer pipeline works (construct ->
sign via the real tweetnacl boundary -> broadcast -> confirm), against
either public Solana Devnet or a local `solana-test-validator`. See the
file's own header comment for every `FLUXIO_DEMO_*` env var it reads.

```bash
node scripts/devnet-transfer-demo.mjs                        # devnet, fresh throwaway sender
FLUXIO_DEMO_NETWORK=local node scripts/devnet-transfer-demo.mjs   # local validator instead
```

## `evm-transfer-demo.mjs` — manual EVM native-transfer proof

The same kind of end-to-end proof for native ETH transfers, against
either a local `anvil` node (funded via `anvil_setBalance`) or public
Ethereum Sepolia (no programmatic faucet — prints funding instructions).

```bash
node scripts/evm-transfer-demo.mjs                       # local anvil (default)
FLUXIO_EVM_NETWORK=sepolia node scripts/evm-transfer-demo.mjs  # Sepolia instead
```

## `spl-token-demo.mjs` — manual SPL token-balance proof

End-to-end proof that `tokenService.js`'s SPL (Solana) balance path works
against a REAL mint: creates a brand-new mint, creates a token account for
a recipient, mints supply into it, then prints a ready-to-paste
`chrome.storage` snippet to register that mint as a custom token — a
fallback for developers without a running popup to click through; the
extension's own Manage Tokens screen (Settings -> Manage Tokens) is the
normal way to register one now. Runs only against a local
`solana-test-validator`.

```bash
node scripts/spl-token-demo.mjs
```

## `erc20-local-demo.mjs` — manual ERC-20 token-balance proof

The same kind of proof for `tokenService.js`'s ERC-20 balance path —
compiles and deploys a minimal ERC-20 (`packages/services/erc20Admin.js`),
transfers some of it to a recipient, then prints the same kind of
ready-to-paste custom-token registration snippet as `spl-token-demo.mjs`
above (same fallback-path caveat). Runs only against a local `anvil` node.

```bash
node scripts/erc20-local-demo.mjs
```

## `verify-rpc-endpoints.mjs` — audit every configured RPC endpoint

Hits every network's default + fallback RPC endpoint in
`packages/constants/networks.js` for real and prints a PASS/FAIL table.
Run manually whenever an endpoint is added/changed/suspected dead — not
part of any automated suite.

```bash
node scripts/verify-rpc-endpoints.mjs
```

## `update-struktur-folder.js` — regenerate the folder-tree snapshot

Regenerates `struktur folder/tree.txt` + `tree-utf8.txt` from the actual
current repo layout. Wired to `pnpm struktur:update` — see
`struktur folder/README.md` for the full standing-maintenance rule this
supports.

```bash
pnpm struktur:update
```

## `archive-source.mjs` — the only sanctioned way to make a source zip

Builds a source archive with `git archive --format=zip HEAD` into a path
OUTSIDE the repo (default `%TEMP%\fluxio-source-<hash>.zip`), then reads
the zip's central directory and verifies ZERO sensitive entries
(`.env`/`.env.local`, `.db`/`.db-shm`/`.db-wal`, `node_modules`, `.git`,
`backend/data`, `backend/uploads`, `apps/extension/release`; committed
`.env.example` placeholders and the tracked `.gitkeep` files are the only
conscious exceptions, printed explicitly). Warns when `git status` is not
clean (git archive snapshots the last COMMIT, never uncommitted work) and
refuses an `--out` inside the repo. Born from two real incidents where a
tar of the working folder shipped `backend/.env`,
`apps/extension/.env.local`, and dev databases (second incident
20 September 2026) — see `deploy/README-deploy.md` step 14.1.

```bash
pnpm archive:source
pnpm archive:source -- --out=D:\somewhere\outside\fluxio-source.zip
```
