# Changelog

## Unreleased

### Added

- **OpenCode TUI overlay** (`hedera-harness tui install|uninstall`): copies `opencode.json` + `.opencode/` into a project. `tui install` clones/adopts the scaffold when `.harness/spec.yaml` is missing, copies the overlay, then runs **`yarn install` with no timeout** in that terminal. Open OpenCode only after yarn finishes. The init `.harness/prd.md` (“edit me”) is a skeleton (`harness_prd_status`). Natural language starts the loop. Default wallet path is **RainbowKit / EVM / WalletConnect** (scaffold-hbar); HIP-820 HashPack native is optional, not the done bar. **Test MetaMask vault (beta — persistent test wallet for token flows such as USDC, not the human done bar):** `hedera-harness wallet provision` (plugin opens http://127.0.0.1:17373/) for a TESTNET key + password — never chat; `wallet status` reports ready without secrets; `harness_wallet_gate` must be `gate=ok` before PRD/GENERATE (even if INIT was skipped); `wallet browser` uses [dappwright](https://github.com/TenKeyLabs/dappwright) to download MetaMask, import the vault key, add Hedera Testnet (chain 296), and reuse `.harness/wallet/chrome-profile/` (unlock next time). Does not write `~/.config/opencode`. See `docs/plans/2026-09-06-opencode-hedera-tui.md`.
- **GENERATE work units:** after PRD, `hedera-prd` writes `.harness/tasks.md` (T1…). The orchestrator spawns `hedera-generate` once per pending checkbox; ASSERT runs once after all units. Missing `tasks.md` still means one GENERATE for the whole brief.
- **Playwright MCP** (`hedera-harness mcp status|enable|install`): optional **UI** pass (vanilla Chrome, **no** MetaMask). Not wallet E2E. `disabled` → enable the existing entry; `missing` → question install vs skip. Install writes **project** `opencode.json` only.
- **Stage bash allowlist:** OpenCode subagents (`hedera-assert`, `hedera-generate`, `hedera-smoke`, …) now `allow` obligated `yarn`/`npm`/`node dist/index.js` commands (plus `head`/`tail`/`echo` wrappers) so Automatic mode is not blocked by permission prompts. `yarn next:dev` stays denied on INIT/GENERATE/ASSERT/EVALUATE.
- **Contract scope:** PRD/tasks `Contracts: none` (default, payments/HCS/x402) vs `solidity`. When solidity, `ContractBase:` (`token` | `nft` | `escrow` | `payroll` | `vesting` | `governor` | `hts` | `custom`) names the shape. GENERATE starts from that base via OpenZeppelin MCP, then customizes the interview. TUI ASSERT skips root `yarn lint` and Hardhat unless solidity. Seed `packages/hardhat` is left untouched, not deleted.
- **OpenZeppelin Contracts MCP:** overlay `opencode.json` ships remote `openzeppelin-solidity` (`https://mcp.openzeppelin.com/contracts/solidity/mcp`) **disabled** (`enabled: false`), same token-saving pattern as Playwright. Enabled MCP schemas are injected at session start even if unused. `harness_tasks_status` (and `harness_oz_mcp enable`) flips it on when `Contracts: solidity` and the base is not `hts`. GENERATE in that same session may still use `@openzeppelin/contracts` until a new OpenCode session. Official CLI had no OpenZeppelin path — only an HTS-precompile example PRD. Skill `harness-contracts`.
- **Hedera Docs MCP:** overlay `opencode.json` ships remote `hedera-docs` (`https://docs.hedera.com/mcp`, `SearchHedera`). Project-scoped, not `~/.config/opencode`. Agents **must** call `SearchHedera` before any Hedera `websearch`. Web on `docs.hedera.com` only if MCP is missing or the call failed — “prefer” / “don’t stall” was letting GENERATE skip it.

- **Existing HTS tokens:** plugin `harness_tokens` (`lookup` / `convert` / `remember`). Built-in Circle testnet USDC plus `.harness/tokens.json`. GENERATE bakes `evm=`; never invents a `0x`.
- **E2E UI contract (beta vault path)** (`.harness/e2e.json`, plugin `harness_e2e_contract status|set`, skill `harness-e2e-contract`): GENERATE records the route plus the `data-testid` of destination / amount / submit / tx hash and how many MetaMask popups the flow raises. EVALUATE and `harness_wallet_e2e` read that contract so the **beta** persistent test wallet can drive any app (USDC sender on `/`, not only seed `/payments`). Fields also resolve by `id` or `name`.

### Fixed

- **Wallet E2E only knew the seed `/payments` form.** `harness_wallet_e2e` hardcoded `/payments`, `pay-to`, `pay-amount`, `pay-send`, so a dApp that ships its send form anywhere else failed at `pay_form=missing-fields` and the agent fell back to Playwright MCP (vanilla Chrome, no extension) and hung on the MetaMask password. The runner now drives the `.harness/e2e.json` contract, honors `confirmations=2` for approve-then-execute, and says which route/testid was missing.
- **A locked `chrome-profile` piled up dead launches on :17374.** `harness_wallet_session start` returned `session=hung` after one try, and the agent asked the human to close Chrome instead of retrying. `start` now kills the profile holders and relaunches itself (two attempts) before reporting hung, and the prompts forbid asking the human to close Chrome or switching to Playwright MCP.
- **INIT `yarn install` froze OpenCode.** Yarn now runs in **`tui install`** after clone + overlay, in a real terminal, **with no timeout**. OpenCode never installs deps (plugin only reports `yarn=skip|missing`). Overlay `watcher.ignore` excludes `node_modules`.
- **`tui install` yarn died in 2s on Yarn Berry.** `--non-interactive` is a Yarn 1 flag; scaffold-hbar (Yarn 3) prints `YN0050` and exits 1. Command is now plain `yarn install`.
- **GENERATE left testnet USDC as an empty env var.** Hedera Docs MCP covers HIP-218, not Circle’s token id. `harness_tokens` caches USDC and, on `token=lookup`, GENERATE SearchHedera → webfetch issuer → convert `0.0.x` → remember `.harness/tokens.json` → bake `evm=`. Playwright MCP is not MetaMask (password unlock belongs on `harness_wallet_session`).
- **Wallet provision page (`127.0.0.1:17373`) actually listens.** The OpenCode plugin spawned `process.execPath` (often `opencode.exe`) instead of Node, so the gate printed a URL with nothing bound. It now runs `node dist/index.js wallet provision`, probes until HTTP 200, and only then tells the human to open the page.
- **Wallet gate after a successful save.** Provision shuts the local page when the vault is written, so `server=down` is expected. The plugin treats `.harness/wallet/metamask-test.json` (size-only, never read) as `gate=ok`, and `wallet status` remaps the hedera-harness CLI repo to `test-app` when that is where the vault lives.
- **OpenCode plugin tools no longer `spawnSync node` for status/tasks/mcp.** Those imports `dist/*.js` in-process (the ETIMEDOUT the orchestrator hit). Playwright MCP `install` **enables** an existing disabled global entry instead of writing a second project copy.
- **Wallet E2E opened the MetaMask extension tab as the dapp.** That produced Next.js SSR HTML without `_next` CSS/JS (unstyled Connect, Payments `<a>` still worked). Retry then failed to fill the MetaMask unlock field. E2E now `newPage()`s the dapp, waits for load/chunks, probes `localhost` and `127.0.0.1`, and unlocks with password locators — not an old-Next bug. HIP-820 “no extension wallet” is HashPack, not MetaMask.
- **`nohup yarn next:dev` stacked servers.** `nohup` survives the SMOKE subagent, keeps 3000, the next loop binds 3001, two Next processes share `.next` → CSS 404. SMOKE must `harness_dev_serve` (tracked PID in `.harness/dev-server.json`): reuse if healthy, else kill this app’s leftover `next:dev` then start one. `nohup` is denied. ASSERT is lint-only; stop that PID before the production `yarn next:build` stamp.
- **RainbowKit burner auto-connect hid Connect Wallet.** `burner-connector` starts `connected = true`, so E2E saw CONNECTED ADDRESS (gift box) and never opened MetaMask. E2E now disconnects that burner in-session (no reload), opens Connect → MetaMask, then `/payments` with to/amount + Send. App default is `enableBurnerWallet` off unless `NEXT_PUBLIC_ENABLE_BURNER=true`.
- **MetaMask E2E stuck on “Opening MetaMask…”** when a leftover Chromium still held `.harness/wallet/chrome-profile` or leftover `chrome-extension://` tabs ate the approval popup. Launch now kills that profile’s Chromium, does **not** `serviceWorkers: "block"` (that hid MetaMask notifications), closes extra extension tabs, and clicks Connect/Confirm on those tabs if dappwright’s popup helper misses them. Pass requires `tx=new` — yesterday’s HashScan row is `tx=stale`, not ok.
- **MetaMask E2E ignored the requested amount.** `harness_wallet_e2e` had no `amount`/`to` args and always filled `0.01` (or left the payments input default `0.1` if React ignored `fill`). The tool now accepts `amount=` / `to=`, writes the live input via native setter, prints `amount_filled=`, and will not Send if the field still shows the default.
- **MetaMask session DOM.** `harness_wallet_session` keeps the extension Chromium alive. `harness_wallet_dom` snapshot/click/fill that dapp tab (aria refs + live input values) so EVALUATE works on any form, not only `pay-amount`. `harness_wallet_mm` still owns Connect/Sign. Playwright MCP stays vanilla-Chrome and stays denied.
- **Idea consent before PRD.** First `question` puts **“Te cuento mi idea”** first (starters are examples below it). A starter chip (e.g. payments) is a **seed**, not a brief — interview is mandatory on that path too. **One question at a time** — never dump who/what/contract/non-goals in one message. They must pick **Así está** before Automatic vs Step by step or `hedera-prd`. “dale” / pace / clicking a starter is not consent. First app: `/` becomes **their** dApp on the scaffold chassis (reuse Header/Connect/hooks); do not ship the seed Hedera Home plus an extra route. A later increment preserves that dApp.
- **Wallet session handshake hang.** `start` no longer reuses a `launching` HTTP server (cancelled start + locked `.harness/wallet/chrome-profile` + leftover Chromium on :17374). Handshake after Chromium is visible times out at 60s, then the session kills the profile and returns `session=hung` instead of polling forever. Agents must not `Start-Sleep` / `netstat` through `launching`.
- **Wallet session start stops leftovers first.** Unless a healthy `session=up` is already live, `start` always tears down residual session pid + chrome-profile Chromium (no-op if none) and then launches. Waiting on a hung leftover was two extra failed attempts before a clean start.
- **Solidity EVALUATE uses the same MetaMask vault.** When `contracts=solidity`, E2E drives the contract UI (`contract_base=`) with session DOM + confirm. `harness_wallet_e2e` (payments Send) is forbidden on that path.

## 1.2.2

### Fixed

- Tier 2 and Tier 3 now share the same browser choice. They use an existing
  project-managed Playwright Chromium when available and otherwise launch
  system Chrome. Tier 2 no longer requires a separate Chromium download, and
  Tier 3 no longer passes the undocumented `--browser chromium` MCP channel.
- `validate-semantic` now uses the same agent-specific MCP delivery as a normal
  run: Claude receives a strict harness-owned config path, while Cursor gets a
  temporary workspace config that is restored immediately afterwards.
- Vendoring PRD and contract context no longer leaves a harness-authored MCP
  entry in the project. MCP configuration exists only for the validator
  invocation that needs it.

### Changed

- Browser setup documentation now reflects the actual runtime: Tier 2 needs
  only the Playwright package when system Chrome is available, while Tier 3
  launches the pinned MCP package itself. No separate browser download, MCP
  browser install, or copied `.mcp.json` is required.
- `doctor` reports the browser as the Tier 3 Playwright MCP browser and prints a
  package-manager-aware repair command.

## 1.2.1

Tier 3 could fail at EVALUATE with `Browser "chrome-for-testing" is not
installed` — after a full generator session had already been paid for. Four
defects combined to produce that; all are fixed.

### Fixed

- **Tier 2 and Tier 3 now share one browser.** Tier 2 resolves `playwright` from
  the project; Tier 3 spawned `@playwright/mcp`, which bundles its own Playwright
  and wanted a different chromium revision. The gate could pass while the
  validator had nothing to drive. Tier 3 now points MCP at the browser the
  project already installed, so it needs no download of its own and both tiers
  grade against the same binary. Falls back to the system Chrome channel when
  that browser is unavailable.

- **`@playwright/mcp` is pinned.** It was `@latest`, so a new upstream release
  could change the required browser build with no harness release involved —
  which is exactly what happened on 2026-08-06.

- **`run` preflights the browser.** `doctor` had a check, but `run` never called
  it, and the check was a `--dry-run` that reported "installed" for a browser
  that could not launch. Preflight now starts the MCP server and actually
  navigates: about 2s to pass, under 2s to fail with the real launch error,
  instead of discovering it minutes into a run.

- **A missing browser is classified as infrastructure.** None of the existing
  patterns matched the real error text, so the repair loop spent attempts
  "fixing" application code that was never broken.

- **Playwright MCP session files stay out of the workspace.** The server wrote
  `.playwright-mcp/` into its working directory and nothing ignored or cleaned
  it, so a successful Tier 3 run would leave a dirty tree — which the next run
  refuses to start on. It went unnoticed only because the browser was failing to
  launch.

- **The `install` error names a key v2 recipes have.** A recipe whose baseline
  had commands but none named `install` failed with `extend.baseline must
  include …`; `extend.baseline` was renamed to `baseline` in v2, so the message
  pointed at a key that cannot be present.

### Changed

- The validator is invoked with **`--strict-mcp-config`**, so the harness config
  is authoritative. Previously the CLI also loaded your MCP scopes, and a
  `playwright` server there collided with the harness one — silently deciding
  which browser graded the app. If you relied on the harness picking up MCP
  servers from your own configuration, it no longer does.

## 1.2.0

### Upgrade first, then update recipes

This release introduces **recipe schema v2**. Reading is backward compatible — a
v1 recipe still loads, with deprecation warnings. **Writing is not:** a recipe
saved as v2 cannot be read by 1.1.x, which predates `schemaVersion` and so fails
with a confusing message about a missing field rather than "upgrade the harness".

If you maintain projects that pin the harness, upgrade the pin **before**
migrating their recipes.

```bash
npm install -D hedera-harness@^1.2.0
npx hedera-harness migrate --dry-run   # see what would change
npx hedera-harness migrate             # rewrite in place
```

`migrate` only removes a key when its value equals what the harness would
default it to. Anything you customised is kept and reported.

### Added

- **`doctor`** — preflight everything a run needs and report it all at once:
  node, git, git state, the recipe and its warnings, the agent CLI, the package
  manager, every path the recipe references, optional peer deps for the enabled
  tiers, and `chainValidation` env vars. A real run costs 40 minutes to two
  hours; this costs seconds.
- **`migrate`** — rewrite a pre-v2 recipe in place.
- **Increments.** `prd:` accepts an ordered list, each delivered onto the same
  branch with its own attempt budget and checkpoint commits. A failure stops the
  sequence; `--continue` resumes there.
- **`agent: cursor | claude`** — one line selects the CLI for the whole run,
  including how the validator receives Playwright MCP and which models are used.
  Enabling the semantic tier is now `validator: { enabled: true }`.
- **Findings lifecycle.** Attempts report `2 open, 3 fixed, 1 new` rather than a
  bare count, so a converging run is distinguishable from a thrashing one.
- **Model escalation.** Repairs use the cheaper model, except after an attempt
  that fixed nothing — which escalates back.
- **Prompts as files** under `prompts/`, overridable per project at
  `.harness/prompts/<name>.md`.
- **Environment knobs**: `HARNESS_MAX_ATTEMPTS`, `HARNESS_AGENT_TIMEOUT_S`,
  `HARNESS_MODEL`, `HARNESS_FIX_MODEL`, `HARNESS_NO_MODEL_SWITCH`.
- **`init` adopts an existing project** instead of refusing a non-empty target,
  and never overwrites a recipe that is already there.

### Fixed

- **Repair prompts pointed at files that do not exist.** Two constants shared the
  name `HARNESS_CONTEXT_DIR` with different values; the session repair prompt
  dropped its vendored context and fell back to a path a project run never
  creates. Every repair attempt after the first was reading a missing PRD and
  contract.
- **The Claude semantic tier could not pass.** MCP was injected into
  `.cursor/mcp.json` for every agent — a file Claude does not read — and the
  validator preset withheld MCP tools from `--allowedTools`, so browser calls
  were permission-denied even once the server loaded. Generator and validator
  invocations are now separate; the validator gets browser tools and no edit
  tools, which its own prompt already forbade.
- **Timeouts could not kill what they started.** `executeCommand` signalled the
  shell rather than the process tree and never escalated, so a child ignoring
  SIGTERM hung the run indefinitely.
- **A failed dev-server startup leaked the process group**, holding the port for
  the rest of the session.
- **Unbounded output buffering** — an agent streaming JSON across a 60-minute
  timeout retained all of it in memory.
- **Key material reached run artifacts.** The ephemeral signer's private key was
  written into agent logs (positional redaction only worked when the prompt was
  the last argument) and into persisted validator prompts; `chain-signer.json`
  was `0644`. Logs and prompts are now redacted, and the file is `0600`.
- **The secret scanner walked `.harness/`**, reporting the harness's own signer
  file as a finding against the app under test.
- **Malformed JSON in a generated file crashed the run** instead of producing a
  finding.
- **Deleted modules were still published.** `dist/` was never cleaned, so files
  whose source had been removed continued to ship.
- **`--template hedera-demo`** resolves to the `templates/hedera-demo` branch
  instead of failing.

### Changed

- The recipe is much smaller. `generator`, `logging`, `secretScan`,
  `forbiddenFiles`, validator paths, `prd` and `maxAttempts` are defaulted, and
  `constraints.forbiddenCommands` is derived from the package manager. A working
  recipe is about nine lines.
- `extend.baseline` is now `baseline`. The old spelling still works and warns.
- `logging` is ignored. Harness logs always live under `.harness/runs/` —
  pointing them elsewhere left untracked files that failed the *next* run's
  clean-tree check.
- Unknown top-level recipe keys now warn instead of being silently dropped.
- The attempt loop is four named stages — GENERATE, ASSERT, SMOKE, EVALUATE —
  with explicit short-circuits, so a failing build never pays for a dev server
  boot or an evaluator pass.

### Removed

- The evaluation-harness path: isolated seed-and-run workspaces, the
  blind-integrity oracle audit, and `seed` in the recipe schema. These answered
  a question the project no longer asks — whether an agent could rebuild a known
  template without peeking at it.
