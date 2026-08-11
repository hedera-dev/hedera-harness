# hedera-harness — implementation plan

**Status:** Phases 0–1 complete; Phase 2 next
**Date:** 2026-08-11
**Baseline:** v1.1.2 (`28e36f9`), 9,400 source lines, 73 tests passing
**Current:** branch `feat/harness-phase-0-1-bulletproof`, 8,558 source lines, 76 tests passing

| Phase | Status |
|---|---|
| 0 — delete the retired product | ✅ complete |
| 1 — stabilise the live path | ✅ complete (e2e gate not yet run) |
| 2 — stages + findings lifecycle | next |
| 3–7 | not started |

---

## Background

The harness began as an **evaluation harness**: clone a scaffold-hbar template into an
isolated workspace, have an agent rebuild it from a PRD, and score the result without
letting the agent peek at the reference implementation. That explains `seed`, the
blind-integrity oracle audit, the per-template acceptance contracts, and the adversarial
QA validator.

It has since become a **developer tool**: the user's own repo is the workspace, the PRD
describes a novel feature, and there is no reference implementation to peek at. The
oracle is obsolete by construction.

Both architectures still ship. Roughly 1,000 source lines and 450 test lines encode the
retired product, and they are entangled with the live path — they are why
`loadTemplateSpec` takes a `requireSeed` boolean, why `attemptLoop` branches on layout
mode, and why `runner.ts` is a pass-through shim. This plan removes them, stabilises the
live path, and reshapes the recipe format for two delivery flows.

### The two flows

1. **From scratch** — `hedera-harness init my-app` clones `scaffold-hbar@main`,
   provisions `.harness/`, user edits, `hedera-harness run`.
2. **From a template** — `npx create-hbar@latest` scaffolds a `templates/*` branch;
   the harness is already a dependency; user runs `yarn harness:init` to provision
   `.harness/`, edits, `hedera-harness run`.

Both converge on the same in-place execution model. They differ only in how the project
came to exist.

---

## Decisions

| | Decision | Outcome | Rationale |
|---|---|---|---|
| **D1** | Recipe ownership | **Harness package** | Per-branch footprint collapses to dependency + script + README + identity marker — one PR per branch, never revisited. Alternative was committing a recipe to 8+ `templates/*` branches, each hand-maintained and subject to rebase conflicts from `main`. |
| **D2** | Manifest shape | **Ordered slices; minimal sequential runner in scope** | "Build my dapp idea" decomposes badly into one PRD with 3 attempts and well into N accumulating slices on one branch. Run logs support this: 3 of 11 recorded runs died at exactly `maxAttempts: 3`, and the two 4-attempt passes were both `--continue` rescues. Originally sized L by importing the reference harness's full programme/slice/pass state model; rescoped to M by building on the existing session + cycle machinery instead. See Phase 7 for what is in and out. |
| **D3** | Vocabulary | **Keep `spec.yaml` / `prd.md`** | Declined the rename to manifest/spec. Note the collision: in the stakeholder's harness, `specs/*.md` are feature descriptions and `programmes/*.yaml` is config — the word "spec" means the opposite thing there. Expect friction in cross-team discussion. |
| **D4** | Convergence scope | **Architecture, not code shape** | Adopt stages, findings contract, prompts-as-files, slim config. Do not pursue line-count parity: the reference harness has no chain provisioning, tiered validators, init/scaffolding, or skills vendoring. |

### Consequence of D2 + D3

With slices there are multiple feature descriptions per project, so `prd:` becomes a
**list** (or a `.harness/prds/*.md` directory convention). Filenames stay `spec.yaml`
and `prd.md` per D3; only the cardinality changes.

---

## Phase 0 — Delete the retired product ✅

Commits `1f49211`, `1c09933`, `0f6e6b2`, `a3f7a62`. 2,754 deletions / 438 insertions.

No decisions required. First, because it removes the seams that make everything else
confusing.

**Isolated-run path**
- `src/workspaceSeeder.ts` (zero importers)
- `src/workspaceGit.ts` (type-only usage from `attemptLoop`)
- `createRunLayout`, `resolveContinueRunDirectory`, `LAYOUT_MODE_ISOLATED_RUN` in `runArtifacts.ts`
- `runIsolatedAttemptLoop`, `createIsolatedPromptStrategy` in `attemptLoop.ts`
- isolated prompt builders in `promptBuilder.ts`

**Oracle audit** (~32 references across 5 files)
- `src/oracleAudit.ts`
- `BlindIntegrityResult` / `OracleAccessFinding` in `types.ts`
- `RunReport.blindIntegrity`
- the peeking warning in `cli.ts:135-140` and `runOutro.ts` references

