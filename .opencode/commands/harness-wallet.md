---
description: Test wallet vault status (never keys). If missing, local provision page — not chat.
agent: hedera-orchestrator
---

Use `harness_wallet_gate` (or `harness_wallet_status`). Never read `.harness/wallet/` and never ask the human to paste a private key in this chat.

If `gate=blocked` / `ready=false`, stay on that tool until `gate=ok`. A **127.0.0.1** page opens for a **TESTNET** MetaMask key + password (create at https://portal.hedera.com/). Never a real wallet. Do not spawn PRD/GENERATE while blocked.

If `gate=ok` and they need the browser, `harness_wallet_browser`. First launch downloads MetaMask (dappwright), imports the TESTNET key, and adds Hedera Testnet. Later launches unlock the same profile. Never tell them to install MetaMask by hand.

$ARGUMENTS
