# Contract Security Validator (ASSERT-stage, opt-in)

> Design spec for a smart-contract security gate in the Hedera Harness.
> Fills the gap between "harness deploys Solidity to Hedera testnet" and
> "harness has zero security analysis of that Solidity." Rides the opt-in
> ASSERT-stage validator pattern proposed for AI-plugin risk in issue #8,
> applied to the harness's *other* untrusted output: generated contracts.

---

## 1. Motivation

The harness generates and deploys Solidity to Hedera testnet
(`solidityFramework`, `contractPath`, `chainValidation.deploy` in
`src/validation/chainSigner.ts`), and ASSERT already aggregates
required/forbidden files, static JSON assertions, secret scanning, and command
validation into native `ValidationFinding` records
(`src/validation/index.ts`). What ASSERT never asks is whether the generated
contract is *safe*. Agent-generated Solidity is exactly where you would expect
reentrancy, missing access control, unchecked external calls, and integer
issues — and the harness happily deploys it.

Issue #8 ("Add an optional HOL Guard validator to the deterministic ASSERT
stage") establishes that the maintainers want an opt-in security scanner in
ASSERT that emits native findings and participates in the repair lifecycle —
but scopes it to AI-plugin / MCP / skill / agent-workspace risk. This validator
is the sibling for the contract domain: same architecture, same lifecycle,
different scanner and different findings. The two are complementary, not
overlapping.

**Behavioral goal:** when enabled, a generated contract with a High/Critical
issue fails ASSERT, becomes a `ValidationFinding` the repair loop must clear,
and never reaches SMOKE / deploy until the agent fixes it.

---

## 2. Where it fits in the pipeline

Attempt stages: `GENERATE → ASSERT → SMOKE → EVALUATE`
(`src/attemptStages.ts`). ASSERT is the cheap authoritative gate; a failing
ASSERT short-circuits the expensive dev-server + adversarial-evaluator stages.

The security scan runs **inside ASSERT**
(`runDeterministicValidation`, `src/validation/index.ts`), **after** the
existing static + secret checks and **before** command validation's expensive
build (or immediately after it — see §6, since Slither may need compiled
artifacts). Rationale mirrors issue #8: keep it in the cheap deterministic gate
so a vulnerable contract never pays for a dev-server boot or an on-chain deploy.

```
runDeterministicValidation
  ├─ validateRequiredFiles
  ├─ validateForbiddenFiles
  ├─ validateStaticConfig
  ├─ validateSecretScan
  ├─ validateContractSecurity   ← NEW (opt-in; no-op unless configured)
  ├─ validateCommands
  └─ (playwright gate, if not shared)
```

---

## 3. Configuration surface

### 3.1 `spec.yaml` (recipe)

Opt-in, mirroring the issue #8 shape so the two validators read consistently:

```yaml
validators:
  contractSecurity:
    enabled: true
    scanners: [slither]        # MVP: slither. Stretch: + foundry-invariant
    failOnSeverity: high       # high | medium | low (default: high)
    contractsDir: packages/foundry   # optional; auto-detected if omitted
    include: ["**/*.sol"]      # optional glob allowlist
    exclude: ["**/test/**", "**/lib/**", "**/node_modules/**"]
    timeoutMs: 240000          # optional; default 4 min
```

Defaults preserve current behavior: absent `contractSecurity` (or
`enabled: false`) means the validator is a no-op and existing recipes are
byte-for-byte unchanged.

### 3.2 Path in the loader

Add to `readValidators` (`src/specLoader.ts:182`). Unlike `static` /
`commands` / `playwright` (which are file paths), this is an inline object, so
it parses like a nested config block rather than via
`readOptionalValidatorPath`:

```ts
return {
  staticPath: /* ... */,
  commandsPath: /* ... */,
  playwrightPath: readOptionalValidatorPath(projectRoot, validators, "playwright"),
  contractSecurity: readContractSecurity(projectRoot, validators), // NEW
};
```

`readContractSecurity` validates types, resolves `contractsDir` via
`resolveProjectPath`, and returns `undefined` when the block is absent or
`enabled !== true`.

---

## 4. Types

Add to `src/types.ts`.

### 4.1 New finding category

```ts
export interface ValidationFinding {
  id: string;
  category:
    | "files"
    | "static"
    | "secret"
    | "commands"
    | "agent"
    | "playwright"
    | "semantic"
    | "semantic-infra"
    | "security";        // NEW
  message: string;
  details?: string;
  status?: "open" | "fixed";   // already used by findingsLifecycle
}
```

### 4.2 Config interface

```ts
export type ContractScanner = "slither" | "foundry-invariant";
export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "informational";

export interface ContractSecurityConfig {
  enabled: boolean;
  scanners: ContractScanner[];
  /** Findings at or above this severity fail the run. Default: "high". */
  failOnSeverity: Exclude<SecuritySeverity, "informational">;
  /** Absolute path (resolved). Auto-detected when omitted. */
  contractsDir?: string;
  include?: string[];
  exclude?: string[];
  timeoutMs?: number;
}
```

