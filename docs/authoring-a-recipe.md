# Authoring a harness recipe

A recipe lives in `.harness/` inside the project it describes — a scaffold-hbar
template branch, or any app you have adopted the harness into. It tells the
harness what to build and how to know it worked.

```
.harness/
  spec.yaml                        the recipe
  prd.md                           what to build
  validators/static.json           file and content assertions
  validators/yarn.json             commands that must pass
  validators/playwright-smoke.yaml SMOKE (optional)
  eval.json                        EVALUATE (optional)
```

## Start here

```bash
hedera-harness init        # adopt the harness in an existing project
hedera-harness doctor      # check the recipe and the host before a long run
```

`init` never overwrites a recipe that already exists, so running it in a
scaffold-hbar template reports what it kept rather than clobbering your work.

To author the PRD and validators with help, install the marketplace plugin:

```
/plugin marketplace add hedera-dev/hedera-skills
/plugin install hedera-harness
/create-harness-spec
```

## The recipe is small on purpose

Everything the harness can default, it defaults. A working recipe is roughly:

```yaml
schemaVersion: 3

name: my-feature
description: What you want the agent to build.

baseline:
  commands:
    - name: install          # required — also used for install fingerprinting
      command: yarn install
    - name: build
      command: yarn next:build
```

Only declare a key when it differs from the default. `generator`,
`secretScan`, `forbiddenFiles`, validator paths, `prd` and `maxAttempts` all
have sensible defaults; `constraints.forbiddenCommands` is derived from your
package manager. The generated skeleton lists every default as a comment, so
you can see the full surface without carrying it.

Pick the agent with one line:

```yaml
agent: cursor        # or omit for claude (default)
```

That governs the whole run — how the generator is invoked, how the validator
receives Playwright MCP, and which models are used. Enabling EVALUATE is then
`validator: { enabled: true }`, not a second copy of the agent flags.

## Baseline vs validators

Two different questions, easy to conflate:

- **`baseline.commands`** — is the *existing* app healthy, before the agent
  touches anything? Runs once, up front. A failure here means the project was
  already broken, and the run stops rather than blaming the agent.
- **`validators/yarn.json`** — does the app pass *after* the agent's changes?
  Runs every attempt.

Name one baseline command `install` — the harness fingerprints dependencies
under that name and skips reinstalling when nothing changed.

## Stages

Each stage costs more and catches more. Start at the bottom; add a stage when
the one below stops catching your failures.

| Stage | What it proves | Cost |
|---|---|---|
| ASSERT (files, static, commands) | the code is present and builds | seconds |
| SMOKE (Playwright gate) | the app boots and its routes render | a dev server boot |
| EVALUATE (evaluate checklist) | the app does what was asked | an agent session |
| CHAIN (chain validation) | on-chain effects really happened | testnet HBAR |

### ASSERT — required

**`validators/static.json`**

- `template.json` name and capabilities match what the PRD asks for
- required docs and package layout
- forbidden paths (`.env`, unused Solidity workspaces)
- README/AGENTS text needles matching *your* yarn scripts

**`validators/yarn.json`**

- lint and a production build, or your template's equivalent
- timeouts generous enough for a cold CI machine
- nothing that needs live secrets

### SMOKE — Playwright gate

```yaml
validators:
  playwright: .harness/validators/playwright-smoke.yaml
```

- `server.command` / `server.url` match how the template starts
- one entry per critical route
- `forbidden.visibleText` for crash banners

Keep it thin. The gate enforces: server up, route reachable, page actually
rendered, no console errors, no forbidden text. **Rich UX checks belong in the
evaluate checklist** — this stage exists to fail fast before paying for an
agent. `playwright` ships with `hedera-harness`; do not add it to the project.
System Chrome is enough for the browser binary.

### EVALUATE — evaluate checklist

```yaml
eval: .harness/eval.json
validator:
  enabled: true
```

Numbered assertions (`E1`, `E2`, …), each with:

- `statement` — what must be true
- `howToVerify` — concrete browser steps
- `severity` — `critical` | `major` | `minor`
- `walletRequired` / `verifiableWithoutCredentials`
- `executableWithTestSigner` when CHAIN should complete a real transaction

Prefer few **critical** assertions: the app loads, the core journey is
possible. This file — not the PRD — is what the validator grades.

The validator is adversarial by design and is told to fail on uncertainty. If
it cannot reach the browser it will say so and fail the assertion rather than
guess, so a passing EVALUATE verdict means something.

A scalar `eval:` path grades every increment with the same checklist. For
true incremental grading, use a list 1:1 with `prd:` (see below).

### CHAIN — on-chain validation

The harness provisions an **ephemeral funded ECDSA testnet account** per run,
injects it as the scaffold burner wallet, and verifies effects against the
**mirror node** rather than UI toasts.

