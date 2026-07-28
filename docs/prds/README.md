# PRDs

The harness generates from a **product requirement document** you supply. The PRD describes *what to build*. Specs point at it like:

```yaml
prd: docs/prds/my-template.md
```

## Start with your own idea (recommended)

1. Copy the skeleton PRD and fill it in for **your** product:

```bash
NAME=my-hedera-demo
cp skeletons/new-template/prd.md docs/prds/${NAME}.md
```

2. Follow the full checklist: [`docs/authoring-a-template.md`](../authoring-a-template.md) (spec, validators, optional contract / Playwright).

3. Run your spec once `seed.repo` and paths are set.

Private / WIP drafts you do not want tracked can go under `docs/prds/local/` (gitignored).

## Example PRDs (inspiration)

The repo also ships three **reference** PRDs that pair with the checked-in example specs, contracts, and validators. Use them to see the expected depth — journeys, Hedera services, non-goals, deliverables — then write your own.

| PRD | Spec | What it demonstrates |
|-----|------|----------------------|
| [`hedera-proof-wall-demo.md`](./hedera-proof-wall-demo.md) | `specs/hedera-demo-from-main.yaml` | HCS + HTS UI demo, no Solidity |
| [`hts-precompile-demo.md`](./hts-precompile-demo.md) | `specs/hts-precompile-demo.yaml` | HTS system contract + Hardhat |
| [`x402-metered-api.md`](./x402-metered-api.md) | `specs/x402-metered-api.yaml` | x402 metered API demo |

You do **not** need to run these to use the harness. They are optional inspiration and complete benchmark packages.

## PRD vs acceptance contract

The PRD is product-facing (what to build). For Tier 3 semantic validation, also author a separate **acceptance contract** JSON under `contracts/` with numbered, browser-verifiable assertions — that file, not the PRD, is what the validator agent grades against.

Copyable stubs: [`skeletons/new-template/`](../../skeletons/new-template/).