Extend `TemplateSpec["validators"]`:

```ts
validators: {
  staticPath: string;
  commandsPath: string;
  playwrightPath?: string;
  contractSecurity?: ContractSecurityConfig;   // NEW
};
```

---

## 5. The Slither adapter

New file: `src/validation/contractSecurity.ts`.

### 5.1 Public entry

```ts
export async function validateContractSecurity(
  workspacePath: string,
  config: ContractSecurityConfig | undefined,
): Promise<{ findings: ValidationFinding[] }> {
  if (!config?.enabled) return { findings: [] };
  const findings: ValidationFinding[] = [];
  for (const scanner of config.scanners) {
    if (scanner === "slither") {
      findings.push(...(await runSlither(workspacePath, config)));
    }
    // "foundry-invariant" — stretch goal, §11
  }
  return { findings };
}
```

### 5.2 Running Slither

Invoke via the same `executeCommand` helper the command validator uses
(`src/command.ts`), so timeout/shell handling is consistent:

```bash
slither <contractsDir> --json - --exclude-informational
```

`--json -` streams a machine-readable report to stdout. Parse
`results.detectors[]`; each detector carries `check` (rule id), `impact`
(High/Medium/Low/Informational), `confidence`, `description`, and
`elements[]` with `source_mapping` (file + lines).

### 5.3 Severity mapping and the gate

Slither `impact` → our severity:

| Slither impact | severity   |
|----------------|------------|
| High           | high       |
| Medium         | medium     |
| Low            | low        |
| Informational  | informational |

`failOnSeverity` gates which become blocking findings. With the default
`high`, only High/Critical-impact detectors produce findings; Medium/Low are
attached to the run log as context but do not fail ASSERT. (Optionally emit
sub-threshold ones as `status: "open"` informational notes without failing —
decide in review; MVP keeps it simple: below threshold = not a finding.)

### 5.4 Slither finding → `ValidationFinding`

Stable, deterministic IDs so the repair-lifecycle delta
(`src/findingsLifecycle.ts`, `computeFindingDelta`) can tell a *fixed* issue
from a *newly introduced* one across attempts:

```
security:<scanner>:<check>:<relpath>:<startLine>
e.g. security:slither:reentrancy-eth:contracts/Vault.sol:42
```

```ts
{
  id: `security:slither:${det.check}:${relPath}:${startLine}`,
  category: "security",
  message: `[${severity.toUpperCase()}] ${det.check} in ${relPath}:${startLine}`,
  details: truncate(det.description),
}
```

The ID must **not** include volatile data (absolute paths, timestamps,
byte offsets) — only stable location so the same unfixed bug keeps the same ID
next attempt and the loop sees it as still-open rather than introduced.

---

## 6. Contract discovery & compilation

Slither needs to resolve imports. Two robustness rules:

1. **Locate contracts.** Use `config.contractsDir` if set. Else auto-detect by
   walking the workspace for a Foundry (`foundry.toml`) or Hardhat
   (`hardhat.config.*`) root, falling back to `spec.contractPath`'s directory.
   If nothing is found and the validator is enabled → infra error (§7), not an
   app finding: the recipe asked for a scan there is nothing to scan.
2. **Compilation.** Prefer letting Slither drive the project's own compiler
   (`slither .` inside a Foundry/Hardhat root compiles via that toolchain). If
   ASSERT's `install` + `build` command already ran, artifacts may exist; if
   Slither must compile and fails to, that is an **infra** result, not a
   vulnerability finding — a contract that does not compile is already caught
   by the command validator's build step.

Reuse the `SCAN_SKIP_DIRS` philosophy from `src/validation/index.ts`: never
scan `lib/`, `node_modules/`, `.harness/`, test mocks.

---

## 7. Tool-failure vs app-finding (the issue #8 rule)

Issue #8 is explicit: a missing scanner or malformed scanner output is a
**harness/infra** problem, never an app "repair" finding. Asking the coding
agent to "fix" a vulnerable contract when the real problem is that `slither`
isn't installed sends the repair loop chasing a ghost.

Implementation:

- **Scanner binary missing / non-parseable JSON / crash unrelated to the
  contract** → throw a typed `ContractSecurityInfraError`. ASSERT surfaces it
  the way `chainSigner` surfaces provisioning errors: abort with a clear
  message, do not feed it into the repair loop. `doctor` (§8) pre-empts this
  before a long run.
- **Scanner ran, found issues** → normal `ValidationFinding`s in the repair
  lifecycle.
- **Scanner ran, clean** → no findings, ASSERT proceeds.

---

## 8. `doctor` integration

`doctor` already gates optional deps before a long run
(`checkOptionalDeps`, `checkChainEnv` in `src/doctor.ts`). Add a check that,
**only when `contractSecurity.enabled`**, verifies each configured scanner is
on PATH:

