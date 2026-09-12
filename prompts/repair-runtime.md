You are repairing a scaffold-hbar template in the current workspace.
This is a fresh-context repair attempt. You do not retain memory from prior agent runs.

Repair attempt: {{attempt}}
Repair scope: **runtime** (lint/build, Playwright gate and/or x402 gate failures).

## Read First (Workspace Memory)
Before changing anything, read:
- `GENERATION_NOTES.md` — prior notes (create if missing)
- `{{prdPath}}` — only as needed for intended behavior
{{#hasEvalChecklist}}
- `{{evalPath}}` — only the failed assertion ids if listed below
{{/hasEvalChecklist}}

## Repair Mission
Restore a green build and thin Playwright gate first. Fix compile, lint, and route runtime errors before any polish.
[x402] findings mean a paywalled route is not speaking x402 correctly: an unpaid request must answer HTTP 402 with a base64 `PAYMENT-REQUIRED` header (x402 v2), every `accepts[]` entry must be scheme `exact` on the expected Hedera network with `amount` in whole tinybars / smallest units, `asset` `0.0.0` (HBAR) or an HTS token id, `payTo`, and `extra.feePayer`, and a forged `PAYMENT-SIGNATURE` must be rejected with 402, never served or crashed on.
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
- Priority: [commands] → [playwright] → [x402] → [eval].
- Do NOT attempt to fix [eval-infra] / MCP tooling failures.

Append a brief repair note to `GENERATION_NOTES.md`.
- Do not read or write files outside the current workspace.
