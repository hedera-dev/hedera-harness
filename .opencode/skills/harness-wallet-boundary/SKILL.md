---
name: harness-wallet-boundary
description: Never read or print private keys. Default EVALUATE is RainbowKit burner. HIP-820 Test Wallet is optional.
---

# Wallet boundary

Never read `account.json`, private keys, or hex/DER key material. Never print keys in chat, logs, or GENERATION_NOTES.md. Never ask the human to paste a private key into OpenCode.

## Default path (scaffold-hbar)

RainbowKit + wagmi + WalletConnect / injected. MetaMask and HashPack in that modal are EVM. Official hedera-harness EVALUATE may use Burner Wallet + `burnerWallet.pk` when a test signer is provisioned (`NEXT_PUBLIC_ENABLE_BURNER=true`). TUI MetaMask E2E needs Connect Wallet visible — do not leave the burner auto-connected.

## Test MetaMask vault (path A)

`.harness/wallet/metamask-test.json` holds a **testnet-only** key + MetaMask password, written only by `hedera-harness wallet provision` (local 127.0.0.1 page). `harness_wallet_gate` returns `gate=ok` or `gate=blocked` (never the key). Call it before PRD/GENERATE and later phases even if INIT was skipped.

If blocked, `http://127.0.0.1:17373/` must be **listening** (`server=up`) **until they save**. Connection refused *before* save means the provision process is not Node — call `harness_wallet_gate` again. Do **not** tell the human to run `opencode.exe … wallet provision`. Repair: `node <harness>/dist/index.js wallet provision --workspace <app> --port 17373`. After **Saved**, the process exits — `server=down` is expected. Poll `harness_wallet_gate`; `gate=ok` does not need the page still open.

`wallet browser` / `harness_wallet_session` / `harness_wallet_e2e` uses [dappwright](https://github.com/TenKeyLabs/dappwright) to load MetaMask into persistent Chromium (`.harness/wallet/chrome-profile/`), import the vault key, and add Hedera Testnet. Session tools snapshot/click/fill the **dapp tab** in that window; `harness_wallet_mm` approve/confirm the extension. Playwright MCP vanilla Chrome is not a MetaMask signature. Later sessions unlock; they do not re-paste.

`harness_wallet_session` `start` **always stops leftovers first** (session pid + chrome-profile Chromium; no-op if nothing is running), then launches. It only skips that cleanup when a healthy `session=up` is already there. Do not bash `Start-Sleep` / `netstat`. If start returns `session=hung`, start once more or use `harness_wallet_e2e`.

## Default path (scaffold-hbar)

RainbowKit + wagmi + WalletConnect / injected. MetaMask and HashPack in that modal are EVM. Official hedera-harness EVALUATE may use Burner Wallet + `burnerWallet.pk` when a test signer is provisioned (`NEXT_PUBLIC_ENABLE_BURNER=true`). TUI MetaMask E2E needs Connect Wallet visible — do not leave the burner auto-connected.

## Optional HIP-820

`.harness/wallet/` + `window.__HARNESS_WALLET_RUNTIME__` is the Harness Test Wallet for agent-driven HIP-820. If those are missing, do not fail the run and do not tell GENERATE to add native HashPack CryptoTransfer.

Safe status: `node dist/index.js wallet status` or `harness_wallet_status` (account id + balances only).
