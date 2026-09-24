# hedera-harness

Give it a spec and a Hedera dApp repo. It loops a coding agent until the spec is met, and decides for itself whether it was.

> The harness adjudicates. The agent does the work.

An agent that reports its own success is worth nothing, so nothing here takes the agent's word for it. Tests are run by the harness. The app is judged by a second agent that is never allowed to see the source. Evidence for any claimed failure has to exist on disk before the verdict is accepted.

## Quick start

From inside the project you want to build in:

```bash
harness init payment-flow      # works out how to build this project, drafts a spec
$EDITOR specs/payment-flow.md  # fill it in
harness run --spec specs/payment-flow.md
```

`init` is optional. `harness run --spec <path>` works on a project that has never seen the harness — it just resolves the commands on the way past.

## What it does

```
DOCTOR → GENERATE → TEST → EVALUATE → done
             ↑         │        │
             └─────────┴────────┘   repair, up to --max-attempts (default 3)
```

| Stage | What happens |
|---|---|
| **DOCTOR** | Checks tooling and a clean tree. Works out how to install, build, test and serve this project, then runs those commands on the untouched repo — so a project that was already broken fails here rather than being blamed on the agent. |
| **GENERATE** | An agent implements the spec. It decides which files to touch and whether to write tests. |
| **TEST** | Install, build, test — stopping at the first failure. No agent involved. |
| **EVALUATE** | A second agent judges the running app against the spec, driving a real browser and reading chain state from the public mirror node. It cannot see your code. |

Each attempt is committed to a `harness/<timestamp>` branch. When the run ends you are back on the branch you started from, with the work waiting on that branch.

## Writing a spec

A spec is markdown. The only rule that matters: **anything you assert should be checkable by a person using the app**, because that is how it will be judged.

```markdown
# Network status page

The page at `/status` shows which Hedera network the app is pointed at.

## What a user sees
- the network name, in an element with id `network-name`
- the latest consensus timestamp, fetched live from the mirror node

## Behaviour
- while the request is in flight the page shows a loading state, not `undefined`
- if the mirror node is unreachable, a readable error appears in `#status-error`

## Constraints
- read-only; no transaction, no operator key
```

"The hook polls every 10 seconds" is not checkable from outside. "The number updates without a page reload, roughly every 10 seconds" is. `harness init` drafts a skeleton with this framing, tailored to your project.

## harness.yaml

Written by the harness on first use, and committed, because it describes the project rather than a run:

```yaml
# Root next:build delegates to `next build` in @sh/nextjs, the only production
# build in the repo (hardhat has only compile).
build: yarn next:build
# next:dev runs `next dev` and keeps running; note next:start also runs
# `next dev` while next:serve runs the production `next start`.
serve: yarn next:dev
```

An agent reads your manifests and proposes these; you confirm them once. Script names lie often enough that this is worth an agent rather than a guess — in scaffold-hbar the root has no `build`, `test` or `dev` at all, and inside `packages/nextjs`, `start` is a dev server while `serve` runs the production build.

The comments are the agent's reasoning, kept so the next person to read the file knows why this command and not the obvious-looking one. Edit any line by hand; the harness will not overwrite it.

Each command is a string, or `{ run, cwd }` when it must run somewhere other than the repo root.

## Commands

```
harness init [name]         set the project up and draft specs/<name>.md
harness run --spec <path>   build the feature described by a spec
harness report [run]        read a finished run (default: the latest)

  --max-attempts N          repair attempts before giving up (default 3)
  --model NAME              sonnet (default), opus, haiku, or a full model id
  --judge-model NAME        model for EVALUATE only (default: the same as --model)
  --yes                     skip the first-run command confirmation
  --json                    one JSON object per line, for CI
  --review                  stop to confirm the checks read from your spec
  --full                    report: include both agents' tool feeds
```

Every stage reports what happened as a typed event; the watchable output above
and `--json` are two renderers reading the same stream, so neither can drift
from the other. `--json` carries raw values — `"costUsd": 0.48`, not
`~$0.48 of tokens` — which is the whole reason the two are separate.

## Reading a finished run

```
harness report
```

A run is watched; a finished run is sat with. `report` answers the questions the
live output cannot: what each attempt did, what it cost in total, and — the one
that matters — **why you should believe the verdict**.

```
ATTEMPT 2  failed
  generate   20.0s  8 turns · 3 tool calls · ~$0.10
  evaluate   25.0s  verdict: fail — 2 finding(s)
  ! no verdict — asking the same evaluator to finish

  1 open · 1 fixed · 1 new
    /status: still shows undefined [c.png]  (still open)
    test: `yarn test` exited 1

  evidence  attempt-2/evidence/  16 files, 3 screenshots
