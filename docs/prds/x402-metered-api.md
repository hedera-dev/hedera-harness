# x402 Keyless Metered API Demo Template

## Product Brief

Build a **scaffold-hbar template** demonstrating **Hedera x402 payments** — the HTTP 402-based micropayment protocol that lets software pay software without accounts or API keys. The app exposes a small set of JSON API endpoints: one free, one paywalled via x402. Callers pay per request using HBAR on Hedera testnet, settled through the Blocky402 facilitator. Each paid unlock is optionally logged to an **HCS topic** as a public sales receipt.

The result must be a valid scaffold-hbar template: `template.json`, `README.md`, `AGENTS.md`, and a working Next.js app under `packages/nextjs`.

## Who It Is For

- Developers exploring Hedera's x402 payment standard
- Teams building pay-per-call APIs without account/key infrastructure
- Agents or scripts that need to pay for data programmatically
- End users who prefer HashPack (or another Hedera WalletConnect wallet) for signing

## Core User Journeys

### 1. Browse the demo (no wallet, no payment)

A visitor lands on the home page and sees:

- A title/description of the metered API concept
- The free endpoint they can try immediately (e.g. `/api/data/free`)
- The paid endpoint with its price clearly displayed
- A live feed or list of recent paid unlocks (from HCS mirror reads or local state)
- Which Hedera network (testnet) and facilitator is in use

They should be able to call the free API and see a response without any wallet or payment.

### 2. Pay for a single API call (signer required)

A user connects a **Hedera-capable signer** and attempts the paid endpoint. Two signer modes must both work:

| Mode | Who uses it | How signing works |
|------|-------------|-------------------|
| **Burner wallet** | Harness validator + local demos | ECDSA private key from `localStorage["burnerWallet.pk"]`; app partially signs with `@hiero-ledger/sdk` / `@x402/hedera` |
| **HashPack (Hedera WalletConnect)** | Real end users | Wallet signs via HIP-820 / WalletConnect (`hedera_signTransaction`); app never sees the private key |

Flow (identical for both modes after the signer is selected):

1. Initial request returns **HTTP 402 Payment Required** with `PaymentRequirements` (asset, amount, payTo, feePayer)
2. App builds a `TransferTransaction` with the facilitator's `feePayer` as the transaction payer
3. App **partially signs** the frozen transfer (does **not** submit it)
4. App retries the request with the `X-PAYMENT` header
5. Resource server forwards to Blocky402 (`/verify` → `/settle`); facilitator co-signs and submits
6. On success, server returns premium data (HTTP 200)
7. UI shows success feedback including a HashScan link to the settlement transaction

**Critical distinction for x402:** use wallet **sign-only** (`hedera_signTransaction`), never `hedera_signAndExecuteTransaction`. The facilitator must remain the party that submits the transaction after co-signing.

### 3. View payment receipts (no wallet required for read)

After a paid call settles, a compact receipt is submitted to an HCS topic:

```json
{
  "type": "x402.receipt.v1",
  "endpoint": "/api/data/paid",
  "payer": "0.0.xxx",
  "amount": "50000000",
  "asset": "0.0.0",
  "settlementTxId": "0.0.xxx@timestamp",
  "timestamp": "ISO-8601"
}
```

Anyone can browse the receipt feed on the home page or verify via mirror node — no wallet needed.

### 4. Admin / configuration (optional, wallet required)

An admin page allows:

- Creating the HCS receipt topic (if not pre-configured)
- Viewing the current facilitator URL and payTo account
- Seeing the configured price per call

Admin HCS create/submit must use the same hybrid signer model:

| Mode | HCS signing |
|------|-------------|
| Burner | `Client.setOperator(accountId, privateKey)` then `execute` |
| HashPack | `hedera_signAndExecuteTransaction` (full sign-and-submit is correct for HCS) |

## App Surface (minimum)

| Route | Purpose |
|-------|---------|
| `/` | Demo home — try free endpoint, trigger paid flow, view receipt feed |
| `/admin` | Configure HCS topic, view facilitator/payTo settings |
| `/api/data/free` | Free JSON endpoint (no payment) |
| `/api/data/paid` | x402-gated endpoint — returns 402 until paid |
| `/api/receipts` | Read recent HCS receipts from mirror node |

Use scaffold-hbar UI conventions (Tailwind + DaisyUI) and extend wallet UX so users can choose **Burner** or **HashPack / Hedera WalletConnect**.

## Hedera Integration Expectations

### Hybrid signer architecture (required)

Implement a small **signer port** so UI and payment code never assume a private key is available:

```
HederaSigner
  - partialSignTransfer(requirements) → base64 X-PAYMENT payload   // x402
  - execute(transaction) → transactionId                            // HCS admin/receipts
```

Concrete adapters:

1. **`BurnerKeySigner`**
   - Reads `localStorage["burnerWallet.pk"]` (or sessionStorage if the scaffold burner is configured that way)
   - Uses `PrivateKey.fromStringECDSA` + `@x402/hedera` `createClientHederaSigner` / `ExactHederaScheme` for payments
   - Uses SDK `setOperator` + `execute` for HCS
   - This path is what the harness Test Signer exercises end-to-end

2. **`WalletConnectHederaSigner`** (HashPack and other HIP-820 wallets)
   - Connect via Hedera WalletConnect / AppKit + `@hashgraph/hedera-wallet-connect` (or equivalent maintained package)
   - x402: `hedera_signTransaction` on the frozen transfer list → encode payload (sign only)
   - HCS: `hedera_signAndExecuteTransaction`
   - Never ask the wallet for a private key export

