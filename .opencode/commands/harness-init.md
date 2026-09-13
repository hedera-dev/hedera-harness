---
description: Bootstrap the workspace (scaffold + yarn) if it is not harness-ready yet
agent: hedera-orchestrator
---

INIT / prepare gate. Invoke @hedera-init (or `harness_ensure_init`) before any GENERATE work.

That clones or adopts if `.harness/spec.yaml` is missing. Yarn already ran during `tui install` (terminal, no timeout). Never bash `yarn install` inside OpenCode.

Do not init the hedera-harness CLI repo itself.

$ARGUMENTS
