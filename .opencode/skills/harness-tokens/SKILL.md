---
name: harness-tokens
description: Resolve existing HTS tokens (USDC, USDT, any stable). Registry first; if missing, SearchHedera then webfetch; convert 0.0.x → 0x; remember and bake.
---

# Existing tokens (any stable / HTS)

`SearchHedera` explains **HIP-218** (HTS `0.0.x` → long-zero `0x`). Issuer ids (Circle USDC, USDT, …) are often **not** in Hedera docs.

## GENERATE

1. Call **`harness_tokens`** `action=lookup` `symbol=` (USDC, USDT, …) `network=testnet` unless they asked mainnet.
2. If `token=USDC` (or a hit): **bake `evm=`**. Env may override; it must not be the only source.
3. If `token=lookup` (unknown tomorrow’s stable):
   1. **`SearchHedera`** for `{symbol} Hedera {network} token id`.
   2. If MCP is empty/fail: **`webfetch` / `websearch` the issuer** (Circle, HashScan, SaucerSwap). That is allowed — it is not Hedera protocol docs.
   3. `harness_tokens` `action=convert` `hts_id=0.0.x`.
   4. `harness_tokens` `action=remember` `symbol=` `hts_id=` (writes `.harness/tokens.json`).
   5. **Bake `evm=`** in the app.
4. Do **not** invent a `0x`. Do **not** ask the human unless **both** MCP and webfetch failed. Do **not** ship “enter the token address” as the default path.

Cached: Hedera Testnet USDC = Circle `0.0.429274` → `0x0000000000000000000000000000000000068cda`. Destination must already be associated or `transfer` reverts.
