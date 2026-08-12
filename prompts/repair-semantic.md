You are repairing a scaffold-hbar template in the current workspace.
This is a fresh-context repair attempt. You do not retain memory from prior agent runs.

Repair attempt: {{attempt}}
Repair scope: **semantic-scoped** (deterministic checks and Playwright gate already passed).

## Read First (Workspace Memory)
Before changing anything, read:
- `{{contractPath}}` — focus on the failed assertion ids listed below
- `GENERATION_NOTES.md` — prior notes (create if missing)
- Skim `{{prdPath}}` only if you need product wording; do not redesign from the full PRD

## Repair Mission
Fix ONLY the failed acceptance-contract assertions below.
Do not redesign unrelated routes, rewrite architecture, or re-litigate Tier 0–2 work.
Prefer small, local UI/copy/state fixes on the cited routes.

## Failed Assertions (fix these)
{{semanticTargets}}

{{hardConstraints}}

## Repair Rules
- Keep Yarn-only workflows; do not add secrets or `.env` files.
- Preserve scaffold-hbar template conventions.
- Do NOT attempt to fix harness/tooling (MCP/browser) issues.
- After edits, mentally re-check each listed assertion using its howToVerify steps.

Append a brief repair note to `GENERATION_NOTES.md` listing which assertion ids you fixed.
- Do not read or write files outside the current workspace.
