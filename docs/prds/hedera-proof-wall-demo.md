# Hedera Proof Wall Demo Template

## Product Brief

Build a **scaffold-hbar template** for a Hedera-native hackathon/onboarding demo. The app should show how to use **Hedera Consensus Service (HCS)** for public, timestamped messages and **Hedera Token Service (HTS)** for a simple badge/token reward — **without** Solidity workspaces, contract deploy flows, or local chain tooling.

The result must be a valid scaffold-hbar template: `template.json`, `README.md`, `AGENTS.md`, and a working Next.js app under `packages/nextjs`.

## Who It Is For

- Developers new to Hedera who want a runnable example
- Hackathon participants who need a wallet-connected demo quickly
- Agents extending or customizing a Hedera frontend template

## Core User Journeys

### 1. Browse the Proof Wall (no wallet required for read path)

A visitor lands on the home page and sees a **Proof Wall**: a feed of messages from an HCS topic, ordered and timestamped via mirror node reads.

They should be able to:

- See which network/topic the wall is using (testnet by default)
- Scroll or paginate through recent proofs/messages
- Understand each entry’s payload and consensus timestamp
- Use the UI without connecting a wallet

### 2. Submit a proof (wallet required)

A user connects a wallet and submits a new proof message to the active HCS topic.

They should be able to:

- Connect a Hedera-compatible wallet
- Enter proof content (text/JSON payload)
- Submit the message through the app
- See confirmation or error feedback in the UI

The write path may require testnet HBAR in a real deployment, but **build/lint/typecheck must not depend on live credentials**.

### 3. Admin setup (wallet required)

An organizer uses an admin page to bootstrap demo infrastructure.

They should be able to:

- Create a new **HCS topic** for the Proof Wall
- Create an **HTS badge/token** used to reward participants
- See the created IDs surfaced in the UI (topic ID, token ID)
- Optionally configure the app to use those IDs for subsequent flows

Admin actions are wallet-signed; the template should document that live setup needs a funded testnet account.

### 4. My Proofs (wallet required)

A participant views wallet-specific state.

They should be able to:

- Connect the same wallet used to submit proofs
- See proofs/messages associated with their account
- See whether they hold the badge/token (balance or association state)
- Understand badge eligibility separate from merely posting a proof

## App Surface (minimum)

The Next.js app should expose at least these routes:

| Route | Purpose |
|-------|---------|
| `/` | Proof Wall home — browse messages, entry point to submit a proof |
| `/admin` | Create HCS topic and HTS badge/token via connected wallet |
| `/my-proofs` | Wallet-specific proofs and badge/token state |

Use scaffold-hbar UI conventions (Tailwind + DaisyUI, wallet connect patterns, scaffold-hbar components where appropriate).

## Hedera Integration Expectations

### Consensus Service (HCS)

- Read topic messages via mirror node / REST patterns suitable for a Next.js app
- Submit messages via wallet-signed flows or server routes that accept signed transactions
- Model proofs as HCS message payloads (human-readable or small JSON)

### Token Service (HTS)

- Create a fungible or NFT-style badge token for participation rewards
- Check token balance or association for the connected wallet
- Support an airdrop or claim-style flow where appropriate (can be mock-friendly when operator credentials are absent)

### Server/API shape

Provide Next.js API routes or equivalent server handlers for Hedera operations that should not run purely in the browser (mirror reads, transaction preparation, operator-less mock paths, etc.). Exact route names are up to the implementer; coverage matters more than parity with any existing project.

Suggested capability areas (names illustrative):

- Topic message listing
- Message submission
- Topic creation
- Token creation
- Token balance / badge check
- Account / EVM address helpers as needed for wallet flows

## Technical Direction

- Start from the **seeded scaffold-hbar monorepo** in the run workspace
- Reduce the repo to a **Next.js-only** Yarn workspace (`packages/nextjs` only)
- Remove or exclude Hardhat/Foundry workspaces and their scripts
- Use Yarn workspace commands from the repo root
- Follow scaffold-hbar conventions for `README.md`, `AGENTS.md`, and frontend structure
- Prefer patterns that pass **offline validation**: lint, TypeScript check, and production build without `.env`, private keys, or funded accounts

## template.json Expectations

Produce scaffold-hbar-compatible metadata describing:

- A short template name and description for a Hedera-native Next.js demo
- `create-scaffold-hbar.capabilities.frontend`: `nextjs-app`
- `create-scaffold-hbar.capabilities.solidityFramework`: `none`
- Defaults matching the above
- Outro steps that explain no contract deploy is required and how to start the frontend (`yarn next:dev` or equivalent)

## Constraints

- **No** Hardhat, Foundry, Docker, or live deploy requirements
- **No** committed `.env` files, private keys, operator keys, or API secrets
- **No** npm or pnpm — Yarn only
- Keep all changes inside the current run workspace
- Do not modify repositories outside the workspace
- Do not read or copy from other local projects, prior harness runs, or template branches — build from the seed and this PRD

## Deliverables

- `template.json`
- `README.md` with install/dev commands and a short feature overview
- `AGENTS.md` with agent-oriented guidance for this template
- Root `package.json` configured for a single Next.js workspace
- `packages/nextjs` app implementing the journeys above

## Validation Expectations (harness)

The harness will check (deterministically):

- Required template files exist
- Forbidden workspaces/files are absent
- No secret-like content in source
- `yarn install`, `yarn lint`, `yarn next:check-types`, and `yarn next:build` succeed without live credentials

## Out of Scope

- Production mainnet deployment guides
- Complex multi-topic governance
- Custom Solidity contracts or local EVM deploy loops
- Requiring Docker, Hardhat, or Foundry for CI validation
- Perfect visual parity with any pre-existing demo — prioritize clear flows and Hedera-native behavior

## Success Criteria (human review)

A reviewer should be able to:

1. `yarn install && yarn next:dev` and open the Proof Wall
2. Follow README/AGENTS guidance without hidden setup steps
3. Recognize a coherent HCS + HTS story across `/`, `/admin`, and `/my-proofs`
4. Trust that the template is safe to share (no secrets, no contract-tooling baggage)