**Seed from the schema**
- `SeedConfig`, `readSeed`, `readOptionalSeed`, `seed.isolation`
- the `requireSeed` option on `loadTemplateSpec` — the boolean that forks two products
- `RunReport.seedRepo` / `seedRef` / `seedCommitSha` (already placeholder values,
  `sessionRunner.ts:157`)

**Eval-era assets** — root `specs/`, `contracts/`, `validators/`, `playwright/`.
These were authored for dev-testing against hedera demo apps, not scaffold-hbar
templates. Not a head start on the overlays.

**Tests** — ~450 lines in `continue-behavior.test.mjs` and most of `run-layout.test.mjs`.

**Also** — fold `runner.ts` into its callers.

**Exit criteria** — all met
- ✅ `loadTemplateSpec` has no `requireSeed` fork
- ✅ `attemptLoop` has no layout-mode branching
- ✅ typecheck clean, tests green
- ✅ `.tmp-test/` cleared by a `pretest` step (637 stale directories removed)

**Notes**
- `buildRepairPrompt` looked isolated-only but is shared with
  `buildSessionRepairPrompt`; only `buildGeneratorPrompt` and `buildContinuePrompt`
  were removed.
- `commitAttempt` became a required input on the attempt loop rather than defaulting
  to the isolated `git add -A` committer, so checkpoints always take the
  exclusion-safe path.
- A post-phase review under `--noUnusedLocals --noUnusedParameters` found dead locals
  left by the deletions plus one pre-existing bug (folded into Phase 1).

---

## Phase 1 — Stabilise the live path ✅

Commits `ddc71e2`, `fbbd7f9`, `888b29c`.

Correctness bugs in the path everything else builds on. Before refactoring, so we are
not debugging new structure and old bugs at once.

| Issue | Location |
|---|---|
| Orphaned dev server — detached process group never killed when URL detection or readiness fails | `validation/devServer.ts:29`, `attemptLoop.ts:666` |
| Timeout cannot kill — SIGTERM only, no SIGKILL escalation; with `shell: true` signals the shell, not the tree | `command.ts:42-45` |
| Unbounded output buffering — agent `stream-json` over a 60-min timeout held entirely in memory | `command.ts:37`, `providers/commandAgentProvider.ts:64` |
| Prompt leaked to agent log — positional `args.slice(0, -1)` redaction only works when the prompt is appended; `{prompt}`-placeholder configs (the documented Claude Code shape) log the full prompt, including the ephemeral private key | `providers/commandAgentProvider.ts:186` |
| `chain-signer.json` written `0644` | `validation/chainSigner.ts:99` |
| Key material persists in `prompts/validator-attempt-N.txt` after cleanup | `runCleanup.ts:48` deletes only the signer file |
| Secret scanner walks `.harness/` — reads the harness's own `chain-signer.json` | `validation/index.ts:309` |
| Unguarded `JSON.parse` on workspace files — malformed app JSON crashes the run instead of producing a finding | `validation/index.ts:145` |

### Added during the phase

**Repair prompts pointed at files that do not exist.** Two different constants are both
named `HARNESS_CONTEXT_DIR` — `.harness/runtime/context` in `runtimePaths.ts` (where the
run actually vendors) and `.harness-context` in `contextVendor.ts`. `promptBuilder.ts`
imports both. `buildSessionRepairPrompt` accepted a `VendoredContext` and never forwarded
it, so every repair attempt fell through to the `.harness-context/` defaults and told the
agent to read a PRD and acceptance contract at paths a project run never creates. Only
the initial and continue prompts used the real ones.

Worth watching: 3 of 11 recorded runs exhausted their attempt budget, and repair was
running half-blind. Confirm whether convergence improves before Phase 2 changes the loop.

### Exit criteria

- ✅ grepping run artifacts for key material returns nothing
- ⬜ **e2e smoke passes with no orphaned processes** — not yet run. Needs a real agent
  run (40 min – 2.5 hrs per the run logs). Do this before Phase 2, since Phase 2
  restructures the loop these fixes live in.

### Behaviour change to exercise

Children now spawn `detached` (POSIX) so timeouts can signal the whole process group.
The trade: they no longer die with the terminal, so a `SIGKILL`ed harness leaves them
running. This is the same trade the dev server already made deliberately, and it is what
makes tree-kill possible at all — but it is the change most worth exercising on a real run.

**Size:** M.

---

## Phase 2 — Stage extraction + findings lifecycle

The "cluttered architecture" fix.

- Split `runAttemptLoop` (826 lines) into **GENERATE → ASSERT → SMOKE → EVALUATE**
  behind a common stage signature; early stages short-circuit back to GENERATE
