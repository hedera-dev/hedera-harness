# OpenCode

This repo is a **hedera-harness** workspace. Tab to **hedera-orchestrator**. Loop: INIT → PRD → GENERATE (one `.harness/tasks.md` unit at a time) → ASSERT (`yarn next:lint` only) → SMOKE (`harness_dev_serve`, never `nohup`) → MetaMask E2E → RainbowKit Connect+Send in the human's Chrome → `harness_dev_serve` stop → production stamp (`yarn next:build`).

Slash: `/harness-init` `/harness-run` `/harness-status` `/harness-wallet` `/harness-local`

The orchestrator asks **what to build** first (custom idea option first, not starter chips). A starter is a seed: still interview, **one question at a time**. Confirm **Así está** on the restatement. The first app’s UI is **their** dApp on the scaffold chassis (reuse components; do not ship the seed Home plus an extra route). The init “edit me” file is not a PRD. Then Automatic vs Step by step. Natural language starts the loop.

`harness_wallet_gate` must be `gate=ok` before PRD/GENERATE (even if INIT was skipped). GENERATE walks `.harness/tasks.md` one unit at a time. Existing tokens: `harness_tokens` (lookup → SearchHedera → issuer webfetch → convert → remember → bake). **Vault MetaMask E2E is beta** — persistent test Chromium + extension so token flows (USDC, …) can be signed on screen; it is not the done bar (`hedera-local` in the human’s Chrome is). Do not use Playwright MCP for wallet E2E. **Hedera docs: `SearchHedera` (`hedera-docs`) first** — `websearch` is forbidden for Hedera protocol docs while that tool is in the session. Fallback to `docs.hedera.com` only if MCP is missing or the call failed. Never read `.harness/wallet/` private keys.
