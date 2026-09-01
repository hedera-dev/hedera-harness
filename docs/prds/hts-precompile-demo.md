# HTS Precompile Demo Template

## Product Brief

Build a **scaffold-hbar template** that showcases **Solidity smart contracts on Hedera** using the **HTS system contract precompile (`0x167`)**. The app deploys a Hardhat-managed contract that creates and mints fungible HTS tokens entirely on-chain, and exposes a Next.js UI to read contract state and drive wallet-signed interactions.

The result must be a valid scaffold-hbar template: `template.json`, `README.md`, `AGENTS.md`, a working Next.js app under `packages/nextjs`, and a working Hardhat workspace under `packages/hardhat`.

## Who It Is For

- Developers learning Hedera EVM + HTS precompile patterns
- Hackathon participants who want a contract-first demo with a wallet UI
- Agents extending scaffold-hbar templates that keep Hardhat (not strip it)

## Core User Journeys

### 1. Browse the contract dashboard (no wallet required for read path)

A visitor lands on the home page and sees:

- Which Hedera network is targeted (testnet by default)
- The deployed HTS-precompile contract address (or a clear "not deployed yet" state)
- A short explanation of HTS precompile token creation vs native SDK flows
- Links or affordances to inspect the contract on HashScan when an address is known

They should be able to understand the demo without connecting a wallet.

### 2. Interact with the contract (wallet required for writes)

A user connects a Hedera-capable wallet (burner for harness/demos) and interacts with the deployed contract:

- **Create token** — call `createToken(name, symbol, initialSupply, decimals)` (payable; send HBAR for the HTS creation fee), then see the returned token address / ID in the UI
- **Mint tokens** — call `mintToken(token, amount)` for a previously created token, then see success feedback
- **Read state** — view contract address, recent create/mint outcomes, and token info via mirror node or contract reads

Write paths must be graceful when no wallet is connected (prompt / explain, never crash).

### 3. Contract workspace (developer path)

A developer using the template can:

- Compile Solidity with `yarn hardhat:compile`
- Deploy to Hedera testnet with a CI-friendly path that accepts `__RUNTIME_DEPLOYER_PRIVATE_KEY` (no interactive password prompt)
- See ABIs/addresses reflected in `packages/nextjs/contracts/deployedContracts.ts` after deploy
- Use scaffold-hbar hooks (`useScaffoldReadContract` / `useScaffoldWriteContract` or equivalent) against the deployed contract

## App Surface (minimum)

| Route | Purpose |
|-------|---------|
| `/` | Home / contract dashboard — network, address, HTS precompile story |
| `/contract` | Interact — create token, mint, read state |

Use scaffold-hbar UI conventions (Tailwind + DaisyUI, RainbowKit/burner wallet patterns, scaffold-hbar contract hooks where appropriate).

## Hedera / Solidity Integration Expectations

### HTS precompile contract (critical — do not keep the seed defaults blindly)

Keep a Solidity contract (e.g. `HtsTokenCreator`) that calls the HTS precompile at `0x167` with `createToken` (payable) and `mintToken`. Include the minimal `IHederaTokenService` interface (or `@hashgraph/smart-contracts` helpers) and clear custom errors / events (`TokenCreated`, `TokenMinted`).

**The seed contract’s `treasury` / `autoRenewAccount: msg.sender` pattern fails for burner/ECDSA-alias wallets** with HTS response code **9 (`KEY_NOT_PROVIDED`)**. Follow the HTS system-contract skill pattern instead:

| Field | Required value | Why |
|-------|----------------|-----|
| `treasury` | `address(this)` | Contract-owned treasury; works with EVM burner callers |
| `autoRenewAccount` | `address(this)` | Avoids KEY_NOT_PROVIDED when msg.sender is an ECDSA alias |
| Supply key | `CONTRACT_ID` → `address(this)` | So `mintToken` can be called from the same contract |
| HTS create call | `createFungibleToken{value: msg.value}(...)` | Creation fee must be paid in HBAR value, not gas alone |

Do **not**:

- Set `autoRenewAccount` or `treasury` to `msg.sender` for this demo
- Rely on deploy-time contract prefund as the only fee path (easy to underfund with ephemeral signers)
- Treat `HtsCreateFailed(9)` as an “insufficient HBAR” problem — map response codes via the vendored skill `references/response-codes.md`

### Hardhat workspace

- Keep `packages/hardhat` with `hardhat.config.ts` targeting `hederaTestnet` (chainId 296)
- Ensure deploy works **non-interactively** when `__RUNTIME_DEPLOYER_PRIVATE_KEY` is set in the environment
  - Do **not** require `yarn hardhat:deploy` interactive decryption for the harness path
  - Prefer documenting / supporting: `yarn workspace @sh/hardhat hardhat deploy --network hederaTestnet`