```yaml
chainValidation:
  enabled: true
  network: testnet            # mainnet is rejected by the loader
  operator:
    accountIdEnv: HEDERA_OPERATOR_ID
    privateKeyEnv: HEDERA_OPERATOR_KEY
  fundingHbar: 10
  sweepBack: true
  expose:
    browserLocalStorageKey: burnerWallet.pk
    envVars: []               # e.g. [DEPLOYER_PRIVATE_KEY] for Solidity templates
  # deploy:
  #   commands:
  #     - name: deploy-testnet
  #       command: yarn hardhat:deploy --network hederaTestnet
```

- the operator must be **ECDSA**, not ED25519 — ED25519 has no EVM alias
- export the env vars in your shell; they are never written into the workspace
- `@hiero-ledger/sdk` ships with `hedera-harness`; do not add it to the project
- the template must keep the burner connector enabled so headless signing works
- for Solidity templates, map `expose.envVars` and `deploy.commands` so
  contracts are deployed before the app is graded

Lifecycle: one account per run directory, reused across repair and continue
attempts, best-effort sweep back to the operator at run end.

## Building in increments

For anything larger than a single change, list PRDs in order:

```yaml
prd:
  - .harness/prds/01-foundation.md
  - .harness/prds/02-ui.md
  - .harness/prds/03-onchain.md
```

Each increment is delivered onto the same branch with its own attempt budget
and its own checkpoint commits, and the agent is told which increment it is on
and that earlier ones are already done. A failing increment stops the sequence,
and `--continue` resumes there rather than redoing delivered work.

For true per-increment grading, list evaluate checklists 1:1 with the PRDs:

```yaml
eval:
  - .harness/evals/01-foundation.json
  - .harness/evals/02-ui.json
  - .harness/evals/03-onchain.json
```

Only the active PRD/eval pair is vendored, prompted, and graded each
increment — slice 1 never sees checklist 2. A scalar `eval: .harness/eval.json`
still grades every slice against one shared checklist.

This matters because one large PRD plus three attempts is a poor fit for most
real features: the work is too big for the budget, and a failure discards
everything. Start with the credential-free read path, then layer wallet and
on-chain behaviour as separate increments.

## Accepting a finding

```yaml
waivers: .harness/waivers.yaml
```

```yaml
# .harness/waivers.yaml
waivers:
  - finding: playwright:route:home:console      # exact id, or a prefix pattern ending in *
    reason: Vendor analytics logs a CSP warning; accepted until their fix ships.
    expires: 2026-10-31                         # last day the waiver applies, YYYY-MM-DD
    by: <YOUR_NAME>                             # optional
  - finding: static-required:docs/*
    reason: The docs land in the next increment; this one is the API only.
    expires: 2026-10-15
```

Sometimes a gate is right and you still do not want the agent to act on it
today: a console warning from a script you do not control, a lint rule the
team disagrees with, a file the PRD leaves for a later increment. Without a
place to record that decision, every attempt of every run pays an agent to
"repair" it, and the only escape is to weaken the validator for everyone.

A waiver is that place. It is deliberately small:

- **It names the finding.** The `finding` is the id you see in
  `reports/report.json` and the attempt notes, or a prefix pattern ending in
  `*` for one waiver across the routes of a gate. A pattern cannot start with
  `*`.
- **It says why and until when.** `reason` and `expires` are required. A
  waiver past its date is enforced again on the next attempt, and `doctor`
  warns about it before the run.
- **It changes reporting, not the gate.** A matching finding is still
  produced and still shows in the attempt line (`1 open, 1 waived`), in
  `report.json` (`status: "waived"` with the waiver attached, and
  `waivedFindingIds`), in the run notes, the outro and `validate`. It fails no
  stage and is never written into a repair prompt. It is not counted as
  "fixed" either: nothing in the app changed.
- **Secrets cannot be waived.** A `secret-*` pattern fails at load, and a
  pattern that reaches a `[secret]` finding by accident is ignored with a
  message. `[agent]` and `[eval-infra]` findings are not waivable because they
  are not app defects to begin with.

Waivers apply to every stage: ASSERT, SMOKE and EVALUATE. Keep the file in
git; it is part of the recipe, and the reasons are the review trail.

## Before a full run

A real run costs 40 minutes to two hours, so check cheaply first:

```bash
hedera-harness doctor              # node, git, agent CLI, recipe, every referenced path
hedera-harness validate            # ASSERT only, no agent
hedera-harness validate-semantic   # run EVALUATE only, against a workspace you already have
```

`doctor` reports everything at once rather than stopping at the first problem.

Recipes must declare `schemaVersion: 3`. Older keys such as `contract:` or
`extend:` are rejected at load (`use eval:` / `use baseline:`). Regenerating
with `hedera-harness init` and reapplying edits is the supported path when a
recipe is too far behind.

## Design tips

- Make the first journey work with **no wallet and no `.env`**. If a stranger
  cannot open the app and see something useful, the scope is wrong.
- Write `howToVerify` as steps you could hand to a person. If you cannot, the
  assertion is too vague for an agent too.
- Prefer a small number of assertions that would genuinely embarrass you if
  they failed, over exhaustive coverage that makes every run amber.
- Keep the PRD product-facing. Numbered, browser-verifiable claims belong in
  the evaluate checklist.
