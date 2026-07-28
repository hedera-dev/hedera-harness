# Authoring a new template benchmark

Use this checklist when adding a **novel** Hedera demo to the harness — your own product idea, not a fork of the examples.

Copy the skeletons, fill in placeholders, then smoke-test before a full `run`. Optional: skim the example PRDs under [`docs/prds/`](prds/) for depth and structure.

## Copy the skeleton

```bash
NAME=my-hedera-demo   # kebab-case slug

cp skeletons/new-template/prd.md              docs/prds/${NAME}.md
cp skeletons/new-template/spec.yaml           specs/${NAME}.yaml
cp skeletons/new-template/acceptance-contract.json contracts/${NAME}-acceptance.json
cp skeletons/new-template/static.json         validators/${NAME}-static.json
cp skeletons/new-template/yarn.json           validators/${NAME}-yarn.json
cp skeletons/new-template/playwright-smoke.yaml playwright/${NAME}-smoke.yaml

# Align internal paths / names with $NAME (macOS; on Linux drop the '').
sed -i '' "s/my-template/${NAME}/g" \
  specs/${NAME}.yaml \
  validators/${NAME}-static.json \
  validators/${NAME}-yarn.json \
  contracts/${NAME}-acceptance.json \
  playwright/${NAME}-smoke.yaml
```

Then fill remaining `REPLACE_ME` stubs (description, routes, PRD prose). `seed.repo` already defaults to the public scaffold-hbar remote.

## Checklist

### 1. PRD (`docs/prds/…`) — required

- [ ] Product goal in one paragraph
- [ ] User journeys (read path without wallet; wallet-gated actions called out)
- [ ] Hedera services involved (HCS, HTS, etc.)
- [ ] Non-goals (e.g. no Hardhat, no live keys required to browse)
- [ ] Deliverables expected in the workspace (`template.json`, README, routes, …)

Example PRDs in this folder are **inspiration only**. Put private WIP under `docs/prds/local/` (gitignored) if you do not want it tracked.

### 2. Spec (`specs/….yaml`) — required

