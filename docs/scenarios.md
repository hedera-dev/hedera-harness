# SCENARIO — native Hedera, no agent

CHAIN still injects one burner wallet into the generated app. That is the
wrong layer for proving HTS airdrops, HCS messages, or two-party transfers.

`scenarios:` is a harness-owned stage. The harness funds named actors, runs
real `@hiero-ledger/sdk` transactions on **testnet**, then asks the **public
mirror** whether the effects landed. The coding agent does not declare
success.

## Before / after

Before: the model writes 40–80 lines of SDK boilerplate, Playwright hopes
someone clicked Transfer, and a toast is treated as proof.

After:

```yaml
scenarios:
  enabled: true
  file: .harness/scenarios.yaml
```

```yaml
actors:
  alice: { fundHbar: 5 }
  bob: { fundHbar: 2 }
steps:
  - id: gold
    actor: alice
    tokenCreate: { name: GOLD, symbol: GOLD, initialSupply: 1000 }
  - id: associate
    actor: bob
    tokenAssociate: { token: gold }
  - id: drop
    actor: alice
    tokenAirdrop: { token: gold, to: bob, amount: 100 }
assert:
  - tokenBalance: { actor: bob, token: gold, min: 100 }
```

Four declarations. The harness executes them. HashScan shows the accounts.

## Placement

```
GENERATE → ASSERT → SCENARIO → SMOKE → EVALUATE
```

A failing scenario skips the browser. That is the same cost rule as ASSERT.

## Network

Testnet only. Mainnet is rejected. Point `HARNESS_MIRROR_BASE_URL` at a real
local node's mirror if you already run one (Solo / hanvil). The executor still
uses the SDK — it does not simulate consensus.

## Commands

```bash
hedera-harness doctor
hedera-harness validate-scenario
hedera-harness run
```

`validate-scenario` funds actors, runs the plan, asserts on the mirror, and
sweeps leftover HBAR back to the operator. Sweep is best-effort: an actor that
is still a token treasury, or that still holds tokens, cannot be deleted.

It needs `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` (or the env names in
`scenarios.operator`).
