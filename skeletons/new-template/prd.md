# My Template (PRD)

> Copy to `docs/prds/<name>.md` and rewrite for **your** product. This file is a skeleton only.
> For inspiration (optional), see the example PRDs under `docs/prds/` (Proof Wall, HTS precompile, x402).

## Goal

One paragraph: what Hedera demo this template ships, who it is for, and what “done” looks like in a browser without live credentials.

## Journeys

1. **Browse without a wallet** — what the user can see/do offline or read-only.
2. **Configure / admin (if any)** — what setup UI exists; what requires a wallet.
3. **Wallet-gated actions** — name the affordances; do not require a successful on-chain tx for acceptance.

## Hedera services

- List services (e.g. HCS, HTS) and how they appear in the UI.
- Default network expectation (usually testnet) and empty-state behavior when nothing is configured.

## Non-goals

- No live operator keys or `.env` required to open the app.
- Call out frameworks you forbid (e.g. Hardhat/Foundry) if this is a native/services-only demo.

## Deliverables

- `template.json`, `README.md`, `AGENTS.md` suitable for scaffold-hbar
- Yarn workspace layout and scripts users will run (`yarn install`, `yarn next:dev`, …)
- Routes the acceptance contract will visit

## Acceptance

Numbered, browser-verifiable assertions live in the **acceptance contract** JSON — not only in this PRD. Keep this document product-facing; keep the contract test-facing.
