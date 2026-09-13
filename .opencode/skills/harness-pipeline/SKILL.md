---
name: harness-pipeline
description: GENERATE → ASSERT → SMOKE → EVALUATE order, cost rules, and hedera-harness CLI. Use when running or diagnosing a harness attempt.
---

# Harness pipeline

Use this skill whenever you run or diagnose a hedera-harness attempt.

## Stages (in order)

0. **Idea / PRD** — before pace and before INIT. `harness_prd_status`; init “edit me” is a skeleton. First question: **their idea** (that option first; starters second). Then **one question at a time** (never a stacked questionnaire). A starter chip is a seed, not a product — interview anyway. They must pick **Así está** on a restatement before Automatic vs Step by step or `hedera-prd`. First app: `/` is their dApp; scaffold is chassis (reuse components). Later increment: preserve the shipped dApp.
0b. **INIT** — then prepare: `.harness/spec.yaml`. Yarn already ran in `tui install` (terminal, no timeout). If `yarn=missing`, stop — they must leave OpenCode and re-run `hedera-harness tui install`. Never init the `hedera-harness` CLI repo itself.
0c. **Wallet gate** — `harness_wallet_gate` before PRD, GENERATE, ASSERT, SMOKE, EVALUATE, and local Chrome. Independent of INIT. If `gate=blocked`, stop and poll until `gate=ok`. Never skip this on an increment.
1. **GENERATE** — one work unit from `.harness/tasks.md` per `hedera-generate` spawn (whole PRD if the file is missing). Official CLI still uses one GENERATE per `prd:` increment.
2. **ASSERT** — deterministic files/lint/secrets. Cheap. Always run even if GENERATE failed. Once after all work units, not after each. If `hardhat=skip` (default), **only** `yarn next:lint` — **not** `yarn next:build` (that poisons `.next` for `next:dev`). Do not run root `yarn lint` or Hardhat. If `hardhat=run`, include `yarn hardhat:compile`.
3. **SMOKE** — `harness_dev_serve` `start` (tracked `yarn next:dev`). Skip if ASSERT failed. **Never `nohup`.** Reuse if CSS 200; otherwise kill leftover next:dev for this app then start one. HTML 200 is not enough. Do not `next:serve` / `next:build` here.
4. **E2E** — **MetaMask** on the visible dappwright Chromium, driving the `data-testid` from `harness_e2e_contract` `status` (GENERATE stamped them, see `harness-e2e-contract`). Prefer `harness_wallet_session` + `harness_wallet_dom` then `harness_wallet_mm`; `harness_wallet_e2e` runs the same contract as one shot on any app. Playwright MCP vanilla Chrome is not a signature, and a per-app `.spec.ts` is not E2E.
5. **EVALUATE** — same MetaMask E2E agent. Skip if ASSERT or SMOKE failed.
6. **Local Chrome** — same `next:dev` URL, RainbowKit Connect+Send.
7. **Production stamp (hecho)** — only after SMOKE + E2E + local pass. `harness_dev_serve` `stop`, then `yarn next:build`. A green build is the deployability stamp, not a gate before E2E. Never `next:build` while `next:dev` is using `.next`.

Source of truth: `src/attemptStages.ts` (`STAGE_NAMES`).

## CLI

From the harness repo (build first if `dist/index.js` is missing):

```
npm run build
node dist/index.js doctor
node dist/index.js run [.harness/spec.yaml] [--max-attempts N]
node dist/index.js validate
node dist/index.js wallet status
node dist/index.js mcp status
node dist/index.js tasks status
```

Prefer plugin tools `harness_doctor`, `harness_latest_run`, `harness_wallet_gate`, `harness_wallet_status`, `harness_tasks_status`, `harness_oz_mcp`, `harness_playwright_mcp` over scraping logs by hand.

**Hedera docs — MCP first.** Call `SearchHedera` (`hedera-docs`) before `websearch` / `webfetch`. Web on `https://docs.hedera.com` only if the MCP tool is missing or the call failed. One MCP call is not stalling GENERATE.

## Bash (OpenCode)

Stage subagents already **allow** obligated yarn/npm/npx/git/ls/grep/curl/harness CLI. `nohup` is **denied** on SMOKE. `git commit` / `git push` / `git reset` stay denied. **`yarn install` is denied in OpenCode bash.** `tui install` already ran yarn in a terminal (no timeout) before OpenCode. If deps are missing, leave OpenCode and re-run `hedera-harness tui install`. Run **one** command from the workspace root when you can. Extra wrappers can still prompt. `yarn next:dev` is denied on INIT/GENERATE/ASSERT/EVALUATE so they cannot boot a server by accident. `yarn next:build` is denied on those stages **and** SMOKE/local — only the orchestrator production stamp may build. SMOKE must `harness_dev_serve` (not a raw `yarn next:dev`).

## Cost rule

Never boot a dev server or EVALUATE until ASSERT is clean.
Do not compile or lint seed Solidity when `contracts=none`. Payments and HCS are frontend + Hedera services.
