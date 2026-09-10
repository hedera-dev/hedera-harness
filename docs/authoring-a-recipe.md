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

#### `chainValidation.assertions` — deterministic on-chain postconditions

CHAIN proves a real signed transaction landed. It does not, on its own, prove
the app enforced a specific rule for that transaction — a deploy command that
exits `0` is treated as successful regardless of what it actually did
on-chain. `chainValidation.assertions` closes that gap: each entry executes
one signed action and evaluates its outcome **in code**, against real chain
evidence from Mirror Node, independent of EVALUATE's LLM judgment.

Runs once per attempt, right after a successful chain deploy and before the
dev server boots for SMOKE — it needs the app already deployed and the
signer(s), not the browser. A failing assertion short-circuits the rest of
the attempt the same way a failed deploy does.

```yaml
chainValidation:
  # ...enabled/network/operator/fundingHbar/sweepBack/expose as above...
  actors:                          # optional — additional named ephemeral signers
    attacker: { fundingHbar: 5 }   # provisioned like the primary signer, own account
    complianceOfficer: {}          # fundingHbar defaults to chainValidation.fundingHbar
  assertions:
    - id: reject-unverified-transfer   # stable across repair attempts — do not rename to "fix" a finding
      description: "Unverified investor must not receive the bond"
      actor: attacker                  # omit to use the primary chainSigner
      action:
        name: attempt-transfer-to-bob
        command: yarn hardhat run scripts/transfer-to-bob.ts --network hederaTestnet
        timeoutMs: 60000
      expect:
        outcome: mustRevert            # or mustSucceed
        reasonContains: KYC            # optional, only valid with mustRevert
    - id: coupon-balance-delta
      action:
        name: run-coupon
        command: yarn hardhat run scripts/pay-coupon.ts --network hederaTestnet
      expect:
        outcome: mustSucceed
        balanceDelta:
          accountEnv: ALICE_ACCOUNT_ID   # exactly one of account / accountEnv
          asset: hbar                    # or { tokenId: "0.0.x" }, or { contract: "0x..." }
          equals: "500000000"            # signed integer as a string — tinybars for hbar
```

- `id` must be unique per recipe and **stable across repair attempts** — the
  repair loop tracks findings by id (see `findingsLifecycle.ts`); renaming an
  id makes a fix look like a new, unrelated finding instead of a closed one.
- `actor`, if set, must name an entry in `chainValidation.actors` — an
  undeclared actor is a load-time error, not a run-time surprise.
- `expect.reasonContains` only applies to `mustRevert` — rejected at load
  otherwise. **Only meaningfully narrows a revert on the EVM/JSON-RPC-relay path, and only
  when the contract reverts with a standard `require(condition, "message")`** (Solidity's
  `Error(string)` encoding, decoded automatically). A contract that reverts with a **custom
  error** (`error InsufficientKyc(address who);` — the modern, gas-cheaper Solidity pattern,
  and what production contracts including Asset Tokenization Studio's actually use) cannot be
  decoded without that contract's own error ABI, which this mechanism deliberately doesn't
  carry (see `chainAssertionEvidence.ts`'s module comment) — `reasonContains` then falls back
  to matching Mirror Node's coarse status string (`"CONTRACT_REVERT_EXECUTED"`, identical for
  every revert reason on that contract), which will rarely match a specific reason. Omit
  `reasonContains` and rely on `outcome: mustRevert` alone when the contract you're asserting
  against uses custom errors — this is still a real, deterministic pass/fail on whether the
  call reverted at all, just not a policy-specific reason check.
- `expect.balanceDelta` needs exactly one of `account` (a literal id/address) or
  `accountEnv` (an env var read at execution time, e.g. an actor's own
  account) — never both, never neither. For `asset: hbar` or `{tokenId}` this is a Hedera
  account id (`0.0.x`); for `asset: {contract}` it's the holder's **EVM address** (`0x...`),
  since that's what the contract's own `balanceOf` takes.
- `expect.balanceDelta.equals` must be a signed integer string (tinybars for
  `hbar`, smallest unit otherwise) — rejected at load otherwise, so a
  typo like `"5.5e8"` or `"500,000,000"` never reaches evaluation.
- `asset: { contract: "0x..." }` reads the balance via the contract's own standard ERC20
  `balanceOf(address)` — for a Solidity token that lives entirely as contract storage (an
  ERC20/ERC1400-style security token, e.g. an Asset Tokenization Studio bond), **not** a
  native HTS token. This distinction matters: such a holder has **no** entry anywhere in
  Mirror Node's account/token-association data, so `{tokenId}` would silently read `0` for
  every such holder, always — confirmed empirically against a real ATS bond holder (zero
  token associations despite a genuine, real, positive balance). Needs no external JSON-RPC
  relay (Hashio or otherwise) — reads via Mirror Node's own read-only contract-call
  simulation (`/contracts/call`), keeping this mechanism's Mirror-Node-only footprint.

**How the action's outcome is captured.** `action.command` must print the id
of the transaction it submitted somewhere in stdout/stderr, in the form
`0.0.x@seconds.nanos` (the same format the Hedera SDK's own
`transactionId.toString()` produces) — the harness looks for that pattern in
the command's combined output. The command's own exit code is **not** the
verdict: it only distinguishes "the action ran to completion" from "it
didn't" (non-zero exit or a timeout → a `chain-assertion-infra` finding,
since a script that couldn't even finish is not evidence either way). Once a
transaction id is found, the harness independently queries Mirror Node for
that transaction's real consensus result and compares it to `expect` — never
trusting the script's own claim of success.

**Findings.** A mismatch, an unresolvable evidence query, or a config problem
(unknown actor, unset `accountEnv`) each produce one `ValidationFinding`:

| category | meaning | fed to repair? |
|---|---|---|
| `chain-assertion` | confirmed policy mismatch, or a fixable config/script problem | yes |
| `chain-assertion-infra` | evidence couldn't be obtained (Mirror Node lag/outage, action didn't complete) | no — treated like `eval-infra`; an attempt where *every* chain-assertion finding is this category aborts instead of spending a repair attempt on something no agent could fix |

A `chain-assertion` finding's `evidence` field carries the transaction id and
the expected vs. observed values, so the repair prompt (and any consumer of
`report.json`) sees concrete proof, not just a message.

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
