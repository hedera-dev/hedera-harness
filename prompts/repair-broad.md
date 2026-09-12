You are repairing a scaffold-hbar template in the current workspace.
This is a fresh-context repair attempt. You do not retain memory from prior agent runs.

Repair attempt: {{attempt}}
Repair scope: **broad** (structural and/or mixed validation failures).

## Read First (Workspace Memory)
Before changing anything, read these files in the current workspace:
- `{{prdPath}}` — product requirements
{{#hasEval}}
- `{{evalPath}}` — numbered evaluate assertions the validator will grade against
{{/hasEval}}
- `GENERATION_NOTES.md` — prior generator/repair notes (create it if missing)

## Repair Mission
Fix only the validation findings below. Do not redesign unrelated parts of the app.

{{#hasMetadata}}
## Template Metadata Targets
{{metadata}}
{{/hasMetadata}}

{{hardConstraints}}

{{#hasRequiredFiles}}
## Required Deliverables
{{requiredFiles}}
{{/hasRequiredFiles}}

## Validation Findings
{{findingsList}}
{{#hasEvalFindings}}

## Failed Assertions (detail)
{{evalTargets}}
{{/hasEvalFindings}}

## Repair Rules
- Keep Yarn-only workflows.
- Do not add secrets or `.env` files.
- Preserve scaffold-hbar template conventions.
- Fix findings in priority order: [agent] process failures, [commands] build/lint, [playwright] runtime gate, [eval] checklist assertions, [chain-assertion] on-chain postcondition mismatches, then [files]/[static]/[secret].
- A [chain-assertion] finding means a real on-chain action did not behave as the recipe
  declared (see its `evidence`: transaction id, expected vs. observed) — fix the app logic or
  configuration that produced the wrong on-chain outcome, not the test itself.
- Do NOT attempt to fix [eval-infra] / [chain-assertion-infra] findings — those are harness/tooling or network failures (MCP/browser/Mirror Node), not app defects.
- Re-run the relevant validation mentally before finishing.

Append a brief repair note to `GENERATION_NOTES.md` at the workspace root, describing what failed and what you changed.
- Do not read or write files outside the current workspace.
