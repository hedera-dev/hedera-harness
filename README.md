# hedera-harness

Give it a spec and a Hedera dApp boilerplate. It loops a coding agent until the spec is met, and decides for itself whether it was.

## Quick start

From inside the project you want to build in. **Set it up once** — whichever of these fits:

```bash
harness init                   # four questions, defaults read from your package.json
```

```bash
harness wizard payment-flow    # an agent reads the project, then interviews to generate a spec
```

Both write `harness.yaml` and commit it. `init` is the fast path when you already have a spec; `wizard` also drafts one at `specs/payment-flow.md`.  
  
The wizard interviews you one question at a time, following your answers rather than working through a list — it has read the project, so it can ask about what you have not said:

```
── question 2 of 8
Which mirror node should it query — the one for whatever network the
wallet is currently connected to, or a fixed network regardless?

› a fixed network. The page is read-only and must work with nothing connected.
```

An empty answer ends the interview and it writes with what it has.

**Then run it, as often as you like:**

```bash
$EDITOR specs/payment-flow.md  # your spec, in your words
harness run --spec specs/payment-flow.md
```

## What it does

```
DOCTOR → DERIVE → GENERATE → TEST → EVALUATE → done
                      ↑         │        │
                      └─────────┴────────┘   repair, up to --max-attempts (default 3)
```


| Stage        | What happens                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DOCTOR**   | Deterministic, no agent. Checks git, a clean tree, your browser and wallet, and that `harness.yaml` names commands that exist — then runs install, build and test on the untouched repo, so a project that was already broken fails here rather than being blamed on the agent. |
| **DERIVE**   | An agent reads your spec — only the spec, never the code — and writes down what a judge could settle by reading a value. Runs before anything is built, so nothing about the app can shape it.                                                                                  |
| **GENERATE** | An agent implements the spec. It decides which files to touch and whether to write tests.                                                                                                                                                                                       |
| **TEST**     | Install, build, test — stopping at the first failure. No agent involved.                                                                                                                                                                                                        |
| **EVALUATE** | A second agent judges the running app against the spec, driving a real browser and reading chain state from the public mirror node. It cannot see your code.                                                                                                                    |


Each attempt is committed to a `harness/<timestamp>` branch. When the run ends you are back on the branch you started from.

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

"The hook polls every 10 seconds" is not checkable from outside. "The number updates without a page reload, roughly every 10 seconds" is.

## harness.yaml

Written by `harness init` or `harness wizard`, and committed, because it describes the project rather than a run:

```yaml
# Root next:build delegates to `next build` in @sh/nextjs, the only production
# build in the repo (hardhat has only compile).
build: yarn next:build
# next:dev runs `next dev` and keeps running;
serve: yarn next:dev
```

`init` asks you for them, offering what your `package.json` actually contains. `wizard` has an agent read the project and propose them instead — worth it because script names lie often enough: in scaffold-hbar the root has no `build`, `test` or `dev` at all, and inside `packages/nextjs`, `start` is a dev server while `serve` runs the production build.

The comments are the agent's reasoning, kept so the next person to read the file knows why this command and not the obvious-looking one. Edit any line by hand; the harness will not overwrite it.

Each command is a string, or `{ run, cwd }` when it must run somewhere other than the repo root.

## Commands

```
harness init                write harness.yaml by answering four questions
harness wizard [name]       the same, worked out by an agent, which then
                            interviews you and drafts specs/<name>.md
harness run --spec <path>   build the feature described by a spec
harness report [run]        read a finished run (default: the latest)

  --max-attempts N          repair attempts before giving up (default 3)
  --max-spend USD           stop an agent that spends more than this (unset by default)
  --model NAME              sonnet (default), opus, haiku, or a full model id
  --judge-model NAME        model for EVALUATE only (default: the same as --model)
  --yes                     take the defaults without asking (init, wizard)
  --json                    one JSON object per line, for CI
  --review                  stop to confirm the checks read from your spec
  --continue                carry on from the last run rather than starting over
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

`--full` adds both agents' tool feeds, so you can read exactly what the
evaluator checked rather than taking its word.

## What a run leaves behind

```
.harness/runs/<timestamp>/
  events.jsonl         every event of the run, one JSON object per line
  spec.md              what the run was asked to build
  install-fingerprint.txt  manifests as they were, so later attempts skip a
                       reinstall nothing has invalidated
  baseline/            install.txt, build.txt, test.txt, serve.txt — from before
                       the agent touched anything
  attempt-N/
    generate.jsonl     every message from the building agent
    install.txt        command output, one file per stage that ran
    build.txt
    test.txt
    evaluate.jsonl     every message from the judging agent
    verdict.json       what the evaluator answered, with its accounting of the
                       checklist: both readings and the evidence for each item
    feedback.json      what this attempt was told went wrong
    evidence/          screenshots, page snapshots, saved responses
  result.json          { passed, attempts, branch, timings, skills, history }
                       history is one entry per attempt, with the failures it
                       produced and the id each hashes to
