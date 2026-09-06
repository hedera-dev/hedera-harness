# Mirror Node Validator (Tier 2.5)

Reads-only on-chain assertions against [Hedera Mirror Node](https://docs.hedera.com/hedera/sdks-and-apis/rest-api). Sits between Tier 2 (Playwright browser, no chain state) and Tier 3.5 (`chainSigner`, real testnet HBAR spent).

**Why it exists.** Recipes today can prove a UI renders (Tier 2) and prove a real signed tx lands (Tier 3.5), but there was nothing in between — no free way to assert that a contract deploy target lives on-chain, that a token id has the expected metadata, or that a topic exists for HCS audit-trail flows. This validator fills that gap using Mirror Node's REST API. Every check is a `GET`; no operator credentials needed; costs zero HBAR.

**When to use.**

| Scenario | Best tier |
|---|---|
| PRD says "deploy contract X" and you want to prove X is on-chain without spending HBAR to run it | ← this validator |
| PRD says "issue token with symbol USDC" — verify the token exists and its metadata matches | ← this validator |
| PRD says "user can deposit into vault" — needs a real signed tx | Tier 3.5 (`chainSigner`) |
| PRD says "UI renders /deposit" | Tier 2 (`playwrightGate`) |

## Usage

Add a `mirrorNode` block to your recipe's validators section:

```yaml
# .harness/spec.yaml (schema fragment)
validators:
  mirrorNode:
    enabled: true
    timeoutMs: 5000        # per-request; default 5000
    retries: 2             # 1 = no retry; default 1
    assertions:
      - name: "USDC token deployed"
        kind: "token-exists"
        network: "testnet"           # or "mainnet"; default "testnet"
        target: "0.0.429274"
        expected:
          symbol: "USDC"
          name: "USD Coin"
      - name: "Vault contract live"
        kind: "contract-exists"
        target: "0xe7E6fEDce9d72D112137B631E8D51831D30729A9"
      - name: "HCS audit topic exists"
        kind: "topic-exists"
        target: "0.0.10393879"
        expected:
          memo: "x402 audit"
      - name: "Vault got a call in last 15 min"
        kind: "recent-contract-call"
        target: "0xe7E6fEDce9d72D112137B631E8D51831D30729A9"
        maxAgeSeconds: 900
```

## Assertion kinds

- **`contract-exists`** — mirror `GET /contracts/{target}`. Fails on 404 or `deleted: true`. `target` accepts either `0x…` EVM address or `0.0.x` Hedera id.
- **`token-exists`** — mirror `GET /tokens/{target}`. Optional `expected.symbol` / `expected.name` for metadata match.
- **`account-exists`** — mirror `GET /accounts/{target}`. Optional `expected.minBalanceTinybars` for min-balance floor.
- **`topic-exists`** — mirror `GET /topics/{target}`. Optional `expected.memo` — substring match against the topic memo.
- **`recent-contract-call`** — mirror `GET /contracts/{target}/results`. Fails if no calls in the window, or last call status is non-`SUCCESS`. `maxAgeSeconds` defaults to 3600.

## Failures

Each assertion emits at most one `ValidationFinding` with:

- `validator: "mirror-node"`
- `severity: "error"` (or `"warn"` for a non-`SUCCESS` recent-call status)
- `code`: one of `mirror-node-contract-missing`, `mirror-node-token-missing`, `mirror-node-token-symbol-mismatch`, `mirror-node-token-name-mismatch`, `mirror-node-account-missing`, `mirror-node-account-underfunded`, `mirror-node-topic-missing`, `mirror-node-topic-memo-mismatch`, `mirror-node-no-contract-calls`, `mirror-node-contract-call-stale`, `mirror-node-contract-call-non-success`, `mirror-node-{kind}-transient` (network/timeout)
- `message`: human-readable, includes the assertion `name`

## Latency

Mirror Node lags consensus by ~2–4 seconds per Hedera docs. If you assert on state produced by an immediately-preceding tx, either:

1. Sleep ~5s between the tx and the assertion, or
2. Set `retries: 3` on the assertion — the validator retries with 200/400/800 ms backoff, which covers the mirror's typical sync window.

## Cost

Zero HBAR. Every check is a REST GET against the public mirror; the harness does not open a network client, submit any tx, or hold any keys.

## Trade-offs vs Tier 3.5

- ✅ Free (no HBAR)
- ✅ No operator credentials required (Tier 3.5 needs one)
- ✅ Fast — no `sdk.Client` boot, no consensus wait
- ❌ Read-only — cannot prove _behavior_ (that user X can deposit and get shares); only that state exists
- ❌ Bounded by mirror indexer completeness — a contract that reverted at deploy won't appear

Use both together when a recipe both deploys a contract AND exercises it: Tier 3.5 does the exercise (spends HBAR), Tier 2.5 verifies the artifacts.