- Move `runAttemptValidation` into `validation/`
- Findings gain `status: 'open' | 'fixed'` with stable IDs; track open IDs per attempt
  in session state, so a run reports *convergence* rather than only pass/fail
- Stage names in console output (`Stage 2/4 ASSERT` reads better than
  `Attempt 3 deterministic validation`)
- Add `noUnusedLocals` / `noUnusedParameters` to `tsconfig.json`. Run manually after
  Phase 0, they surfaced both the dead locals and the repair-prompt bug; they should be
  permanent rather than a thing someone remembers to run.
- Resolve the duplicate `HARNESS_CONTEXT_DIR` naming collision that caused that bug.

**Keep `infrastructureFailure` as a distinct channel.** The reference harness folds env
failures into the findings stream as synthetic findings; ours distinguishes "the app is
broken" from "the harness is broken" and aborts the repair loop accordingly. That is the
better behaviour — do not collapse it.

**Exit criteria**
- `attemptLoop.ts` under ~300 lines
- each stage testable in isolation

**Size:** L.

---

## Phase 3 — Manifest redesign

Requires D1, D2, D3.

**Add**
- `schemaVersion` — missing → treat as 1; above max supported → hard error naming both
  versions and the fix; below min → migration pointer; unknown top-level keys → warn
  (today they are silently ignored, so a newer recipe on an older harness can lose its
  baseline gate with no error)
- `prd:` as a list, per the D2 + D3 consequence above

**Default** (harness-owned, overridable)
- `generator` — replaced by an `agent: cursor | claude` preset; raw `generator:` stays
  as an escape hatch
- `logging` — currently required and editable into a state that deadlocks the next run
  (logs land outside `.harness/runs/`, are not filtered by `filterRelevantDirtyEntries`,
  and then fail `assertWorkingTreeCleanForRunStart`)
- `secretScan`, `forbiddenFiles`, validator paths, prd path, `maxAttempts`
  (already defaults to 3 at `specLoader.ts:58` — the skeleton restates it redundantly)

**Derive**
- `constraints.packageManager` — detection already exists in `optionalDeps.ts:24`
- `constraints.forbiddenCommands` — if the package manager is yarn, the forbidden set is
  the other two

**Move** — `templateMetadata` becomes the template identity marker (Phase 5)

**Rename** — `extend.baseline` → `baseline` (describes a command that no longer exists)

**Delete** — `requiredFiles` entries asserting `.harness/spec.yaml` and `.harness/prd.md`
exist; the harness just read them

**Consolidate** — `secretScan`, `forbiddenFiles`, and `HARNESS_SECRET_PATH_MARKERS`
(`harnessGit.ts:58`) are three overlapping secret lists; collapse to one

**Generated file shape** — ~5 active lines plus commented defaults. Commented defaults
cannot drift; stale config can.

**Exit criteria**
- skeleton manifest under 10 active lines
- an old-format recipe still loads, with a deprecation warning

**Size:** M.

---

## Phase 4 — Prompts, MCP, models, knobs

- `promptBuilder.ts` (723 lines) → `prompts/*.md` templates with a thin render layer.
  Prompt tuning is the main quality lever; it should not require a recompile.
- MCP config per role as files; delete `withPlaywrightMcpSnapshot`
- Agent presets ship the correct MCP file per agent — **this is what fixes the Claude
  Code gap**: README documents Claude as first-class, but `ensurePlaywrightMcp` writes
  only `.cursor/mcp.json`, so the semantic validator has no browser tools under Claude
  and is instructed to fail assertions when they are absent
- Model escalation — default model on pass 1, cheaper on repairs, escalate when stuck
- Env-var knobs for timeouts / max attempts / models
- `doctor` command — fail in 2 seconds instead of 40 minutes

**Exit criteria**
- switching Cursor ↔ Claude is a one-line change
- the Claude path works end to end

**Size:** M.

---

## Phase 5 — Provisioning + overlays

Requires D1.

- `init` becomes seed-optional:
  - empty / new directory → clone `scaffold-hbar@main` + provision (flow 1)
  - existing project → provision in place (flow 2)
  `assertTargetReadyForInit` (`initSeeder.ts:142`) currently throws on a non-empty
  target; `provisionHarnessProject` is already idempotent and non-destructive
- **Resolve the provisioner collision:** `harnessProvisioner.ts:50-55` skips files that
  already exist. If a branch ever ships `.harness/`, `init` silently writes nothing and
  reports `filesWritten=0`. Under D1 no branch ships a recipe, so this is moot — but make
  the skip explicit and logged rather than incidental.
