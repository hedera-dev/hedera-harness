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
  validators/playwright-smoke.yaml Tier 2 (optional)
  acceptance-contract.json         Tier 3 (optional)
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
schemaVersion: 2

name: my-feature
description: What you want the agent to build.

baseline:
  commands:
    - name: install          # required — also used for install fingerprinting
      command: yarn install
    - name: build
      command: yarn next:build
```

Only declare a key when it differs from the default. `generator`, `logging`,
`secretScan`, `forbiddenFiles`, validator paths, `prd` and `maxAttempts` all
have sensible defaults; `constraints.forbiddenCommands` is derived from your
package manager. The generated skeleton lists every default as a comment, so
you can see the full surface without carrying it.

Pick the agent with one line:

```yaml
agent: claude        # or: cursor (default)
```

That governs the whole run — how the generator is invoked, how the validator
receives Playwright MCP, and which models are used. Enabling Tier 3 is then
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

## Tiers

Each tier costs more and catches more. Start at the bottom; add a tier when
the one below stops catching your failures.

| Tier | What it proves | Cost |
|---|---|---|
| 0–1 files, static, commands | the code is present and builds | seconds |
| 2 Playwright gate | the app boots and its routes render | a dev server boot |
| 3 acceptance contract | the app does what was asked | an agent session |
| 3.5 chain validation | on-chain effects really happened | testnet HBAR |

### Tier 0–1 — required

**`validators/static.json`**

- `template.json` name and capabilities match what the PRD asks for
- required docs and package layout
- forbidden paths (`.env`, unused Solidity workspaces)
- README/AGENTS text needles matching *your* yarn scripts

**`validators/yarn.json`**

- lint and a production build, or your template's equivalent
- timeouts generous enough for a cold CI machine
- nothing that needs live secrets

### Tier 2 — Playwright gate

```yaml
validators:
  playwright: .harness/validators/playwright-smoke.yaml
```

- `server.command` / `server.url` match how the template starts
- one entry per critical route
- `forbidden.visibleText` for crash banners

Keep it thin. The gate enforces: server up, route reachable, page actually
rendered, no console errors, no forbidden text. **Rich UX checks belong in the
acceptance contract** — this tier exists to fail fast before paying for an
agent.

### Tier 3 — acceptance contract

```yaml
contract: .harness/acceptance-contract.json
validator:
  enabled: true
```

Numbered assertions (`C1`, `C2`, …), each with:

- `statement` — what must be true
- `howToVerify` — concrete browser steps
- `severity` — `critical` | `major` | `minor`
- `walletRequired` / `verifiableWithoutCredentials`
- `executableWithTestSigner` when Tier 3.5 should complete a real transaction

Prefer few **critical** assertions: the app loads, the core journey is
possible. This file — not the PRD — is what the validator grades.

The validator is adversarial by design and is told to fail on uncertainty. If
it cannot reach the browser it will say so and fail the assertion rather than
guess, so a passing Tier 3 verdict means something.

### Tier 3.5 — on-chain validation

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

This matters because one large PRD plus three attempts is a poor fit for most
real features: the work is too big for the budget, and a failure discards
everything. Start with the credential-free read path, then layer wallet and
on-chain behaviour as separate increments.

## Before a full run

A real run costs 40 minutes to two hours, so check cheaply first:

```bash
hedera-harness doctor              # node, git, agent CLI, recipe, every referenced path
hedera-harness validate            # Tier 0–1 only, no agent
hedera-harness validate-semantic   # Tier 3 only, against a workspace you already have
```

`doctor` reports everything at once rather than stopping at the first problem.

## Upgrading an older recipe

Recipes written before schema v2 still load, with deprecation warnings:

```bash
hedera-harness migrate --dry-run   # show what would change
hedera-harness migrate             # rewrite in place
```

A key is only removed when its value equals what the harness would default it
to. Anything you customised — extra forbidden commands, extra secret patterns,
a non-standard validator path — is kept and reported, so the diff is reviewable
rather than trusted.

## Design tips

- Make the first journey work with **no wallet and no `.env`**. If a stranger
  cannot open the app and see something useful, the scope is wrong.
- Write `howToVerify` as steps you could hand to a person. If you cannot, the
  assertion is too vague for an agent too.
- Prefer a small number of assertions that would genuinely embarrass you if
  they failed, over exhaustive coverage that makes every run amber.
- Keep the PRD product-facing. Numbered, browser-verifiable claims belong in
  the contract.
