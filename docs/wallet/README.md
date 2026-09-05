# Persistent Wallet Runtime

Hedera Harness can validate browser behavior (SMOKE / EVALUATE) and network state (CHAIN). Between those layers sits a trust boundary the harness previously could not drive: **the user's wallet**.

This feature adds a **Harness Test Wallet** — a persistent testnet identity plus a browser extension that speaks the standard Hedera WalletConnect discovery protocol — so Playwright can Connect → Approve → Sign through a real wallet UI, then CHAIN / mirror verification can confirm the resulting transaction.

## Quick start

```bash
export HEDERA_OPERATOR_ID=0.0.xxxx
export HEDERA_OPERATOR_KEY=0x...          # ECDSA operator
export REOWN_PROJECT_ID=your_reown_id     # optional for the local demo bridge

npm install
npm run build

# Create or reuse .harness/wallet/account.json
npx hedera-harness wallet init

npx hedera-harness wallet status

# Headed Chrome + unpacked extension + examples/harness-pay
npx hedera-harness wallet demo --asset hbar
```

Requires Google Chrome installed (`channel: "chrome"`). Extensions cannot load in Playwright's headless bundled Chromium.

## Before / after

**Before:** browser tests and chain tests both pass, but the wallet boundary is a manual gap.

**After:** one persistent account → extension discovery → visible Approve/Sign → real testnet tx → mirror check.

## Architecture

| Piece | Persistence | Notes |
|---|---|---|
| `.harness/wallet/account.json` | Persistent | Account id + key; mode 0600; gitignored |
| Chromium profile + extension copy | Disposable per demo | Secrets via `runtime-config.json` in a temp copy, never in `extension/` source |
| Wallet HTTP runtime | Disposable per demo | Holds key; extension approve page calls it |
| chainSigner (existing) | Per-run ephemeral | Unchanged — still used for deploy/burner flows |

The coding agent never receives the wallet private key (not in prompts, logs, or `HARNESS_SIGNER_*` env).

## Proof obligations

1. **PO1** — `examples/harness-pay` uses only the standard `hedera-extension-query` / `hedera-extension-response` / `hedera-extension-connect-*` messages. No Harness-specific dApp SDK.
2. **PO2** — Playwright must click **Approve** and **Sign** on `approve.html` (full page, never a popup).
3. **PO3** — Transaction exists on Hedera testnet (mirror lookup in `wallet demo`).
4. **PO4** — `wallet init` twice reuses the same account id.
5. **PO5** — HBAR top-up from the operator when below `--hbar-target`.
6. **PO6** — Private key stays in `.harness/wallet/`; status output redacts it.

## Known issues (hackathon)

- Full `@reown/walletkit` relay pairing is optional stretch; the demo uses a local HTTP bridge after standard extension discovery so the golden path stays reliable offline from WC relays.
- USDC is not auto-funded. Prefund token `0.0.429274` or use `--asset hbar`.
- EVALUATE / Playwright MCP extension loading is **not** wired yet (`mcpBrowser.ts` still launches without `--load-extension`). Use `wallet demo` for the wallet boundary proof.
- Mainnet hard-fails.

## Commands

```text
hedera-harness wallet init [--workspace <path>] [--hbar-target <n>]
hedera-harness wallet status [--workspace <path>]
hedera-harness wallet demo [--asset hbar|usdc] [--amount <n>] [--pay-to 0.0.x] [--headed|--headless]
```
