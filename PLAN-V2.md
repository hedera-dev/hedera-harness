# hedera-harness — minimal plan

**Status:** draft, not built. Written 2026-09-08.

## What it is

A command that takes a spec and an existing Hedera dApp repo, and loops an agent until the spec is implemented or the budget is spent.

```
harness run --spec ~/path/to/spec.md
```

Run from inside the target repo. Nothing else is required on the command line.

The agent is **Claude Code**, driven through `@anthropic-ai/claude-agent-sdk` (which runs the Claude Code CLI). There is no provider abstraction and no other agent.

## The loop

```
DOCTOR → GENERATE → TEST → EVALUATE → done
             ↑         │        │
             └─────────┴────────┘   repair, up to --max-attempts (default 3)
```

| Stage | What | Who |
|---|---|---|
| **DOCTOR** | Check dependencies are installed. Resolve how to install, build, test, and serve this repo. Run build and test once on the untouched tree so pre-existing breakage aborts here, not later. | code, plus one agent call to read the repo's scripts |
| **GENERATE** | Implement the spec in the repo. | Claude Code, `cwd` = repo |
| **TEST** | Run the resolved install (if dependencies changed), then `build`, then `test`. Deterministic. | code |
| **EVALUATE** | Start the dev server. Check the running app against the spec: web2 through a browser, web3 through the Hedera mirror node. Return pass/fail with a list of what failed. | Claude Code, `cwd` = a directory containing only the spec |

A failure at TEST or EVALUATE goes back to GENERATE with the failure as the prompt. The Claude Code session is resumed, so the agent keeps its context. After `--max-attempts` the run stops and reports.

### DOCTOR

Checks, in order; any failure stops the run before anything is touched:

