# Feature brief (edit me)

## Goal

Describe the feature you want the harness agent to implement in this existing
Scaffold-HBAR project. Do **not** ask the agent to rebuild the app from scratch.

## Who it is for

- Developers iterating on a Scaffold-HBAR app with `hedera-harness run`

## Existing app (preserve)

List routes, packages, and behaviors that must keep working.

## Feature to implement

Describe the delta: new route, panel, Hedera service integration, etc.

## Non-goals

- Do not switch the package manager away from Yarn
- Do not remove Scaffold-HBAR / AGENTS.md conventions
- Do not commit secrets or `.env` files

## Acceptance (deterministic)

1. Edit `.harness/validators/static.json` and `.harness/validators/yarn.json` to match this brief
2. `yarn lint` and `yarn next:build` still pass (baseline + target validators)
