---
description: Resolve PRD (find in repo or author from the TUI) then run the harness loop
agent: hedera-orchestrator
---

Natural language is enough — treat this as /harness-run.

**First `question` is the idea**, custom path **first**. Starters (payments, HCS…) are **seeds**, not a brief: picking one still requires the full interview + **Así está**. Never jump to INIT/`hedera-prd`/GENERATE because they clicked payments. That is how the last demo wasted a build they then had to undo.

Order:

1. `harness_prd_status`
2. missing/skeleton → idea first (custom option **first**). Starter chip ≠ skip interview. **One question at a time** — never dump the whole interview in one `question`. Interview + **Así está**. First app: `/` becomes **their** dApp on the scaffold chassis (reuse components; do not ship seed Home + an extra route).
3. Then Automatic vs Step by step
4. Then INIT (yarn if needed)
5. `harness_wallet_gate` until `gate=ok` (even if INIT was skipped)
6. @hedera-prd writes/wires the brief and `.harness/tasks.md`
7. GENERATE **one task at a time** (`harness_tasks_status`, and `harness_e2e_contract action=set` for every write it ships) → ASSERT once (`hardhat=skip` unless `Contracts: solidity`) → SMOKE → MetaMask E2E (`harness_wallet_session` driving the contract's testids, **not** Playwright MCP) → local Chrome

Init `.harness/prd.md` (“edit me”) is a skeleton. Do not GENERATE until `harness_prd_status` is `real`. Do not spawn PRD/GENERATE while `harness_wallet_gate` is `gate=blocked`.

If Playwright MCP is missing: `question` install vs skip E2E. Disabled: enable, then new OpenCode session. Skip does not fail the run.

If the app already works and they asked for another feature: interview that idea, write a **new** `.harness/prds/NN-*.md`, append it to the `prd:` list, then the same GENERATE → … loop. Do not overwrite the delivered PRD.

In step-by-step, pause after each **work unit** and after each phase (continue / adjust / question).

$ARGUMENTS
