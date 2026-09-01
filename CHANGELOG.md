# Changelog

## Unreleased

### Breaking Changes

- **Greenfield schema cut.** Recipes must declare `schemaVersion: 3`. Missing or
  older versions hard-fail at load (`Set schemaVersion: 3`). Future versions still
  hard-fail with an upgrade hint.
- **`hedera-harness migrate` removed.** Pre-current recipes are not rewritten;
  update them to the current schema (or regenerate with `init`) instead.
- **Removed keys hard-fail without migrate advice.** `contract:` → use `eval:`;
  `extend:` → use `baseline:`; `logging:` → remove it, harness logs always live
  under `.harness/runs/`. `extend.baseline` dual-read is gone.
- **Harness branches are `harness/run-*` only.** Legacy `harness/extend-*` is no
  longer recognized for continue / smart branch detection.
- **Layout metadata** no longer normalizes legacy `in-place-extend` mode.

### Breaking Changes (schema v3 — eval vocabulary)

- Recipe key `contract:` renamed to `eval:`. An unmigrated `contract:` key is
  rejected at recipe load (`use eval: not contract:`) so a run cannot burn a
  generator session before failing. Checklist file rename
  (`acceptance-contract.json` → `eval.json`) is the author's responsibility.
- Internal type `SemanticValidationResult` → `EvaluationResult`; field
  `semanticValidation` on `ValidationResult`/`RunReport` → `evaluation`.
- Finding category `"semantic"` → `"eval"`, `"semantic-infra"` → `"eval-infra"`.
- Finding id prefix `semantic:` → `eval:`.
- `status.json` key `semanticPassed` → `evaluationPassed`.
- `ValidatorIssue.contractAssertion` → `assertion`; `ValidationFinding.contractAssertion` → `assertion`.
- `TemplateSpec.contractPath` → `evalPaths` (normalized list; scalar `eval:` becomes length 1).
- `selectActiveSlice` / `specHasEval` / `allEvalPaths` are the selection seam for the active PRD/eval pair — callers must not index `prdPaths[i]` / `evalPaths[i]` ad hoc.
- List `eval:` must be 1:1 with `prd:` or load fails; scalar `eval:` grades every slice with one checklist. Only the active pair is vendored per increment.
- `VendoredContext.contractRelativePath/contractSourcePath` → `evalRelativePath/evalSourcePath`.
- `VENDORED_CONTRACT_PATH` → `VENDORED_EVAL_PATH` (points to `eval.json`).
- `harnessContractRelativePath()` → `harnessEvalRelativePath()`.
- `runSemanticValidation()` → `runEvaluation()`.
- Files `semanticValidator.ts` → `evaluation.ts`, `semanticInfra.ts` → `evalInfra.ts`.
- `detectSemanticInfrastructureFailure` → `detectEvalInfrastructureFailure`.
- `RepairScope "semantic-scoped"` → `"eval-scoped"`.
- Prompt template `repair-semantic` → `repair-eval`; validator mustache
  `{{contract}}` → `{{eval}}`; other mustache vars updated.
- `ASSERTION_ID_PATTERN` now matches `E\d+` (new assertion id prefix).
- `KNOWN_SPEC_KEYS`: `"contract"` → `"eval"`.
- Stage labels in docs/doctor/SVGs/CLI/optional-dep errors: ASSERT / SMOKE /
  EVALUATE / CHAIN (no leftover "Tier 2/3/3.5" or "Semantic validation" in
  user-facing output).

### Changed

- **Drop scaffold template-recipe CI.** Recipes are authored in the consumer
  project (`init` / create-harness-spec), not shipped on every `scaffold-hbar`
  `templates/*` branch. Removed the `template-recipes` workflow job,
  `npm run check:templates`, and `scripts/check-template-recipes.sh`.

- **Generator idle/timeout no longer skips SMOKE/EVALUATE.** A Cursor hang after
  `THINKING completed` still records an agent finding, but ASSERT pass continues
  into the product gates (agent findings were already ignored for smoke readiness
  and for attempt `passed` after SMOKE). Default agent idle timeout is **90s**
  (was 10m); override with `HARNESS_AGENT_IDLE_TIMEOUT_MS`.

- **Shared SMOKE→EVALUATE server: `return await withValidatorMcp`.** A bare
  `return withValidatorMcp(...)` inside `try/finally` stopped the harness dev
  server before EVALUATE ran (SMOKE green, then connection refused on `:3000`).
  Matches `validate-semantic`, which already awaited.
- **Per-slice evaluate checklists.** `eval:` accepts a scalar path (same
  checklist every increment) or a list 1:1 with `prd:`. `validate-semantic`
  uses the last slice pair for a completed workspace. Preflight labels list
  paths as `eval[i]` when more than one is configured.