```

If a run stops before it finishes — you interrupt it, or it runs out of budget — every attempt it completed is already committed to its branch. `harness run --spec <path> --continue` picks up from there: it branches from that work rather than from yours, and the first attempt starts by repairing what the last one failed on instead of reading the spec against code that already exists. A run that *passed* is equally continuable; that is how a second spec builds on the first.

`.harness/` is added to `.git/info/exclude`, so it never appears in your diffs and never needs a `.gitignore` entry.

## How it decides

**The evaluator cannot see your code.** It runs in a directory containing only the spec, with the repo denied at the sandbox. Judging the code instead of the app is the failure that makes a passing run worthless.

**A verdict must show its work.** Every failure cites evidence, and the harness confirms those files exist before accepting the verdict. A finding it cannot see is not a finding.

**Some of it is read from the spec before anything is built.** DERIVE reads your spec — and only your spec, never the code — and states what a judge can verify by reading a value rather than forming an opinion. That checklist exists before the app does, so nothing about the app can shape it, and it is shown rather than asked about:

```
  I will also verify, from this spec:
    http:/status:status:equals=200  — "The page at `/status` must return HTTP 200."
```

**The judge does the checking; the harness keeps the books.** The evaluator verifies each item itself — chain state from the public mirror node, read before it touches the app and again after, because a change is only visible against a value written down beforehand. A verdict is not accepted until every item is accounted for: both readings, whether the claim held, and the URL or screenshot that shows it.

**A verdict is never re-rolled.** If the evaluator answers, that answer stands. Only the *absence* of an answer — no verdict, a malformed one, evidence that is not there, or a checklist left unaccounted for — earns a second look.

**Secrets never reach git history.** `.env` files are refused during generation and, more importantly, can never be staged — the enforceable half, since the harness owns the commit.

## Requirements

- Node 20+
- git, and a repo with at least one commit and a clean tree
- A `package.json` at the repo root
- Claude Code credentials — a subscription login or `ANTHROPIC_API_KEY`
- Chromium for EVALUATE — `npx playwright install chromium`. DOCTOR checks for it and says this if it is missing.



## Configuration

Machine-level settings are environment variables, deliberately kept out of `harness.yaml`:


|                       |                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HARNESS_MODEL`       | Default agent model. Same as `--model`.                                                                                                                                     |
| `HARNESS_JUDGE_MODEL` | Default model for EVALUATE. Same as `--judge-model`.                                                                                                                        |
| `HEDERA_SKILLS_DIR`   | Extra skill plugins, for a project that ships none of its own. Unset by default — a scaffolded project carries its skills in `.claude/skills/` and they load automatically. |
| `HEDERA_NETWORK`      | `testnet` (default), `previewnet`, `mainnet`.                                                                                                                               |
| `HEDERA_MIRROR_NODE`  | Overrides the mirror node URL derived from the network.                                                                                                                     |
| `HEDERA_OPERATOR_ID`  | A funded testnet account the app can sign with. DOCTOR checks it exists and has a balance.                                                                                  |
| `HEDERA_OPERATOR_KEY` | Its private key. Passed to the evaluator to import into the app, and scrubbed from every artifact. The harness never signs with it.                                         |
| `NO_COLOR`            | Turns off colour. Already off when stdout is not a terminal, so piping or redirecting needs nothing.                                                                        |


Every stage is bounded by a clock — generation, evaluation, each command, and the dev server becoming ready. A breach ends that stage with a reason rather than hanging the run. The numbers live beside the code they bound, in `src/`, each with what measurement set it.

A run stops starting new attempts after four hours; each stage is bounded on its own as well.

There is deliberately **no spend limit by default**. What a run is worth is yours to decide, and a figure we picked would only ever be wrong for somebody. Pass `--max-spend` if you want one.