- After deploy, `generateTsAbis` (or equivalent post-deploy hook) must update `packages/nextjs/contracts/deployedContracts.ts`
- Offline `yarn hardhat:compile` must succeed without live credentials
- Deploy scripts must **not** require transferring large HBAR pools into the contract at deploy time (keep deploy cheap; fee comes from `msg.value` on create)

### Next.js frontend

- Read deployed contract info from `deployedContracts.ts` (or a clear empty/not-deployed state)
- Drive `createToken` / `mintToken` via wallet-signed contract writes (burner path must work for harness Test Signer)
- **`createToken` must send a non-zero `msg.value` by default** (~15–25 HBAR on testnet, or a clearly labeled default that covers the HTS creation fee). Do not default the fee field to `0` and hope the contract was prefunded
- Surface HashScan links for contract address and successful txs when available
- Mirror-node reads for token existence / supply are encouraged for confirmation UX
- After create, show the token address; mint should target that token (treasury is the contract — mint credits the contract treasury; UI should still show success / supply updates)

## Technical Direction

- Start from the **seeded scaffold-hbar monorepo** in the run workspace
- Keep a **Next.js + Hardhat** Yarn workspace (`packages/nextjs` and `packages/hardhat`)
- **Remove** the Foundry workspace (`packages/foundry`) and strip Foundry scripts from the root `package.json` (especially anything that would break `yarn lint` / `yarn format`)
- Use Yarn workspace commands from the repo root
- Follow scaffold-hbar conventions for `README.md`, `AGENTS.md`, and frontend structure
- Prefer patterns that pass **offline validation**: lint, Hardhat compile, and Next.js production build without `.env`, private keys, or funded accounts
- Live testnet deploy is performed by the harness chain-validation deploy hook using an ephemeral ECDSA signer — the template must accept that key via `__RUNTIME_DEPLOYER_PRIVATE_KEY`

## template.json Expectations

Produce scaffold-hbar-compatible metadata describing:

- Template name: `hts-precompile-demo`
- Description: HTS precompile Solidity demo with Hardhat + Next.js
- `create-scaffold-hbar.capabilities.frontend`: `nextjs-app`
- `create-scaffold-hbar.capabilities.solidityFramework`: `hardhat`
- Outro steps that explain compile (`yarn hardhat:compile`), non-interactive deploy with `__RUNTIME_DEPLOYER_PRIVATE_KEY`, and frontend start (`yarn next:dev`)

## Constraints

- **Keep** Hardhat; **remove** Foundry
- **No** Docker or live-credential requirements for offline lint/compile/build
- **No** committed `.env` files, private keys, operator keys, or API secrets
- **No** npm or pnpm — Yarn only
- Keep all changes inside the current run workspace
- Do not modify repositories outside the workspace
- Do not read or copy from other local projects, prior harness runs, or template branches — build from the seed and this PRD

## Deliverables

- `template.json`
- `README.md` with install/dev/compile/deploy commands and a short HTS precompile overview
- `AGENTS.md` with agent-oriented guidance (Hardhat keep, Foundry strip, non-interactive deploy, burner wallet, `address(this)` treasury/autoRenew, default create fee `msg.value`)
- Root `package.json` configured for Next.js + Hardhat workspaces (Foundry removed from workspaces and scripts)
- `packages/hardhat` with at least `HtsTokenCreator.sol` (or equivalent HTS precompile creator/minter) compiling and deployable
- `packages/nextjs` app implementing the journeys above

## Validation Expectations (harness)

The harness will check (deterministically):

- Required template files exist (including Hardhat config and Solidity sources)
- Foundry workspace is absent
- No secret-like content in source
- `yarn install`, `yarn hardhat:compile`, `yarn lint`, and `yarn next:build` succeed without live credentials

When chain validation is enabled, the harness will:

1. Inject `__RUNTIME_DEPLOYER_PRIVATE_KEY` from an ephemeral funded ECDSA test signer
2. Run non-interactive Hardhat deploy to `hederaTestnet`
3. Start the app and grade the evaluate checklist (including on-chain create/mint via burner wallet)

## Out of Scope

- Foundry as an alternate Solidity framework for this template
- Production mainnet deployment guides
- Complex DeFi (AMMs, lending, governance)
- Custom HTS fee schedules, KYC, or freeze workflows beyond what create/mint needs
- Requiring Docker for CI validation
- Interactive password-based deployer key decryption as the only deploy path

## Success Criteria (human review)

A reviewer should be able to:

1. `yarn install && yarn hardhat:compile && yarn next:dev` and open the dashboard
2. Deploy with `__RUNTIME_DEPLOYER_PRIVATE_KEY` set (non-interactive) and see the address in the UI / `deployedContracts.ts`
3. Connect burner wallet, create a token via the contract, mint to it, and verify on HashScan / mirror node
4. Trust that the template is safe to share (no secrets, Foundry stripped, Hardhat retained)
