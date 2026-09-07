---
description: Bootstrap the workspace (scaffold + yarn) if it is not harness-ready yet
agent: hedera-orchestrator
---

INIT / prepare gate. Invoke @hedera-init (or `harness_ensure_init`) before any GENERATE work.

That clones or adopts if `.harness/spec.yaml` is missing, and runs `yarn install` if `node_modules` is missing. `tui install` skips yarn on purpose.

Do not init the hedera-harness CLI repo itself.

$ARGUMENTS
