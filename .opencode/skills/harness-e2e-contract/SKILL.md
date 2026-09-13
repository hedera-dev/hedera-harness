---
name: harness-e2e-contract
description: The UI contract that makes wallet E2E work on any dApp. GENERATE stamps route + data-testid via harness_e2e_contract set; EVALUATE reads it instead of guessing selectors.
---

# E2E contract — beta persistent test wallet

The MetaMask vault path is **beta**. It exists so the harness can keep one test
Chromium + extension across runs and sign **token** flows (USDC, other HTS) on
screen. It is not the human done bar (`hedera-local`). Stamp the contract
anyway — that is what makes the beta runner work on any app.

# Why E2E used to break on a new app

The wallet runner used to assume the seed scaffold: route `/payments`, inputs
`pay-to` / `pay-amount`, button `pay-send`. Any dApp whose write form lives
elsewhere was undriveable, and the agent would start guessing selectors or
sliding into Playwright MCP Chrome (no extension → stuck at the MetaMask
password). The contract removes the guessing.

One file per app: `.harness/e2e.json`.

## GENERATE — stamp it, every unit that ships a write

Put stable `data-testid` on the fields the wallet must touch. Names are yours,
but they must not change between runs.

```tsx
<input data-testid="usdc-destination" … />
<input data-testid="usdc-amount" … />
<button data-testid="usdc-send" …>Send USDC</button>
<span data-testid="usdc-tx-hash">{hash}</span>
```

Then record them:

```
harness_e2e_contract action=set route=/ to_testid=usdc-destination \
  amount_testid=usdc-amount submit_testid=usdc-send tx_hash_testid=usdc-tx-hash \
  submit_label="send usdc|send" confirmations=2 default_amount=0.01
```

- `confirmations=2` when the flow is **approve then execute** (ERC-20/HTS
  allowance, then transfer). `1` for a plain send.
- A unit is not done until `harness_e2e_contract status` returns
  `e2e_contract=ready`.

## EVALUATE — read it, do not guess

1. `harness_e2e_contract status`. `route=` and the testids are your targets.
2. `harness_wallet_session start url=…` → the visible MetaMask Chromium.
3. `harness_wallet_dom goto` `route=`, then `snapshot`. Quote live `value=`.
4. `fill` `to_testid` and `amount_testid`. Snapshot again to confirm the values.
5. Click `submit_testid` → `harness_wallet_mm confirm`. Repeat for
   `confirmations=2`.
6. Snapshot. Pass only on a **new** hash in `tx_hash_testid` / HashScan.

`harness_wallet_e2e` runs the same contract as one shot — fine on any app once
`e2e_contract=ready`.

## Failure reading

| Output | Meaning |
|--------|---------|
| `contract=missing` | No `.harness/e2e.json`; runner fell back to seed `/payments`. GENERATE owes a `set`. |
| `contract=invalid` | Bad route or a missing testid — `problem=` lines say which. |
| `form_ready=false` | The route never rendered `to_testid`. App or contract is wrong; do not switch browsers. |

Never Playwright MCP for wallet flows. Never ask the human to close Chrome —
`harness_wallet_session start` recycles a locked profile itself.
