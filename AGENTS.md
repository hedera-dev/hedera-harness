# OpenCode

This repo is a **hedera-harness** workspace. Tab to **hedera-orchestrator**. Loop: INIT → PRD → GENERATE (one `.harness/tasks.md` unit at a time) → ASSERT (`yarn next:lint` only) → SMOKE (`harness_dev_serve`, never `nohup`) → MetaMask E2E → RainbowKit Connect+Send in the human's Chrome → `harness_dev_serve` stop → production stamp (`yarn next:build`).

Slash: `/harness-init` `/harness-run` `/harness-status` `/harness-wallet` `/harness-local`

The orchestrator asks **what to build** first (custom idea option first, not starter chips). A starter is a seed: still interview. Confirm **Así está** on the restatement. The init “edit me” file is not a PRD. Then Automatic vs Step by step. Natural language starts the loop.

`harness_wallet_gate` must be `gate=ok` before PRD/GENERATE (even if INIT was skipped). GENERATE walks `.harness/tasks.md` one unit at a time. Final automated E2E is Playwright MCP (install/enable or skip). **Hedera docs: `SearchHedera` (`hedera-docs`) first** — `websearch` is forbidden for Hedera while that tool is in the session. Fallback to `docs.hedera.com` only if MCP is missing or the call failed. Never read `.harness/wallet/` private keys.