- **Preflight rules are evaluated lazily on the run path.** `run` stops at the
  first failure instead of computing every rule first, so a run aborting on a
  missing recipe file no longer pays for the EVALUATE browser probe (~2.2s warm,
  up to a minute when `@playwright/mcp` is cold). `doctor` still reports all of
  them. `skipToolChecks` now skips rules rather than discarding their results.
- **EVALUATE preflight now triggers on the same condition that runs it.** It
  gated on `spec.validator?.enabled`, while `runValidationStages` gates on
  `isValidatorEnabled()`; the two disagreed for `validator: {}`, which therefore
  skipped preflight and failed after a paid GENERATE.
- **Missing `eval` reports as `eval`, not as a browser failure.** It is recipe
  configuration, so it is no longer filed under the browser probe's id, no
  longer suppressed by `skipToolChecks`, and no longer labelled
  "EVALUATE browser (Playwright MCP)".

- **Claude is the default agent preset.** Recipes that omit `agent:` now select
  Claude instead of Cursor. Explicit `agent: cursor` remains fully supported.
- Dropped `docs/implementation-plan.md` (historical phase notes, not product docs).
- Removed doctor warnings for non-`E*` checklist ids and stale prompt override
  filenames — greenfield recipes use current names; old files are ignored.
- **Shared preflight for `doctor` and `run`.** Host tooling, git-repo usability,
  recipe path presence, and EVALUATE browser checks live in one module so both
  surfaces agree (including package-manager-aware EVALUATE install hints).

## 1.2.2

### Fixed

- Tier 2 and Tier 3 now share the same browser choice. They use an existing
  project-managed Playwright Chromium when available and otherwise launch
  system Chrome. Tier 2 no longer requires a separate Chromium download, and
  Tier 3 no longer passes the undocumented `--browser chromium` MCP channel.
- `validate-semantic` now uses the same agent-specific MCP delivery as a normal
  run: Claude receives a strict harness-owned config path, while Cursor gets a
  temporary workspace config that is restored immediately afterwards.
- Vendoring PRD and contract context no longer leaves a harness-authored MCP
  entry in the project. MCP configuration exists only for the validator
  invocation that needs it.

### Changed

- Browser setup documentation now reflects the actual runtime: Tier 2 needs
  only the Playwright package when system Chrome is available, while Tier 3
  launches the pinned MCP package itself. No separate browser download, MCP
  browser install, or copied `.mcp.json` is required.
- `doctor` reports the browser as the Tier 3 Playwright MCP browser and prints a
  package-manager-aware repair command.

## 1.2.1

Tier 3 could fail at EVALUATE with `Browser "chrome-for-testing" is not
installed` — after a full generator session had already been paid for. Four
defects combined to produce that; all are fixed.

### Fixed

- **Tier 2 and Tier 3 now share one browser.** Tier 2 resolves `playwright` from
  the project; Tier 3 spawned `@playwright/mcp`, which bundles its own Playwright
  and wanted a different chromium revision. The gate could pass while the
  validator had nothing to drive. Tier 3 now points MCP at the browser the
  project already installed, so it needs no download of its own and both tiers
  grade against the same binary. Falls back to the system Chrome channel when
  that browser is unavailable.

- **`@playwright/mcp` is pinned.** It was `@latest`, so a new upstream release
  could change the required browser build with no harness release involved —
  which is exactly what happened on 2026-08-06.

- **`run` preflights the browser.** `doctor` had a check, but `run` never called
  it, and the check was a `--dry-run` that reported "installed" for a browser
  that could not launch. Preflight now starts the MCP server and actually
  navigates: about 2s to pass, under 2s to fail with the real launch error,
  instead of discovering it minutes into a run.

- **A missing browser is classified as infrastructure.** None of the existing
  patterns matched the real error text, so the repair loop spent attempts
  "fixing" application code that was never broken.

- **Playwright MCP session files stay out of the workspace.** The server wrote
  `.playwright-mcp/` into its working directory and nothing ignored or cleaned
  it, so a successful Tier 3 run would leave a dirty tree — which the next run
  refuses to start on. It went unnoticed only because the browser was failing to
  launch.

- **The `install` error names a key v2 recipes have.** A recipe whose baseline
  had commands but none named `install` failed with `extend.baseline must
  include …`; `extend.baseline` was renamed to `baseline` in v2, so the message
  pointed at a key that cannot be present.

### Changed

- The validator is invoked with **`--strict-mcp-config`**, so the harness config
  is authoritative. Previously the CLI also loaded your MCP scopes, and a
  `playwright` server there collided with the harness one — silently deciding
  which browser graded the app. If you relied on the harness picking up MCP
  servers from your own configuration, it no longer does.

## 1.2.0

### Upgrade first, then update recipes

