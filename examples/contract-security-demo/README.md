# Contract-security validator — demo

A self-contained demo of the opt-in contract-security gate: a Foundry contract
with a deliberate reentrancy bug, and the recipe that makes ASSERT catch it
before the run proceeds.

## Files

- `contracts/src/Vault.sol` — a Vault whose `withdraw()` makes the external call
  **before** zeroing the balance (classic reentrancy). Slither flags it as
  `reentrancy-eth` (High).
- `Vault.fixed.sol.reference` — the repaired version (checks-effects-interactions).
  Swap it over `contracts/src/Vault.sol` to show the repaired attempt passing.
- `.harness/spec.yaml` — recipe with `validators.contractSecurity` enabled,
  `failOnSeverity: high`, `contractsDir: contracts`.
- `slither-output.sample.json` — captured real Slither output for reference.

## Prerequisites

```bash
pipx install slither-analyzer      # or: pip install slither-analyzer
# Foundry (forge) on PATH so Slither can compile the project.
hedera-harness doctor              # reports whether slither is on PATH
```

## What the gate does (verified end to end)

Run Slither over the buggy contract:

```bash
cd contracts && slither . --json -
```

Real output on this contract — **one High finding**:

```
 - reentrancy-eth   | High
 - low-level-calls  | Informational
```

The harness converts that into a single native finding (the Informational one
is below the `high` threshold and is dropped):

```json
{
  "id": "security:slither:reentrancy-eth:src/Vault.sol:16",
  "category": "security",
  "message": "[HIGH] reentrancy-eth in src/Vault.sol:16",
  "status": "open"
}
```

Because it is a `security` finding in ASSERT, the attempt fails and the finding
enters the repair loop — the contract is never deployed. Swapping in
`Vault.fixed.sol.reference` yields **zero High findings**, so ASSERT passes and
the run proceeds.

## Demo flow (for a recording)

1. `hedera-harness doctor` → shows the `slither` check passing.
2. Run the harness with the buggy `Vault.sol` → ASSERT fails with
   `security:slither:reentrancy-eth:...` before any deploy.
3. Repair: the agent (or you, swapping in the fixed contract) applies
   checks-effects-interactions.
4. Re-run → ASSERT passes, the run proceeds. The run notes show the
   open → fixed delta for that finding id.
