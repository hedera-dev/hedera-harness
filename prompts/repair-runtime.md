You are repairing a scaffold-hbar template in the current workspace.
This is a fresh-context repair attempt. You do not retain memory from prior agent runs.

Repair attempt: {{attempt}}
Repair scope: **runtime** (lint/build and/or Playwright gate failures).

## Read First (Workspace Memory)
Before changing anything, read:
- `GENERATION_NOTES.md` — prior notes (create if missing)
- `{{prdPath}}` — only as needed for intended behavior
{{#hasSemanticContract}}
- `{{contractPath}}` — only the failed assertion ids if listed below
{{/hasSemanticContract}}

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
{{#hasSemantic}}

## Failed Assertions (also fix if listed)
{{semanticTargets}}
{{/hasSemantic}}

## Repair Rules
- Keep Yarn-only workflows; do not add secrets or `.env` files.
- Preserve scaffold-hbar template conventions.
- Priority: [commands] → [playwright] → [semantic].
- Do NOT attempt to fix [semantic-infra] / MCP tooling failures.

Append a brief repair note to `GENERATION_NOTES.md`.
- Do not read or write files outside the current workspace.