1. `node`, `yarn` (or the repo's package manager), `git` present.
2. `.harness/` is listed in `.git/info/exclude`, appended if missing. That file is per-clone and untracked, so the harness's own output never dirties the repo and never appears as a diff in the branch you review. If `.harness/` is already *tracked* in this repo, the run stops and says so — ignore rules don't apply to tracked files, and the next check would fail forever.
3. Git tree clean.
4. Claude Code credentials resolve.
5. `@playwright/cli` installed and its browser downloaded.
6. Skills reported. A project shipping none in `.claude/skills/` still runs, with less Hedera knowledge behind it, so DOCTOR says so rather than leaving the operator to wonder why the output is thin. Counted by the `SKILL.md` inside each entry, not by directory type — a scaffolded project symlinks `.claude/skills/*` at `.agents/skills/*`, and `readdir` reports a symlink as a symlink.
7. Commands resolved: `install`, `build`, `test`, `serve` — see below. Later runs read the tracked `harness.yaml` and skip this entirely.
8. The resolution works: `install`, then `build`, then `test` on the untouched repo; then `serve` starts, prints a URL that answers, and is stopped. Only now is `harness.yaml` written and committed.

**Resolving the commands.** DOCTOR hands the agent the root `package.json`, every workspace `package.json`, the lockfile name, and any README or CONTRIBUTING section about running the project — not the whole repo. The agent replies through an in-process tool, the same pattern as `submit_verdict`, so the answer arrives typed rather than parsed out of prose. DOCTOR then checks each proposed script actually exists in the `package.json` at its `cwd`, prints the proposal, and asks for confirmation. Check 8 is the real verification: a resolution is only written down after it has been executed successfully, so a plausible-looking guess that doesn't work never reaches `harness.yaml`.

The guessing is not incidental. In `scaffold-hbar` the root has no `build`, `test` or `dev` script at all — the real ones are `next:build` and `hardhat:test` — and inside `packages/nextjs`, `start` is `next dev` while `serve` is `next start`. Name-matching gets this wrong three separate ways, which is why an agent reads it and a human confirms it.

**Why the file exists at all.** It is a cache of that resolution and, more importantly, the place to correct it. Without it every run re-resolves, so TEST could run different commands on run 5 than on run 1 — the harness's own behaviour becomes nondeterministic, which is exactly what TEST is supposed not to be. And when the agent resolves something wrong in a way check 8 can't catch (a `test` script that exists and passes but tests the wrong package), a tracked file is the only way to fix it once instead of every run. It holds no secrets, it is four lines, and it describes the project rather than the run — so it is committed, not ignored.

```yaml
install: yarn install
build: yarn next:build
test: yarn hardhat:test
serve:
  run: yarn next:dev
  cwd: packages/nextjs
```

Each command may be a string or `{ run, cwd }`. `cwd` defaults to the repo root. `test` may be empty if the repo has no test script; `build` may not.

### GENERATE

One `query()` with the spec as the prompt, `cwd` = repo. Skills come from the project: `settingSources: ["project"]` loads whatever it carries in `.claude/skills/`, which a scaffolded repo already ships — versioned with the code, identical for every teammate, nothing to install. `HEDERA_SKILLS_DIR` remains as an explicit override for a project that ships none. Pointing it at a marketplace checkout by default was a mistake: fifteen of its twenty-one skills duplicated ones the project already had, under a second plugin-qualified name, and the six it genuinely added were about authoring plugins and harness recipes rather than building the feature. A `PreToolUse` hook denies writes to dotenv files — `.env.example` and friends excepted, since templates hold no secrets. Everything else — which files to touch, which skills to use, whether to write tests — is the agent's call.

**The hook is a first line of defence, not the guarantee.** Tested against a spec that asked for a `.env`, it refused `Write`, then `printf > .env`, then `cp /tmp/x ./.env` — and the agent then wrote the file with `python3 -c "open('.env','w')"`. Pattern-matching a command string cannot contain an interpreter, and no amount of regex will change that.

Two things follow. First, **refuse only what is unsafe and say what is allowed**: the first version also blocked `.env.example`, the very alternative its own message recommended, and that dead end is what drove the escalation. Given a legal path the agent took it after three refusals and stopped. Second, **the enforceable guarantee belongs at the commit**, not the write: the irreversible harm is a secret entering git history, and the harness owns the staging step. Phase 6 must never stage a dotenv file, whatever the working tree contains.

On a repair attempt, the same session is resumed with the failure as the next message:

- after TEST: the command that failed, its exit code, and its output
- after EVALUATE: the evaluator's list of failed items, verbatim

Each failure gets an identity — the failing command plus a normalised first error line, or the `where` of each verdict failure — hashed and recorded. A verdict failure is hashed on its locator only, never on its description: the evaluator is fresh every attempt and words the same bug differently each time, which would make one recurring failure look like a new one and stop the reset from ever firing. Two attempts producing the same hash means the resumed session is stuck on it, so the next attempt starts a fresh session with the failure as its opening prompt instead of resuming. This is the whole convergence mechanism: it tells the report whether an attempt fixed anything or traded one failure for another, and it is the only way out of a session that has talked itself into a corner.

Every attempt also writes `feedback.json` — `{ ok: boolean, failures: AttemptFailure[] }`, one entry per failure, whichever stage produced it. A failure is fields rather than a sentence — a stage failure carries its stage, command, exit code, normalised first error line and the path to its full output; a verdict failure carries `where`, `what` and its evidence. Both carry the `id` the harness hashes them to, so a reader can follow one failure across attempts rather than re-deriving it. Gluing those fields into a line of prose is a renderer's job, done once. The resumed session does not read it; the failure reaches the agent as the next message in its own conversation. The file exists so a human reviewing the branch afterwards can see what each attempt was told without replaying a transcript, and so a fresh session after a reset has something to be seeded with.

### TEST

Runs `install` only if `package.json` or the lockfile changed since the last attempt, then `build`, then `test`. The first non-zero exit code fails the stage; the later commands are skipped. The failing command's output is captured for the repair prompt.

`build` runs before the dev server starts and the dev server is stopped before the next `build` — a Next.js build and a running `next dev` collide on `.next/`.

### EVALUATE

The harness starts `serve`, reads the local URL from its output, and waits for it to answer. It then runs one `query()` with:

- `cwd` = a fresh directory containing only `spec.md`, plus an empty `evidence/` for the agent to write into
- containment: `Read`/`Edit`/`Glob`/`Grep` **deny** rules for everything outside that directory, under `sandbox: { enabled: true, failIfUnavailable: true }`. The rules are what restrict the filesystem — the SDK is explicit that "filesystem and network restrictions are configured via permission rules, not via these sandbox settings"; `sandbox.enabled` on its own restricts nothing. `failIfUnavailable` turns a missing bubblewrap/seatbelt into an abort instead of a silently unsandboxed run. A bare `cwd` is not enough: it constrains relative paths, and on 2026-07-24 the old evaluator read `src/promptBuilder.ts` and `src/validation/chainSigner.ts` by absolute path with `--workspace` set
- the app URL, the Hedera network name, and the mirror node URL in the prompt
- Playwright's CLI skill loaded as a local plugin; the agent drives the browser with `playwright-cli` through Bash
- one in-process tool, `submit_verdict`, registered with `createSdkMcpServer`

The evaluator is told: *read the spec, decide what a user should be able to do, try it in the browser, verify any on-chain effect through the mirror node, saving a screenshot, snapshot or response into `evidence/` as you go, then call `submit_verdict` citing those files.*

The evidence instruction has to be there from the first version, not added once the check is written. An evaluator that was never asked to save anything has nothing to cite, so the field comes back empty and there is nothing to verify — and by then every verdict already recorded is missing it.

**Every attempt gets a new evaluator.** GENERATE resumes its session so it remembers what it already tried; EVALUATE never does. A resumed evaluator would remember the failures it reported last time — which is exactly the list the generator was just told to fix — so it would re-check those and wave the rest through, arriving already expecting a broken app. Each verdict has to be an independent judgment of the app as it stands, not a diff against its own previous opinion. The worker remembers; the referee does not.

Three unrelated things here are called a session, and only the first is resumed: the generator's Claude Code session (one per run, across attempts), the evaluator's Claude Code session (one per EVALUATE — many Bash calls, one conversation, no `resume`), and the `playwright-cli -s=<name>` browser session that keeps the page alive between those Bash calls and is closed with the browser.

```ts
submit_verdict({
  pass: boolean,
  failures: Array<{ what: string; where: string; evidence: string }>
})
```

`evidence` is either a filename the evaluator wrote into `evidence/` (a screenshot, a page snapshot, a saved response) or a mirror-node URL. The harness resolves every filename before accepting the call and rejects the verdict if one is missing — an evaluator can otherwise cite a screenshot it never took, and nothing downstream would notice.

Web2 checks are what the browser shows. Web3 checks are mirror-node reads (`/api/v1/topics/{id}/messages`, `/api/v1/accounts/{id}`, `/api/v1/transactions/…`) — public, no credentials. The evaluator holds no keys.

A verdict is never re-rolled: a well-formed `submit_verdict` fails or passes the attempt, and `failures` become the repair prompt. Re-running an evaluator that answered is the harness grading its own homework. What the verdict is *checked against* is [Verifying the verdict](#verifying-the-verdict) — the judge's answer is accepted, but its claims are settled mechanically.

EVALUATE is re-run once against the same commit only when there is **no verdict**, which means exactly three things:

1. the evaluator ended without calling the tool, including by hitting a bound,
2. the payload failed schema validation, or
3. it cited evidence the harness cannot find on disk.

Anything else is an answer. A second miss aborts the run — the app is not what broke.

The harness stops `serve` after every EVALUATE.

## Bounds

Nothing runs unbounded. Each phase adds the bound for whatever it introduces, so no phase can hang the run it just made possible. The numbers are starting points, tuned after the first real run rather than reasoned about now.

| Bounded | Phase | Bound | On breach |
|---|---|---|---|
| DOCTOR resolution query | 2 | 5 min wall clock | abort |
| `install` / `build` / `test` | 3 | 20 min each | TEST failure — repair |
| `serve` becoming ready | 3 | 2 min to a URL that answers | TEST failure — repair |
| GENERATE query | 4 | `maxTurns`, `maxBudgetUsd`, wall clock via `AbortController` | abort |
| EVALUATE query | 5 | same, shorter | no verdict — re-run once, then abort |

The split follows the third rule of the loop: an agent that hangs is the harness's problem and must not cost an attempt, while a `build` or `test` that never returns is a defect in what the agent just wrote and goes back as a repair. EVALUATE has one extra safeguard the others can't have — `_meta['claude/endTurn']` on `submit_verdict`, so answering ends the turn rather than leaving the agent to decide it is finished.

## Git

The run works on a new branch `harness/<timestamp>` created from the current commit. Each attempt that passes TEST is committed. Because `.harness/` is excluded, those commits carry only what the agent changed — the run's own logs, transcripts and screenshots stay out of the history. On exit the branch is left as-is for the user to inspect, merge or delete.

## Output

```
.harness/runs/<timestamp>/
  events.jsonl         every event of the run, one JSON object per line
  attempt-N/
    generate.jsonl     SDK messages
    build.txt          build output
    test.txt           test output
    evaluate.jsonl     SDK messages
    verdict.json       submit_verdict payload, exactly as the evaluator sent it
    feedback.json      { ok, failures } — what this attempt failed on, for review
    evidence/          playwright-cli screenshots and snapshots
  result.json          { passed, attempts, branch, timings, skills, history } —
                       history carries each attempt's failures, by hash
```

Written into the repo but git-excluded, so the artifacts sit beside the branch they belong to without entering it. The last thing printed is the branch name and `passed: true|false`.

## Shape

```
src/
  cli.ts        harness run --spec <path> [--max-attempts N]
  doctor.ts     dependency checks, command resolution, harness.yaml, baseline test
  generate.ts   query() against the repo, session resume, .env hook
  test.ts       run install/build/test in order, capture output
  serve.ts      start dev server, capture URL, stop
  evaluate.ts   blind query(), submit_verdict tool, evidence dir
  loop.ts       the loop, attempt budget, repair prompt
  git.ts        branch, commit
  run.ts        .harness/runs/<ts>/ layout
```

## Build order

Each step ends runnable, and each carries the bound for what it introduces (see [Bounds](#bounds)).

1. `cli` + `git` + `run` — `harness run --spec` creates a branch and a run directory.
2. `doctor` — refuses to start on a broken repo, writes `harness.yaml`.
3. `test` + `serve` — install, build and test run in order and stop at the first failure; dev server starts, URL captured, server stopped.
4. `generate` — one attempt, no repair; agent edits the repo; `.env` write is denied.
5. `evaluate` — verdict arrives via the tool from a directory that cannot read the repo.
6. `loop` — repair on failure, session resume, failure hashing and the fresh-session reset, budget.

## Watching a run

The loop is built. What a person sees while it runs is not, and a run can go
forty minutes unattended.

**Interaction belongs at the edges, never in the middle.** The value of this
tool is that you are not there — if you are watching closely enough to steer
the agent, you would be faster using Claude Code directly. Every candidate for
mid-run interaction fails on that, and one fails worse: asking a human to
confirm a verdict destroys the adjudication guarantee outright, because an
override available once is an override taken always. The one prompt that
exists — DOCTOR's command confirmation — works precisely because it is at the
start, once per project, and a judgement only a person can make.

So a run should be **worth watching**, and a finished run should be **worth
sitting in**. Those are different jobs.

This also settles a recurring temptation. `hedera-harness-go` has a genuinely
nice Charm TUI, and the Node equivalent is Ink, which Claude Code itself uses.
But `hh` is an interactive tool you sit inside; this is closer to a CI job you
start and come back to, and everywhere it is heading — several specs, running
on a pull request, overnight — is *more* unattended. A full-screen TUI also
destroys scrollback, and on a forty-minute run the scrollback is the record.
Ink stays off the table until there is something genuinely interactive to
build, and if that ever arrives it is the report, not the run.

Four pieces, each its own change, each useful alone:

1. **Graceful interrupt.** There is no signal handling at all, so Ctrl-C tears
   the process down without unwinding the `finally` blocks: an orphaned dev
   server holding the port, and you left on a harness branch with a dirty tree
   — the same lockout that committing every attempt was meant to end. Kill the
   process group, commit the attempt as cancelled so the tree is clean, write
   `result.json`, return to the starting branch. A second interrupt force-quits.
   This is a correctness fix, not presentation.
2. **Presentation.** Colour that carries meaning rather than decoration,
   DOCTOR's checks as a checklist rather than log lines, stage headers to
   anchor a long scrollback, a summary worth screenshotting. Plain ANSI, no
   dependency, no alternate screen, no repainting; identical bytes when piped,
   minus colour. `NO_COLOR` respected.
3. **An event seam.** Stages emit typed events; renderers hang off the stream.
   Deliberately *after* presentation: designing an event schema in the abstract
   is guessing at what the events carry, whereas building the renderer first
   says exactly which fields matter, and the formatting functions are pure and
   survive the move. It pays for three things, not one — a second renderer, a
   `--json` mode for CI, and a loop that can finally be tested by asserting on
   events instead of standing up agents.
4. **`harness report`.** Read a finished run without parsing JSONL: outcome,
   attempts, findings, evidence. This is where someone actually sits with time
   to spend, and the only place a richer terminal UI would earn a dependency.

## Verifying the verdict

Seven runs have reached a verdict and all seven passed on the first attempt. That is consistent with two stories — the generator is good, or the judge is lenient — and nothing in the harness can currently tell them apart. The published numbers say the question is worth asking: LLM judges agree with human graders around [85% of the time](https://arxiv.org/html/2401.13919v3), the failure direction is [systematically lenient](https://arxiv.org/pdf/2507.11662) rather than random, and judges [over-reward their own model family](https://www.adaline.ai/blog/llm-as-a-judge-reliability-bias) — which is what we do, since `--model` is passed to the generator and the evaluator alike.

The rule this section serves is already written down: **a verdict must show its work.** Today that means the harness confirms a cited screenshot *exists*. It should mean the harness confirms the claim is *true*.

**The agent decides what is worth checking. The harness decides whether the check held. The human reads both.**

Everything below follows from one diagnosis: the conflict of interest is not that a check is agent-authored, it is that **the same mind picks the test and renders the verdict, in the same moment**. Benchmarks avoid this structurally — the task author writes the checks, and is nobody being judged — but they can afford it because their tasks are fixed. A spec here is arbitrary prose, so the separation has to come from *when* a check is authored rather than from *who* wrote the task.

### What a check is

A claim the harness can settle without asking anyone:

```ts
{ kind: "chain", path: "accounts/0.0.4821", field: "balance.balance", expect: { increasedBy: "2.5 hbar" } }
{ kind: "http",  route: "/accounts", expect: { status: 200 } }
{ kind: "dom",   route: "/account", selector: "#balance-hbar", expect: { matches: "^\\d+\\.\\d{8}$" } }
```

Three kinds, and an expectation vocabulary of `equals`, `matches`, `contains`, `atLeast`, `changedBy`, `increasedBy`. Deliberately narrow: enough to express a claim, too little to express a program. The line holds at the point where someone wants a conditional.

A check resolves three ways, not two. It **holds**, it **fails**, or it **errors** — unexecutable, because the route 404s or the selector is malformed. An error is a warning and never a failure: the mechanical layer must never manufacture failures out of its own bugs, or it stops being the thing that can be trusted over the judge.

Chain checks are the ones that carry the weight. When the harness re-reads a selector it is reading the same app the agent read, through the same browser, so it catches an agent misreporting a page and not much else. A chain check reads an independent system the agent cannot influence. For a dApp builder that asymmetry is the whole argument, and it is why `chain` ships before `dom`.

### Three sources, and what each gets wrong

| | authored | covers | fails toward |
|---|---|---|---|
| **user** | before the run, by hand or inherited | whatever the user insists on | — |
| **derived** | at DOCTOR, from the spec alone, before the app exists | routes, selectors, formats, literal values | **false failures** |
| **discovered** | at EVALUATE, by the judge that used the app | anything the run created — accounts, contracts, transactions | **false passes** |

**Derived checks** are a cheap agent pass at DOCTOR time that reads only the spec and emits checks through an MCP tool, the same pattern as `submit_verdict`. They cannot be rationalised by what the app turned out to do, because they exist before it does anything. They are pinned for the run and reused across attempts, so the target cannot drift under repair.

**Discovered checks** come from the judge, declared as it works. They exist because a derived check can only name what the prose pins. It cannot say *"the account this run created rose by 2.5"* — that account does not exist when the check is written.

That division is not two flavours of the same idea. The halves are disjoint and predictable, and **the half derivation cannot reach is the half worth the most**: runtime entities on chain, where verification is strongest. Neither tier makes the other redundant.

**Override power follows from what a check can establish, not from who blessed it.** An earlier draft here said provenance does not grade authority — that a failing check fails the run whoever wrote it. Measurement says otherwise, and the two halves are not symmetric:

- a **discovered** check that fails means the judge contradicted itself about something it watched happen. Nothing is a better reason to reject. **It overrides.**
- a **derived** check that fails means one reading of prose disagrees with an app. Either could be wrong and nothing present can say which — it is LLM judgement smuggled into the mechanical layer, which is the rule exactly inverted. **It reports.**

Running derivation over four real specs produced 29 checks, of which three would have failed a correct app: an attribute asserted as text, a conditional made unconditional, and `(?i)not.?found`, a pattern `new RegExp` refuses. Roughly one in ten — small enough to be worth keeping, far too large to hand a veto.

Reporting costs the point of them nothing. The reason these exist is that a lenient judge cannot be caught with an instrument it controls, and a derived check failing while the judge passes *is* that catch — visible in the report either way. What it loses is the power to fail a run over a misreading, which was never the part doing the work.

**The mitigation for a misread spec is not a prompt.** DOCTOR shows the checks it derived and continues; `--review` stops for approval, for anyone who wants it. Confirming by default would put an interaction on the main path *per spec*, where the existing command prompt is per project and never seen again — and reviewing `#block-number matches ^\d+$` in the abstract is low-information, because whether a check says what you meant is usually only visible once it runs. An approval screen asks for attention before there is a reason to give it.

Three things make that safe, and they are worth more than the prompt would have been:

- **a check is only committed after a run it was part of passed.** It has then held against a working app — validated by evidence rather than by someone clicking yes. A misderived check costs a line in the report; it can neither fail a run nor become permanent.
- **every mechanical failure quotes what produced it** — the spec line for a derived check, the evidence file for a judged one. That is how a reader tells "my app is wrong" from "my spec said something I did not mean", which need different fixes.
- **the harness says when it suspects itself.** A check failing alone, with the judge finding nothing wrong, is the signature of a misreading rather than a defect, and the report says so. That reaches the reader when the check is finally falsifiable, which an approval screen cannot.

**User checks are optional and are not primarily for writing by hand.** They are where a previous run's checks live. Run 1 builds `/status` and its checks hold; run 2 builds something else and inherits them as a floor. That closes the regression gap — today nothing re-verifies what an earlier spec built — and costs the user nothing, because those checks earned their place by passing. A floor is not a ceiling: the other sources still add whatever they find. The one legitimate reason to edit the file by hand is an inherited check that is genuinely obsolete because the feature deliberately changed.

### What the user sees

v2's vocabulary — tiers, phases, categories — is a thing to avoid rather than copy. Internal structure must not reach the interface: *provenance*, *derived*, *discovered*, *declared*, *check* itself are names for the code, and a user never meets any of them.

The whole addition to what a person must understand is two words:

```
measured   the harness looked, and it was wrong. Certain.
judged     the evaluator thinks it is wrong. An opinion, with evidence.
```

A failure keeps the shape findings already have — where in the first column, why in the sentence, how it is known underneath:

```
/accounts   #balance-hbar was "—" after 30s, expected to match ^\d+\.\d{8}$
            measured · from your spec: "no rounding, no trailing zeros removed"

/accounts   the error message is unreadable when the id is invalid
            judged · evidence/invalid-id.png
```

DOCTOR lists checks newly derived for this spec in full, and counts the inherited ones rather than listing them — by run twenty the carried set is the part nobody needs to re-read.

The loop the user runs stays what it was: **write a spec, run one command, read the result.** They author nothing, approve nothing, and the only prompt in the system remains the four commands, once per project.

### Where checks live

The same split `harness.yaml` already makes. Checks that have held describe the project, so they are committed and travel with the repo — otherwise the regression floor is per-machine and a teammate cloning inherits nothing. Checks from a run in progress, and every check the judge discovered, belong to that run and stay in its directory with the verdict.

### Declare before you act

Checks are declared before the verdict, not alongside it. The weak argument for this is rationalisation — a judge that authors checks in the same breath as its verdict can pick ones that flatter it. That is plausible and unevidenced, and it is not why the ordering exists.

The load-bearing argument is mechanical: **a delta needs a before-state.** *"The balance rose by exactly 2.5"* is unverifiable unless something captured the balance beforehand. If checks arrive with the verdict, that moment is gone — and it is gone whether or not a verdict has been formed, so "checks first, then verdict" does not fix it either. Declaration has to precede the *action*, not the conclusion:

```
DOCTOR    derive checks from the spec → show → snapshot anything they baseline
EVALUATE  explore → declare("0.0.4821 will rise by 2.5")   ← harness snapshots now
                  → act → declare → act …
                  → submit_verdict → harness settles every declared check
```

State the prediction, then run the experiment. Checks the spec can name get their baseline before GENERATE has touched anything, which is the cleanest possible before-state; the rest get theirs at declaration.

A failed check's locator — `chain:accounts/0.0.4821:balance.balance` — is exactly the shape failure identity already hashes, so check failures join the open/fixed/new accounting for free.

### Order

1. **The checks protocol, chain only.** `declare_check`, execution with tolerance and bounded retry, the override. No browser and no signer needed — both are HTTP. The first run where the judge passes and a check it authored fails is the finding seven runs could not produce.
2. **`harness report` renders checks.** This is the human half of the rule and the only mitigation for a judge authoring trivially-true checks: make what it chose to check legible, rather than trying to outlaw weakness.
3. **Inherited checks.** Carry forward the checks a previous run proved, as a floor.
4. **`--judge-model`.** One flag, so who judges is a separate decision from who writes. Note what it cannot do: the agent is Claude Code and nothing else, so a judge off the generator's *family* is unreachable — opus judging sonnet is a different model on one training distribution, not an independent opinion. What it buys is a different judge and the ability to ask whether two of them agree about one app, which is evidence where there is none. It defaults to the generating model: changing who judges by default would quietly change what every run costs.
5. **Derived checks at DOCTOR**, shown and not asked about; `--review` for anyone who wants the stop.
6. **DOM checks.**
7. **A wallet the app can sign with.** Read `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` from the environment, check the account on the mirror node at DOCTOR, and hand the key to the evaluator with instructions to sign with it — scrubbed from the transcript before it is written. That is the whole of it.

### Why the wallet is this small

The first transactional run answered a question the plan had been guessing at. The evaluator did not fail for want of a wallet: it clicked Connect, the app **generated its own burner**, and the evaluator then went to `portal.hedera.com/faucet` in the browser and funded that address itself. It completed real transfers and found a real defect — a hardcoded gas limit Hedera rejects for a value transfer — with a transaction hash on the mirror node to prove it.

Three things follow.

**The hard problem was never getting a key in.** It was funding whatever address the app happens to invent, which is known only at runtime and needs a signed transfer. That is the provisioning machinery — and it exists only because the app generated a wallet we then had to chase. Make the provided account *be* the wallet and the step disappears: it is already funded, because a person funded it at the portal.

So no ephemeral account, no top-up, no sweep, and **no SDK**. The harness needs the account *id*, to read a public balance over HTTP; it never needs the key for anything of its own. The property that the harness holds no key in its own logic survives almost intact.

**Nothing may depend on the project being scaffolded.** Seeding the key through an environment variable the app reads at startup would keep it away from the agent entirely, and it was tempting. It also requires the app to support it, which contradicts the premise that this works on a repo that already exists. The key goes to the evaluator instead, and redaction is the price.

**An evaluator that acquires resources is a boundary, not a feature.** It found a faucet and used it. That worked, and it is not something to depend on: it is slow — this run spent 23 minutes and all 120 turns, much of it on treasury management rather than judging — non-deterministic, and reliant on someone else's web page. The brief gains a line: judge the app with what it has; do not acquire funds, sign up for services, or obtain credentials. If the app cannot do something, that is a finding. The specific site matters less than the boundary.

**The limit, stated rather than discovered.** This works wherever an app can accept a raw private key — a burner wallet, a dev-mode import, any "paste your key" path. It does not work where an app only supports a browser extension, because a headless browser has no extension. That is the app's limit and not the harness's, and belongs in the README. Where a project keeps its key somewhere unguessable, `harness.yaml` can carry a one-line hint, as v2 did with `browserLocalStorageKey` defaulting to `burnerWallet.pk` — configuration, not machinery, and only when a real project needs it.


### Rejected

**A required checks file.** That is hh's model. It puts a ceiling back on what can ever be verified, and it stops the harness working out of the box.

**`eval.json` as a separate document.** Two files that must agree is how they stop agreeing. The spec stays the only interface, and sharper prose is how a user tightens verification.

**The route gate before the evaluator.** v2's `playwrightGate` walks routes checking status, console errors and hydration. Its job is cost, not trust — the judge's own `http` checks already cover whether a route loads — so it buys failing in four seconds instead of after an evaluation is paid for. Worth having only if evaluation spend becomes the problem.

**Pinning the environment.** Every benchmark that achieves exact verification pins its world: forked mainnet at a fixed block, a sandboxed chain, an in-process mock. The Hedera answer is a local-node profile, and it is a later question. Live testnet is what the generated app will actually run against, and monotone expectations (`atLeast`, `increasedBy`) tolerate a moving chain where `equals` would not.

## Later

Known improvements, parked deliberately. Each is small; none blocks a working loop.

**Skip installs between runs, not just between attempts.** The install fingerprint currently lives in the run directory, so every run pays one `install` even when nothing changed. Moving it to `.harness/` would skip that — but a hand-deleted `node_modules`, or an install interrupted by Ctrl-C or by our own 20-minute bound, leaves the manifests byte-identical, so the fingerprint would match, the install would be skipped, and `build` would fail with `Cannot find module`. DOCTOR would then report "the project is already broken", which is false and sends you to the wrong place. The fix is to fold the package manager's own install-state marker into the fingerprint — `node_modules/.package-lock.json` (npm), `.yarn/install-state.gz` (yarn 3+), `node_modules/.modules.yaml` (pnpm) — since those appear only when an install *completed*. Roughly ten lines, and it makes the cross-run version safe.

**A credentials preflight in DOCTOR.** There is none: on this machine there is no `ANTHROPIC_API_KEY` and nothing readable under `~/.claude`, so a filesystem check would report a false negative against a working setup. The first query is the real test, and it fails in seconds rather than the forty minutes DOCTOR exists to save — so the gap costs little. Worth revisiting only if a credentials failure ever surfaces somewhere expensive.

**Say which account a run uses, rather than inheriting one.** There is no `ANTHROPIC_API_KEY`, no `ANTHROPIC_AUTH_TOKEN` and no `ant` profile on disk, so the harness authenticates as whoever Claude Code is currently logged in as — a subscription credential in the keychain. That is right on a laptop and wrong anywhere unattended: a CI run wants an explicit key, which would also move it to per-token billing deliberately instead of by accident. The same argument as pinning the model — inheriting is the wrong mechanism even when the inherited value happens to be right. It also changes what the failure looks like: on a subscription, exhausting a usage limit mid-run surfaces as a stage failing rather than as anything that says "rate limited", so the run reads as a product failure when it is an account one.

**Rename the spend bound to say what it measures.** `maxBudgetUsd` bounds the SDK's `total_cost_usd`, which under subscription auth is a list-price *equivalent* of the tokens used — a size, not money leaving an account. It still works as a stop; the name will mislead the next person to read it. Related, and worth measuring before the benchmark: how many tokens one small feature actually consumes, since that is what decides whether an x402-scale run fits inside a subscription's limits at all.

## Not in scope

Multiple specs, scaffolding (`init`), other agent providers, benchmarking, pinning the chain to a local node.

Two entries have moved out of this list rather than being done. `init` and `harness report` exist; wallet-connected flows are no longer out of scope but unbuilt — [Verifying the verdict](#verifying-the-verdict) plans the signer that unblocks them, and until it lands a spec needing one is still judged on what the UI offers.