```

`1 open` is the number to read: a failure that survived an attempt is marked
`(still open)`, which separates an agent converging from one trading one bug for
another. The warning line is there because the live output slides past it — on
the first real run the evaluator ended a turn without answering and was asked
again, and a summary reading `PASSED after 1 attempt` never mentioned it.

`--full` adds both agents' tool feeds, so you can read exactly what the
evaluator checked rather than taking its word.

## What a run leaves behind

```
.harness/runs/<timestamp>/
  events.jsonl         every event of the run, one JSON object per line
  spec.md              what the run was asked to build
  baseline/            install.txt, build.txt, test.txt, serve.txt — from before
                       the agent touched anything
  attempt-N/
    generate.jsonl     every message from the building agent
    install.txt        command output, one file per stage that ran
    build.txt
    test.txt
    evaluate.jsonl     every message from the judging agent
    verdict.json       what the evaluator answered, before the harness had its say
    checks.json        claims it asked the harness to settle, and what was found
    feedback.json      what this attempt was told went wrong
    evidence/          screenshots, page snapshots, saved responses
  result.json          { passed, attempts, branch, timings, skills, history }
                       history is one entry per attempt, with the failures it
                       produced and the id each hashes to
```

`.harness/` is added to `.git/info/exclude`, so it never appears in your diffs and never needs a `.gitignore` entry.

## How it decides

Four rules, each guarding a specific way this could lie to you.

**The evaluator cannot see your code.** It runs in a directory containing only the spec, with the repo denied at the sandbox. Judging the code instead of the app is the failure that makes a passing run worthless.

**A verdict must show its work.** Every failure cites evidence, and the harness confirms those files exist before accepting the verdict. A finding it cannot see is not a finding.

**Some of it is checked before anything is built.** DOCTOR reads your spec — and only your spec, never the code — and states what it can settle mechanically. Those checks exist before the app does, so nothing about the app can shape them, and they are shown rather than asked about:

```
  I will also verify, from this spec:
    http:/status:status:equals=200  — "The page at `/status` must return HTTP 200."
```

Each one quotes the phrase it came from, so you can see whether it read you the way you meant. `--review` stops for confirmation if you would rather approve them.

**And its claims are checked, not taken.** The evaluator declares what should be true on chain; the harness reads the mirror node itself and decides. A claim it declared and the harness found untrue turns a pass into a fail — never the reverse, and a claim the harness cannot read is a warning rather than a failure. `verdict.json` keeps what the evaluator answered; `checks.json` keeps what was actually there.

**A verdict is never re-rolled.** If the evaluator answers, that answer stands. Only the *absence* of an answer — no verdict, a malformed one, or evidence that is not there — earns a second look, once.

**Secrets never reach git history.** `.env` files are refused during generation and, more importantly, can never be staged — the enforceable half, since the harness owns the commit.

## Requirements

- Node 20+
- git, and a repo with at least one commit and a clean tree
- A `package.json` at the repo root
- Claude Code credentials — a subscription login or `ANTHROPIC_API_KEY`
- `@playwright/cli` browsers installed, for EVALUATE

## Configuration

Machine-level settings are environment variables, deliberately kept out of `harness.yaml`:

| | |
|---|---|
| `HARNESS_MODEL` | Default agent model. Same as `--model`. |
| `HARNESS_JUDGE_MODEL` | Default model for EVALUATE. Same as `--judge-model`. |
| `HEDERA_SKILLS_DIR` | Extra skill plugins, for a project that ships none of its own. Unset by default — a scaffolded project carries its skills in `.claude/skills/` and they load automatically. |
| `HEDERA_NETWORK` | `testnet` (default), `previewnet`, `mainnet`. |
| `HEDERA_MIRROR_NODE` | Overrides the mirror node URL derived from the network. |
| `HEDERA_OPERATOR_ID` | A funded testnet account the app can sign with. DOCTOR checks it exists and has a balance. |
| `HEDERA_OPERATOR_KEY` | Its private key. Passed to the evaluator to import into the app, and scrubbed from every artifact. The harness never signs with it. |
| `NO_COLOR` | Turns off colour. Already off when stdout is not a terminal, so piping or redirecting needs nothing. |

Every stage is bounded: 60 minutes for generation, 20 for evaluation, 20 per command, 2 minutes for the dev server to answer.

## What it does not do yet

- **Transactions need a wallet you supply, and an app that accepts one.** Export `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` for a funded testnet account, and the evaluator imports it into the app — most often through a burner wallet's browser storage. Where an app only supports a browser extension there is no way in, because a headless browser has no extension, and the evaluator reports that rather than working around it. The harness creates no accounts and transfers nothing.
- **One spec at a time.** No sequencing of multiple specs into a larger feature.
- **Claude only.** No provider abstraction.
- **It does not scaffold projects.** Use `create-scaffold-hbar`; the harness works on a repo that already exists.

## Development

```bash
npm install
npm run build
npm link          # puts `harness` on your PATH
```

Design notes and parked work are in [PLAN-V2.md](./PLAN-V2.md).
