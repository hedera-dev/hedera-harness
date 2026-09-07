# OpenCode as the Hedera Harness TUI

Date: 2026-09-06

## Findings

### OpenCode

- Repo: [sst/opencode](https://github.com/sst/opencode)
- License: **MIT** (confirmed `LICENSE` on `dev`: Copyright 2025 opencode)
- Runtime: coding agent + native TUI (SolidJS / OpenTUI), sessions, Tab-cycled **primary** agents, `@`-mention **subagents**, slash commands, skills, plugins, MCP
- Do **not** fork OpenCode. Use it as the TUI/agent host.

### How Gentle AI couples to OpenCode

Gentle is an **ecosystem configurator**, not a second TUI. For OpenCode it:

1. Writes a multi-agent overlay into `opencode.json` (`default_agent`, `agent.*` with `mode: primary|subagent`)
2. Sets `gentle-orchestrator` as the Tab-default conductor; SDD phases are hidden subagents (`sdd-explore`, `sdd-apply`, …)
3. Scopes `permission.task` so an orchestrator can only spawn its own phase agents
4. Puts reusable prompts in files (`{file:…}`) and slash commands (`/sdd-explore`)
5. Indexes skills via startup hook (`gentle-ai skill-registry refresh`); orchestrator passes **exact `SKILL.md` paths**, not summaries
6. Optionally registers TUI npm plugins in `~/.config/opencode/tui.json` (`plugin` array) — Gentle does not rewrite OpenCode’s UX
7. Optional Engram MCP for memory across sessions

User flow in OpenCode: open the TUI → Tab to orchestrator → `/command` or chat → orchestrator delegates with `task`.

### Mapping to hedera-harness

Harness stages are already a session of steps (`src/attemptStages.ts`):

`GENERATE → ASSERT → SMOKE → EVALUATE`

That is the Hedera-native loop. SDD phases (explore/spec/apply) are the wrong vocabulary here.

| Harness stage | OpenCode agent | Job |
|---|---|---|
| Conductor | `hedera-orchestrator` (primary) | INIT gate, then stages, never skip HashPack local bar |
| INIT | `hedera-init` | Clone/adopt if `.harness/spec.yaml` is missing (hard gate, like Gentle `sdd-init`) |
| PRD | `hedera-prd` | Author from TUI or discover an in-repo PRD; wire `spec.yaml`. Session asks Automatic vs Step by step |
| GENERATE | `hedera-generate` | Implement PRD; HIP-820 when runtime exists; HashPack when it does not |
| ASSERT | `hedera-assert` | Deterministic files/lint/build — read-only plus bash for gates |
| SMOKE | `hedera-smoke` | Dev server actually boots |
| EVALUATE | `hedera-evaluate` | Adversarial live app; Harness Test Wallet if `.harness/wallet/` exists |
| Human path | `hedera-local` | `yarn next:dev` + HashPack Connect/Send in real Chrome |

EVALUATE ≠ local Chrome. Both are required for “done”.

## Decision

Reuse Gentle’s **coupling pattern** on OpenCode. Do not clone Gentle’s SDD orchestrator. Prompts, agents, commands, skills, and a small plugin are Hedera-specific and live in this repo.

## Layout in this repo

| Path | Role |
|---|---|
| `opencode.json` | `default_agent: hedera-orchestrator`, task allowlist |
| `.opencode/prompts/hedera-orchestrator.md` | Conductor prompt |
| `.opencode/agents/hedera-*.md` | Hidden stage subagents |
| `.opencode/skills/*/SKILL.md` | Pipeline, wallet boundary, HashPack local bar |
| `.opencode/commands/harness-*.md` | `/harness-run` `/harness-status` `/harness-wallet` `/harness-local` |
| `.opencode/plugins/hedera-harness.js` | Blocks wallet `.env` dumps; optional `harness_*` tools |

## How to run

In this repo:

```
npm run build
opencode
```

In **another** project (Gentle stays in `~/.config/opencode`):

```
hedera-harness tui install test-app
cd test-app
opencode
```

Empty `test-app` (or a folder without `.harness/spec.yaml`) is **scaffolded automatically** by `tui install` (clone/adopt, no yarn). Inside OpenCode, `hedera-orchestrator` runs INIT as the prepare gate: spec.yaml + `yarn install` if `node_modules` is missing (`/harness-init`, `harness_ensure_init`).

`--keep-default` leaves Tab on Gentle; switch to `hedera-orchestrator` manually.

Uninstall:

```
hedera-harness tui uninstall D:\my-dapp
```

Tab to **hedera-orchestrator**. Slash `/harness-run`. Do not fork OpenCode and do not clone Gentle’s SDD agents.
