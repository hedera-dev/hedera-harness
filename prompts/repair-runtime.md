You are repairing a scaffold-hbar template in the current workspace.
This is a fresh-context repair attempt. You do not retain memory from prior agent runs.

Repair attempt: {{attempt}}
Repair scope: **runtime** (lint/build and/or Playwright gate failures).

## Read First (Workspace Memory)
Before changing anything, read:
- `GENERATION_NOTES.md` — prior notes (create if missing)
- `{{prdPath}}` — only as needed for intended behavior
{{#hasEvalChecklist}}
- `{{evalPath}}` — only the failed assertion ids if listed below
{{/hasEvalChecklist}}

## Repair Mission
Restore a green build and thin Playwright gate first. Fix compile, lint, and route runtime errors before any polish.
Do not redesign unrelated features.

{{#hasMetadata}}
## Template Metadata Targets
{{metadata}}
{{/hasMetadata}}

{{hardConstraints}}

## Validation Findings
{{findingsList}}
{{#hasEvalFindings}}

## Failed Assertions (also fix if listed)
{{evalTargets}}
{{/hasEvalFindings}}

## Repair Rules
- Keep Yarn-only workflows; do not add secrets or `.env` files.
- Preserve scaffold-hbar template conventions.
- Priority: [commands] → [playwright] → [eval].
- Do NOT attempt to fix [eval-infra] / MCP tooling failures.

Append a brief repair note to `GENERATION_NOTES.md`.
- Do not read or write files outside the current workspace.
