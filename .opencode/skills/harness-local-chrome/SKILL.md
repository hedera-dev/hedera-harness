---
name: harness-local-chrome
description: Human done bar — yarn next:dev in real Chrome, RainbowKit Connect (MetaMask or HashPack) and EVM Send.
---

# Local Chrome + RainbowKit (EVM)

A harness run is **not done** until a human can:

1. Reuse SMOKE’s `yarn next:dev` URL (scaffold-hbar: usually port 3000/3001). Do not `yarn next:build` here. If nothing is listening, `yarn next:dev` on a **clean** `.next` (delete `packages/nextjs/.next` if `BUILD_ID` exists). If the page is black with a giant Hedera H, CSS 404'd: stop Next, delete `packages/nextjs/.next`, restart `yarn next:dev`.
2. Open the app in **their** Chrome (not EVALUATE Chromium)
3. Connect via the RainbowKit / WalletConnect modal (MetaMask, HashPack in that list, etc.)
4. Complete the feature on Hedera testnet (e.g. send HBAR)

## Path

Scaffold-hbar default: RainbowKit + wagmi + eip155. HashPack in that modal is injected EVM, same Send as MetaMask (`sendTransaction` / contract writes).

Do not require HIP-820 native CryptoTransfer unless the PRD asked for native Hedera signing.

## Why EVALUATE is not enough

EVALUATE may use Burner Wallet or a harness runtime. Local Chrome does not inject `__HARNESS_WALLET_RUNTIME__`. Send must still work without that global.
