---
description: Show latest harness run status without printing wallet keys
agent: hedera-orchestrator
---

Report the latest hedera-harness run.

Use the `harness_latest_run` tool if available. Otherwise look under `.harness/runs/` (and `demo-app/.harness/runs/` if present) for the newest `status.json`. Summarize stage, attempt, pass/fail. Do not dump secrets or private keys.

$ARGUMENTS