Selection rule:

- If burner key is present **and** the connected connector is the burner wallet → use `BurnerKeySigner`
- If a Hedera WalletConnect / HashPack session is active → use `WalletConnectHederaSigner`
- If the user is connected with an **EVM-only** wallet (e.g. MetaMask) and has no burner key → show a clear error: native Hedera signing requires Burner or HashPack; do not silently fail

Connecting a wallet must not be confused with being able to pay: the UI should indicate which signer mode is active (Burner vs HashPack).

### x402 Payment Flow

- Resource server implements x402 server-side: respond with 402 + `PaymentRequirements` for unpaid requests
- Use `@x402/hedera` (or equivalent) for the `exact` scheme on the burner path; WalletConnect path may build the same transfer and sign via the wallet
- Facilitator: Blocky402 testnet (`https://api.testnet.blocky402.com`)
- Asset: HBAR (`0.0.0`), amount in tinybars (demo-friendly amount)
- Client-side always: freeze transfer with facilitator `feePayer` as payer → **partial sign** → `X-PAYMENT` → retry

### Consensus Service (HCS) — receipts

- After each successful settlement, submit a receipt message to a configured HCS topic (via whichever signer is active)
- Read receipts via mirror node for the home page feed
- Model receipts as compact JSON (endpoint, payer, amount, settlement tx id)

### Server/API shape

Provide Next.js API routes for:

- The free data endpoint
- The paid/gated data endpoint (x402 resource server logic)
- Receipt listing from mirror node
- Admin: topic creation (client-signed)

### Facilitator integration

- Use Blocky402 testnet facilitator (`https://api.testnet.blocky402.com`)
- Call `POST /verify` and `POST /settle` server-side
- The facilitator's fee-payer account pays network fees and submits the payment transaction
- Do NOT build a custom facilitator

## Technical Direction

- Start from the **seeded scaffold-hbar monorepo** in the run workspace
- Reduce to a **Next.js-only** Yarn workspace (`packages/nextjs` only)
- Remove or exclude Hardhat/Foundry workspaces and their scripts
- Use Yarn workspace commands from the repo root
- Follow scaffold-hbar conventions for `README.md`, `AGENTS.md`, and frontend structure
- Prefer patterns that pass **offline validation**: lint, TypeScript check, and production build without `.env`, private keys, or funded accounts
- scaffold-hbar ships RainbowKit + burner but **does not** ship HashPack — add Hedera WalletConnect / HashPack support in this template (dependencies + connect UX + signer adapter)
- Keep the burner path fully working for headless harness validation (`burnerWallet.pk` injection)
- Facilitator URL and payTo account should be configurable (env or localStorage), with sensible testnet defaults
- Document both connect paths in README and AGENTS.md (Burner for demos/CI; HashPack for real users)

## template.json Expectations

- Short template name: `x402-metered-api`
- Description: keyless pay-per-call API demo using Hedera x402
- `create-scaffold-hbar.capabilities.frontend`: `nextjs-app`
- `create-scaffold-hbar.capabilities.solidityFramework`: `none`
- Outro: no contract deploy needed, start with `yarn next:dev`

## Constraints

- **No** Hardhat, Foundry, Docker, or live deploy requirements
- **No** committed `.env` files, private keys, operator keys, or API secrets
- **No** npm or pnpm — Yarn only
- **No** custom x402 facilitator implementation — use Blocky402
- Keep all changes inside the current run workspace
- Do not modify repositories outside the workspace
- Do not read or copy from other local projects, prior harness runs, or template branches — implement WalletConnect/HashPack from package docs and this PRD

## Deliverables

- `template.json`
- `README.md` with install/dev commands, x402 flow explanation, dual-signer docs, and HashScan reference
- `AGENTS.md` with agent-oriented guidance (burner vs HashPack paths, which RPC methods to use for x402 vs HCS)
- Root `package.json` configured for a single Next.js workspace
- `packages/nextjs` app implementing the journeys above

## Validation Expectations (harness)

The harness will check (deterministically):

- Required template files exist
- Forbidden workspaces/files are absent
- No secret-like content in source
- `yarn install`, `yarn lint`, and `yarn next:build` succeed without live credentials

On-chain / semantic validation (when a Test Signer is provided) exercises **only the burner path** end-to-end. HashPack is affordance + architecture reviewed in the contract; it is not driven by Playwright automation.

## Out of Scope

- Custom facilitator implementation
- Production mainnet deployment
- Automating HashPack / browser-extension signing inside the harness
- Multi-asset pricing (pick HBAR or testnet USDC, not both)
- Complex rate limiting or DDoS protection
- Subscription/multi-call bundles
- Solidity contracts
- Treating MetaMask alone as a native Hedera signer for x402/HCS

## Success Criteria (human review)

A reviewer should be able to:

1. `yarn install && yarn next:dev` and open the demo
2. Call the free endpoint and get JSON
3. See the paid endpoint return 402 with payment terms
4. Connect **burner wallet**, pay, and receive the premium data (harness path)
5. Connect **HashPack**, approve the payment signature in the wallet, and receive the premium data (user path)
6. See a receipt on the feed and trace it on HashScan
7. Trust the template is safe to share (no secrets, no unnecessary tooling)