```ts
async function checkContractSecurity(spec, cwd): Promise<DoctorCheck[]> {
  const cfg = spec.validators.contractSecurity;
  if (!cfg?.enabled) return [];
  const checks: DoctorCheck[] = [];
  if (cfg.scanners.includes("slither")) {
    checks.push(await checkCommand("slither --version", cwd,
      "Required by validators.contractSecurity (scanner: slither). Install: pipx install slither-analyzer"));
  }
  return checks;
}
```

Wire into `runDoctor` alongside the other optional-dep checks. Status `fail`
when enabled-but-missing, so `doctor` turns a mid-run abort into a
pre-run message.

---

## 9. Integration checklist (exact touch points)

| # | File | Change |
|---|------|--------|
| 1 | `src/types.ts` | add `"security"` to `ValidationFinding.category`; add `ContractScanner`, `SecuritySeverity`, `ContractSecurityConfig`; extend `validators` |
| 2 | `src/specLoader.ts:182` | add `contractSecurity` to `readValidators` + `readContractSecurity` parser/validator |
| 3 | `src/specDefaults.ts` | `DEFAULT_FAIL_ON_SEVERITY = "high"`, `DEFAULT_SECURITY_TIMEOUT_MS` |
| 4 | `src/validation/contractSecurity.ts` | **new** — Slither adapter, severity map, ID builder, infra error |
| 5 | `src/validation/index.ts` | call `validateContractSecurity` in `runDeterministicValidation` after secret scan |
| 6 | `src/doctor.ts` | `checkContractSecurity` + wire into `runDoctor` |
| 7 | `skeletons/project-harness/spec.yaml` | documented commented-out example block |
| 8 | `test/contract-security.test.mjs` | **new** — unit tests (§10) |
| 9 | `docs/` + `README.md` + `CHANGELOG.md` | this doc, a validators-section paragraph, changelog entry |

No changes to GENERATE, SMOKE, EVALUATE, or the run/repair driver — findings
flow through the existing `ValidationResult` → lifecycle machinery unchanged.

---

## 10. Test plan

`node --test` (matches existing `test/*.test.mjs`). No network, no real
Slither in CI — feed the adapter **captured Slither JSON fixtures**:

1. **Parse + map** — fixture with one High reentrancy detector → one
   `category: "security"` finding, severity high, correct stable ID.
2. **Threshold** — same fixture with `failOnSeverity: "high"` and a
   Medium-only fixture → Medium produces **no** blocking finding.
3. **ID stability** — same detector parsed twice → identical ID (guards the
   lifecycle delta).
4. **Disabled** — `enabled: false` / absent → `{ findings: [] }`, zero side
   effects (proves default recipes unchanged).
5. **Infra** — malformed JSON / empty stdout → throws
   `ContractSecurityInfraError`, not a finding.
6. **Loader** — `spec.yaml` with the block resolves `contractsDir`; bad types
   throw the expected loader error.

Keep real-Slither execution to the demo, not CI (Slither install is heavy).

---

## 11. Scope: hackathon MVP vs stretch

**MVP (ship this first — self-contained, demoable, mergeable):**
- Slither scanner only
- `enabled`, `scanners`, `failOnSeverity`, `contractsDir`
- ASSERT integration + native findings + repair lifecycle
- `doctor` check
- fixture-based tests + skeleton spec + docs

**Stretch (only if time; each is independent):**
- `foundry-invariant` scanner: run `forge test` invariant/property suites,
  surface counterexamples as `security` findings. This is your core edge — an
  invariant break is a far stronger signal than a linter hit — but it needs a
  contracts project with a test suite, so gate it behind explicit config.
- Sub-threshold findings as non-blocking informational notes in the run log.
- A second recipe/skeleton that ships a deliberately-vulnerable contract so the
  demo shows the loop *catching and repairing* it end-to-end.

---

## 12. Demo & PR narrative (for judging)

**The 5-min video, one continuous take:**
1. Recipe with a Foundry contract containing a planted reentrancy /
   missing-access-control bug, `contractSecurity.enabled: true`.
2. Run the harness. GENERATE writes the contract. **ASSERT fails** with a
   `security:slither:...` finding — before any deploy.
3. Repair attempt: agent gets the finding, fixes the contract, ASSERT passes,
   run proceeds to deploy. Show the run log's open→fixed delta.
4. One line on the architecture: "same opt-in ASSERT-validator pattern issue #8
   proposed for plugin risk, applied to the contracts the harness actually
   deploys."

**Why it wins the "Improve the Hedera Harness" track:** contribution over
greenfield (extends the existing gate), fills a real gap (deployed contracts
had no security gating), rides a maintainer-blessed pattern without duplicating
issue #8, and sits on the hot AI-codegen × security intersection. Link issue #8
in the PR as prior art for the pattern.