- [ ] `name`, `prd` path
- [ ] `seed.repo` / `seed.ref` → public scaffold-hbar by default; override for a local clone if you prefer
- [ ] `generator` block (examples use Cursor `agent` + `--workspace "{workspace}"` + stream-json; pin `--model` for your agent CLI — examples use `composer-2.5`; omit to use the CLI default)
- [ ] `validators.static` + `validators.commands`
- [ ] `requiredFiles` / `forbiddenFiles` / optional `secretScan` / `constraints`
- [ ] Optional `skills:` names from `skills-index.json` (defaults to [hedera-dev/hedera-skills](https://github.com/hedera-dev/hedera-skills) via remote fetch; absolute/`./` paths still work); add missing skills to the index if the agent would benefit
- [ ] Optional Tier 2: `validators.playwright`
- [ ] Optional Tier 3: `contract` + `validator` (see flags below)

**Tier 3 validator flags that usually work headless:**

```yaml
validator:
  enabled: true
  provider: command
  command: agent
  args:
    - -p
    - --trust
    - --force
    - --sandbox
    - disabled
    - --approve-mcps
    - --workspace
    - "{workspace}"
    - --model
    - composer-2.5
    - --output-format
    - stream-json
    - --stream-partial-output
```

### 3. Static validator (`validators/*-static.json`) — required

- [ ] `template.json` name / capabilities match what the PRD asks for
- [ ] Required docs and package layout
- [ ] Forbidden paths (`.env`, unused Solidity workspaces if applicable)
- [ ] README/AGENTS text needles that match *your* yarn scripts

### 4. Command validator (`validators/*-yarn.json`) — required

- [ ] `yarn install` first (name the command `install` so fingerprint skip works across attempts)
- [ ] Lint + production build (or your template’s equivalent)
- [ ] Timeouts generous enough for cold CI machines
- [ ] No commands that need live secrets

### 5. Playwright smoke (`playwright/*-smoke.yaml`) — Tier 2

- [ ] `server.command` / `server.url` match how the template starts (often `yarn next:dev`)
- [ ] One entry per critical route
- [ ] `forbidden.visibleText` for crash banners
- [ ] Keep this thin — rich UX checks belong in the acceptance contract

The harness Playwright gate currently enforces: server up, route HTTP success, console errors (if enabled), and forbidden visible text. Extra YAML `assertions` blocks are documentation for humans / future use; **Tier 3 owns deep UX**.

### 6. Acceptance contract (`contracts/*-acceptance.json`) — Tier 3

- [ ] `routes` list matches the app
- [ ] Numbered assertions (`C1`, `C2`, …) with:
  - `statement` — what must be true
  - `howToVerify` — concrete browser steps
  - `severity`: `critical` | `major` | `minor`
  - `walletRequired` / `verifiableWithoutCredentials`
  - `executableWithTestSigner` when Tier 3.5 should complete a real tx
- [ ] Prefer few **critical** assertions (app loads, core journey possible)
- [ ] Wallet flows without a test signer: assert affordances and messaging; with `chainValidation` + `executableWithTestSigner`, require end-to-end tx + mirror evidence
- [ ] This file — not the PRD — is what the semantic agent grades

### 7. On-chain validation / Tier 3.5 (`chainValidation` in the spec) — optional

When enabled, the harness provisions an **ephemeral funded ECDSA testnet account** per run, injects it as the scaffold burner wallet, and lets the semantic validator complete `executableWithTestSigner` assertions. Effects are verified against the **mirror node** (not just UI toasts).

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
  # deploy:                   # optional pre-validation commands (contract templates)
  #   commands:
  #     - name: deploy-testnet
  #       command: yarn hardhat:deploy --network hederaTestnet
  #       timeoutMs: 300000
```

Checklist:

- [ ] Host has a funded **ECDSA** testnet operator (not ED25519 — no EVM alias)
- [ ] `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` exported in the shell (never written into the workspace)
- [ ] Contract assertions that need a real tx set `executableWithTestSigner: true`
- [ ] Template keeps the burner connector enabled (`enableBurnerWallet: true`, burner in `wagmiConnectors`) so headless signing works
- [ ] For Solidity templates: map `expose.envVars` + `deploy.commands` so contracts are deployed before the app is graded; add a static-validator text needle on `wagmiConnectors.tsx` / `scaffold.config.ts` if you want to enforce burner support

Lifecycle: create account once per run directory → reuse across repair/continue attempts → best-effort `AccountDeleteTransaction` sweep back to the operator at run end (`sweepBack: true`). `validate-semantic` reuses the signer and does not sweep.

### 8. Host prerequisites

- [ ] `npm install` in the harness repo
- [ ] `agent` on `PATH` and authenticated
- [ ] Tier 2: `npx playwright install chromium`
- [ ] Tier 3: Playwright MCP usable headless (harness vendors MCP into the workspace)
- [ ] Tier 3.5 (if `chainValidation.enabled`): funded ECDSA testnet operator env vars

## Smoke before a full run

Prefer validating config cheaply before burning a generator attempt:

```bash
# After you have any workspace (seeded run dir, or a hand-edited scaffold):
npm run harness -- validate specs/${NAME}.yaml --workspace runs/<id>/workspace

# Tier 3 only (needs contract + validator in the spec):
npm run harness -- validate-semantic specs/${NAME}.yaml --workspace runs/<id>/workspace
```

Then:

```bash
npm run harness -- run specs/${NAME}.yaml --max-attempts 3
```

## Iterate on one project

After the first kick, keep working in the **same** run directory:

```bash
# 1. Edit docs/prds/<name>.md and contracts/<name>-acceptance.json (and validators if needed)
# 2. Continue with a fresh attempt budget — workspace is NOT re-seeded
npm run harness -- run specs/${NAME}.yaml --continue runs/<run-id> --max-attempts 3
```

Each continue kick:

- Re-vendors PRD, contract, skills, and Playwright MCP into the workspace
- Starts with a **continue prompt** (improve existing app; do not rebuild from scratch)
- Uses scoped **repair prompts** on failures within the cycle
- Appends logs/prompts under the same `runs/<id>/`
- Writes `reports/cycle-N.json` plus updates `reports/report.json`

## Design tips for novel demos

1. **Write the contract from the PRD journeys**, not from an existing template’s file list.
2. **Keep Tier 2 thin** (boots + routes). Put product semantics in Tier 3.
3. **Align `template.json` capabilities** with `forbiddenFiles` / Solidity constraints so static checks match the PRD.
4. **One primary package manager story** (Yarn workspaces for scaffold-hbar).
5. **Fail closed on uncertainty** in contract `evaluationRules` — absence of evidence is a fail.
6. **Repair is scoped** — if only semantic assertions fail, the next attempt gets those `C#` ids + `statement` / `howToVerify` instead of a full re-brief. Prefer clear assertion ids (`C1`, `C2`, …) in the contract.

## Skeleton map

| Skeleton file | Copy to |
|---------------|---------|
| [`skeletons/new-template/prd.md`](../skeletons/new-template/prd.md) | `docs/prds/<name>.md` |
| [`skeletons/new-template/spec.yaml`](../skeletons/new-template/spec.yaml) | `specs/<name>.yaml` |
| [`skeletons/new-template/acceptance-contract.json`](../skeletons/new-template/acceptance-contract.json) | `contracts/<name>-acceptance.json` |
| [`skeletons/new-template/static.json`](../skeletons/new-template/static.json) | `validators/<name>-static.json` |
| [`skeletons/new-template/yarn.json`](../skeletons/new-template/yarn.json) | `validators/<name>-yarn.json` |
| [`skeletons/new-template/playwright-smoke.yaml`](../skeletons/new-template/playwright-smoke.yaml) | `playwright/<name>-smoke.yaml` |