This release introduces **recipe schema v2**. Reading is backward compatible — a
v1 recipe still loads, with deprecation warnings. **Writing is not:** a recipe
saved as v2 cannot be read by 1.1.x, which predates `schemaVersion` and so fails
with a confusing message about a missing field rather than "upgrade the harness".

If you maintain projects that pin the harness, upgrade the pin **before**
migrating their recipes.

```bash
npm install -D hedera-harness@^1.2.0
npx hedera-harness migrate --dry-run   # see what would change
npx hedera-harness migrate             # rewrite in place
```

`migrate` only removes a key when its value equals what the harness would
default it to. Anything you customised is kept and reported.

### Added

- **`doctor`** — preflight everything a run needs and report it all at once:
  node, git, git state, the recipe and its warnings, the agent CLI, the package
  manager, every path the recipe references, optional peer deps for the enabled
  tiers, and `chainValidation` env vars. A real run costs 40 minutes to two
  hours; this costs seconds.
- **`migrate`** — rewrite a pre-v2 recipe in place.
- **Increments.** `prd:` accepts an ordered list, each delivered onto the same
  branch with its own attempt budget and checkpoint commits. A failure stops the
  sequence; `--continue` resumes there.
- **`agent: cursor | claude`** — one line selects the CLI for the whole run,
  including how the validator receives Playwright MCP and which models are used.
  Enabling the semantic tier is now `validator: { enabled: true }`.
- **Findings lifecycle.** Attempts report `2 open, 3 fixed, 1 new` rather than a
  bare count, so a converging run is distinguishable from a thrashing one.
- **Model escalation.** Repairs use the cheaper model, except after an attempt
  that fixed nothing — which escalates back.
- **Prompts as files** under `prompts/`, overridable per project at
  `.harness/prompts/<name>.md`.
- **Environment knobs**: `HARNESS_MAX_ATTEMPTS`, `HARNESS_AGENT_TIMEOUT_S`,
  `HARNESS_MODEL`, `HARNESS_FIX_MODEL`, `HARNESS_NO_MODEL_SWITCH`.
- **`init` adopts an existing project** instead of refusing a non-empty target,
  and never overwrites a recipe that is already there.

### Fixed

- **Repair prompts pointed at files that do not exist.** Two constants shared the
  name `HARNESS_CONTEXT_DIR` with different values; the session repair prompt
  dropped its vendored context and fell back to a path a project run never
  creates. Every repair attempt after the first was reading a missing PRD and
  contract.
- **The Claude semantic tier could not pass.** MCP was injected into
  `.cursor/mcp.json` for every agent — a file Claude does not read — and the
  validator preset withheld MCP tools from `--allowedTools`, so browser calls
  were permission-denied even once the server loaded. Generator and validator
  invocations are now separate; the validator gets browser tools and no edit
  tools, which its own prompt already forbade.
- **Timeouts could not kill what they started.** `executeCommand` signalled the
  shell rather than the process tree and never escalated, so a child ignoring
  SIGTERM hung the run indefinitely.
- **A failed dev-server startup leaked the process group**, holding the port for
  the rest of the session.
- **Unbounded output buffering** — an agent streaming JSON across a 60-minute
  timeout retained all of it in memory.
- **Key material reached run artifacts.** The ephemeral signer's private key was
  written into agent logs (positional redaction only worked when the prompt was
  the last argument) and into persisted validator prompts; `chain-signer.json`
  was `0644`. Logs and prompts are now redacted, and the file is `0600`.
- **The secret scanner walked `.harness/`**, reporting the harness's own signer
  file as a finding against the app under test.
- **Malformed JSON in a generated file crashed the run** instead of producing a
  finding.
- **Deleted modules were still published.** `dist/` was never cleaned, so files
  whose source had been removed continued to ship.
- **`--template hedera-demo`** resolves to the `templates/hedera-demo` branch
  instead of failing.

### Changed

- The recipe is much smaller. `generator`, `logging`, `secretScan`,
  `forbiddenFiles`, validator paths, `prd` and `maxAttempts` are defaulted, and
  `constraints.forbiddenCommands` is derived from the package manager. A working
  recipe is about nine lines.
- `extend.baseline` is now `baseline`. The old spelling still works and warns.
- `logging` is ignored. Harness logs always live under `.harness/runs/` —
  pointing them elsewhere left untracked files that failed the *next* run's
  clean-tree check.
- Unknown top-level recipe keys now warn instead of being silently dropped.
- The attempt loop is four named stages — GENERATE, ASSERT, SMOKE, EVALUATE —
  with explicit short-circuits, so a failing build never pays for a dev server
  boot or an evaluator pass.

### Removed

- The evaluation-harness path: isolated seed-and-run workspaces, the
  blind-integrity oracle audit, and `seed` in the recipe schema. These answered
  a question the project no longer asks — whether an agent could rebuild a known
  template without peeking at it.
