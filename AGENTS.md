# OpenCode

This repo is a **hedera-harness** workspace. Tab to **hedera-orchestrator**. Loop: INIT → PRD → GENERATE (one `.harness/tasks.md` unit at a time) → ASSERT (`yarn next:lint` only) → SMOKE (`harness_dev_serve`, never `nohup`) → MetaMask E2E → RainbowKit Connect+Send in the human's Chrome → `harness_dev_serve` stop → production stamp (`yarn next:build`).

Slash: `/harness-init` `/harness-run` `/harness-status` `/harness-wallet` `/harness-local`

The orchestrator asks **what to build** first (the init “edit me” file is not a PRD), then Automatic vs Step by step. Natural language starts the loop.

`harness_wallet_gate` must be `gate=ok` before PRD/GENERATE (even if INIT was skipped). GENERATE walks `.harness/tasks.md` one unit at a time. Final automated E2E is Playwright MCP (install/enable or skip). Prefer Hedera Docs MCP (`SearchHedera` / `hedera-docs`); if those tools are missing, search `docs.hedera.com`. Never read `.harness/wallet/` private keys.