- Template identity detection + overlay selection; refuse rather than guess when the
  template cannot be identified
- Base manifest + 8 template overlays (each needs a real PRD set)
- **Rewrite the authoring docs rather than delete them.** `docs/authoring-a-template.md`,
  `docs/prds/README.md`, and `skeletons/new-template/` all target the directories Phase 0
  removed (`specs/`, `contracts/`, `validators/`, `playwright/`), so they are broken as
  written. The tier strategy and validator guidance in them is still valid — only the
  destinations changed. They become the overlay-authoring guide. (Decided rather than
  deleting in Phase 0; the skeleton is marked stale in the README tree meanwhile.)
- Fix `--template`: `initRunner.ts:23` maps it straight to a git ref, so
  `--template hedera-demo` fails against the `templates/hedera-demo` branch naming.
  Prefix `templates/` and validate against the known set.

**Exit criteria**
- both init modes work
- all 8 templates produce correct manifests

**Size:** L — the overlays and their PRDs are the bulk.

---

## Phase 6 — CI matrix + template PRs

- Per-template CI job: clone branch → `init` → `run` → assert. Mock agent on PRs
  (`scripts/mock-agent.mjs`), real agent nightly.
  This replaces the deleted benchmark and is strictly better: it exercises the shipping
  path, and blindness is structural (nothing to peek at) rather than forensic.
- One-time PR per scaffold-hbar branch: dependency, `harness:init` script, README
  section, identity marker

**Discoverability** — flow 2 removes the visible `.harness/` directory from scaffolded
projects. Buy it back deliberately: the `harness:init` script in `package.json`, a README
section per template, and `create-hbar`'s "next steps" output.

**Exit criteria**
- matrix green
- recipe drift is a failing build, not silent rot

**Size:** M.

---

## Phase 7 — Slices

Requires D2 and the `prd:` list from Phase 3. Can ship after Phase 6.

**In scope — a minimal sequential runner** built on the existing session and cycle
machinery rather than a new state model:

- the `prd:` list drives an ordered set of slices
- vendor the right PRD per slice (`vendorHarnessContext` already takes a `prdPath`)
- wrap the attempt-loop call in a loop over slices in `sessionRunner`
- slice index on `SessionMetadata` (already versioned) for resume
- per-slice pass/fail in the report; the prompt states "increment 2 of 4, increment 1 done"
- stop on the first failing slice
- `/create-harness-spec` emits N ordered PRDs instead of one

No new branch model (one branch already), no new commit model (checkpoints already
accumulate), no new state store.

**Deferred until real usage** — per-slice retry policy, cross-slice rollback, and
slice-level reporting beyond pass/fail. These need evidence to design well, and are
additive once the format is in place.

**Exit criteria**
- a multi-slice programme delivers incrementally
- a failed slice 3 does not discard slices 1–2

**Size:** M.

---

## Sequencing

Only four orderings are binding:

1. **Phase 0 before everything** — deletes the seams
2. **Phase 1 before Phase 2** — do not refactor over known bugs
3. **D2 before Phase 3** — slices change the manifest shape
4. **Phase 3 before Phase 5** — authoring 8 overlays then changing the format means
   rewriting 8 overlays

Everything else can move. Phase 7 can ship well after Phase 6.

**Testing rides along rather than forming a phase.** Coverage today is inverted relative
to risk: the deepest coverage is on the dead isolated path, while `chainSigner.ts` (431
lines, handles live keys and funds), `promptBuilder.ts` (723), `validation/index.ts`
(370), `semanticValidator.ts`, and `command.ts` have none. As each phase touches those
files, they get their first real tests.

---

## Out of scope

- Rewriting to ~750 lines. The reference harness has no chain provisioning, tiered
  validators, init/scaffolding, or skills vendoring; its line count is not a target.
- Dropping chain provisioning, tiered validators, baseline health gates, package-manager
  detection, or the git safety rigour (explicit path staging, secret exclusion, index
  re-check, checkpoint-SHA verification). These exceed the reference implementation and
  matter more here, because users run this against their own repositories rather than a
  disposable VM.
- Changing the execution model. Both harnesses already agree: the repo is the workspace,
  the host is the safety boundary, one branch per unit of work, commit every pass.

---

## Traceability

| Source | Phases |
|---|---|
| Code review (2026-08-11) — bugs, secret handling, dead code | 0, 1 ✅ |
| Stakeholder review — "overcomplicated, cluttered from iterative WIP" | 0, 1 |
| Stakeholder review — adoptable ideas for UX/DX | 2, 3, 4, 7 |
| Product plan — two delivery flows | 3, 5, 6 |
