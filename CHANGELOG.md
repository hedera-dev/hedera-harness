# Changelog

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
