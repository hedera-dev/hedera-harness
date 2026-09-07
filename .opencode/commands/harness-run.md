---
description: Resolve PRD (find in repo or author from the TUI) then run the harness loop
agent: hedera-orchestrator
---

Natural language is enough — treat this as /harness-run.

**First `question` is the idea**, not Automatic vs Step by step. “Una app de Hedera” is not a PRD. Do not spawn INIT until they said what to build (or `harness_prd_status` is already `real`).

Order:

1. `harness_prd_status`
2. missing/skeleton → interview the idea (question tool)
3. Then Automatic vs Step by step
4. Then INIT (yarn if needed)
5. `harness_wallet_gate` until `gate=ok` (even if INIT was skipped)
6. @hedera-prd writes/wires the brief and `.harness/tasks.md`
7. GENERATE **one task at a time** (`harness_tasks_status`) → ASSERT once (`hardhat=skip` unless `Contracts: solidity`) → SMOKE → Playwright MCP E2E (`harness_playwright_mcp`) → local Chrome

Init `.harness/prd.md` (“edit me”) is a skeleton. Do not GENERATE until `harness_prd_status` is `real`. Do not spawn PRD/GENERATE while `harness_wallet_gate` is `gate=blocked`.

If Playwright MCP is missing: `question` install vs skip E2E. Disabled: enable, then new OpenCode session. Skip does not fail the run.

If the app already works and they asked for another feature: interview that idea, write a **new** `.harness/prds/NN-*.md`, append it to the `prd:` list, then the same GENERATE → … loop. Do not overwrite the delivered PRD.

In step-by-step, pause after each **work unit** and after each phase (continue / adjust / question).

$ARGUMENTS
