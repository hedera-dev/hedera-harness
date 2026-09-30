# How the harness talks to an agent

A tour of the Claude Agent SDK as this repo uses it: what `query()` actually
is, where the five call sites are, what the machinery around them does, and
which parts of the SDK's surface we lean on. Read this before touching any of
them.

The canonical reference is not the docs site — it is
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, which documents every
option and message type inline and cannot drift from the version we run.

## The mental model

The Agent SDK is **Claude Code — the same CLI you use in a terminal — as a
library**. `query()` does not call the Anthropic API. It spawns the Claude
Code binary as a subprocess (the binary ships inside the npm package;
`pathToClaudeCodeExecutable` exists for overrides), hands it your prompt, and
streams back everything the agent does.

Your process and the CLI talk JSONL over stdio, plus a control channel for
callbacks. So every "agent call" in the harness is:

> spawn Claude Code → it works autonomously (reads, writes, Bash, browser) →
> we watch the message stream → it ends → we read what it left behind.

Nothing in the harness parses the agent's prose. Structured answers arrive
through MCP tool calls (see "The mailbox" below); everything else in the
stream is telemetry.

## Anatomy of one call

`src/generate.ts` is the template every other site is a variation of:

```ts
const conversation = query({
  prompt: options.prompt,
  options: {
    cwd: repoRoot,
    model: options.model,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    plugins: plugins.map((path) => ({ type: "local" as const, path })),
    settingSources: ["project"],
    permissionMode: "bypassPermissions",
    hooks: { PreToolUse: [{ hooks: [guard] }] },
    maxTurns: MAX_TURNS,
    maxBudgetUsd: MAX_BUDGET_USD,
    abortController: controller,
  },
});
```

What each knob means:

| Option | Meaning |
|---|---|
| `prompt` | The brief. A string here; may be an async iterable of user messages for multi-turn streaming input. |
| `cwd` | The agent's working directory. For the generator, the repo itself; for the evaluator, an isolated tmp workspace. |
| `model` | Which model drives. |
| `resume` | A session id. Sessions are real — the CLI persists them as JSONL — so a later `query()` **continues the same conversation** rather than starting over. This is what `--continue` and the evaluator's "finish what you started" nudge are built on. |
| `plugins` | Local skill plugins to load: the Hedera skills for the generator, playwright-cli's own skill for the evaluator. |
| `settingSources` | Which settings files the CLI reads. `["project"]` keeps the repo's CLAUDE.md but drops the operator's personal `~/.claude` settings — a run must not depend on who launched it. The evaluator passes `[]`: nothing at all. |
| `permissionMode` | `"bypassPermissions"` everywhere: a run is unattended. What keeps that safe is the sandbox and the hooks, not the permission system. |
| `hooks` | Your functions, called **mid-turn over the control channel**. `PreToolUse` fires before every tool the agent runs and may deny it — policy enforcement without parsing anything. |
| `maxTurns` / `maxBudgetUsd` | Bounds enforced **by the CLI**, not by us. See "Sharp edges". |
| `abortController` | The harness's kill switch: wall-clock timeout, Ctrl-C. |
| `sandbox` | (evaluate only) OS-level containment — seatbelt on macOS, bubblewrap on Linux. `failIfUnavailable: true`: a missing sandbox aborts, never silently downgrades. |
| `mcpServers` | (three sites) In-process tool servers. See "The mailbox". |

Then the loop:

```ts
for await (const message of conversation) {
  await appendFile(transcript, `${JSON.stringify(message)}\n`);
  const step = describeMessage(message);
  if (step !== null) emit({ type: "tool", ... });
  sessionId ??= message.session_id;
  const ending = endingOf(message, MAX_TURNS);
  // ...
}
```

Every message is (a) appended to the transcript verbatim — the evaluator's
transcript is redacted at the write, because its brief carries a live wallet
key — and (b) inspected. Three message shapes matter:

- **`system/init`** — the first message, and the only place that says what the
  agent can actually reach: skills loaded, MCP servers connected, session id.
  generate.ts reads the real skill count from it because the first real run
  reported "8 skill plugins" while 60 skills were active.
- **`assistant` / `user`** — the work: text, `tool_use` blocks, tool results.
  `describeMessage()` distills them into the `tool` events the terminal shows.
- **`result`** — the ending: success or a typed error (`error_max_turns`,
  budget, …), plus turns and cost.

The returned `Query` is more than the stream. It is an async generator with
control methods: `initializationResult()` (awaited before iterating, to verify
plugins actually loaded — absent means the CLI did not report, `false` means a
plugin we asked for is not loaded), `interrupt()`, `close()`,
`backgroundTasks()`, and friends. All ride the same control channel.

## The five call sites

One shape, five configurations. The options are where each stage's trust
posture lives.

| Site | Agent's job | What makes it different |
|---|---|---|
| `src/init.ts` | Draft a tailored spec skeleton | File tools allowed — it must read the project. Mailbox: `write_spec`. |
| `src/resolve.ts` | Propose install/build/test/serve commands | Reads the repo, proposes once. Mailbox: `propose`. |
| `src/derive.ts` | Read checks out of the spec | **No file tools, spec inline in the prompt.** A pass that could open the repo would derive checks from the implementation; blindness to the app is the property being bought. |
| `src/generate.ts` | Build the feature | Full tools in the real repo, skills plugins, the `PreToolUse` guard hook. |
| `src/evaluate.ts` | Judge the running app | Sandboxed tmp workspace, `settingSources: []`, MCP verdict server, redacted transcript. |

Same skeleton every time: brief → `query()` → stream to transcript → mailbox
tool collects the structured answer → adjudicate after the stream ends.

## The mailbox

The harness never parses agent prose for an answer. Each site that needs a
structured result builds an in-process MCP server with `createSdkMcpServer`
whose tool handlers close over a plain mutable object:

```ts
const captured: Captured = { verdict: null, malformed: null, checks: [] };
const server = verdictServer(captured, chain.mirrorNode);
// ... after the stream ends:
const outcome = adjudicate(turn.captured, workspace);
```

`createSdkMcpServer` does not open a port or spawn anything. It registers your
handlers with the CLI over the control channel; when the model calls
`mcp__harness__submit_verdict`, the CLI validates the args against the zod
schema and routes the call **back into this process**, where the handler's
write to `captured` is a plain variable write. The handler's return value
travels back to the model as the tool result.

This buys four things a parsed final message cannot:

1. **Schema at the boundary, inside the turn.** Malformed args come back as a
   tool error and the model retries immediately. (Scar: the first evaluator to
   fail a spec answered with a filename followed by a parenthesised
   explanation, and the whole string was read as a path. Fields, not
   sentences, ever since.)
2. **The answer ends the turn.** `submit_verdict` returns
   `_meta: { "claude/endTurn": true }` — the harness decides when evaluation
   is done. The one time the evaluator decided for itself, it ended without
   answering at all.
3. **No answer is distinguishable from a wrong answer.**
   `captured.verdict === null` → `unreported`; `malformed` set → `cut-off`;
   evidence missing on disk → `unevidenced`. Three failure modes, three
   recoveries.
4. **Claims leave the agent's control at the tool boundary.**
   `declare_check` snapshots the chain baseline at the instant of declaration
   — mid-turn, before the action that should make the claim true — and returns
   only a receipt. The harness settles the claim against the mirror node
   itself, after the turn. The agent never reports whether its own check held.

## Behind the scenes

```
our process                             CLI subprocess (Claude Code)
───────────                             ──────────────────────────
query({prompt, options})  ── spawn ──▶  starts, loads settings/plugins/MCP
                          ◀── init ──  system/init: skills, session id
for await (message)       ◀── JSONL ─  assistant turns, tool_use, results
  PreToolUse hook         ◀─ control ─ "may I run Bash?" → guard answers
  MCP tool call           ◀─ control ─ mcp__harness__*(args)
                                        → handler runs IN our process
                                        → return value → tool_result
  abortController.abort() ── control ─▶ kill
  result message          ◀── JSONL ─  success/error + turns + cost
```

Three things to internalize:

1. **Hooks, MCP callbacks, and permission requests are one channel.**
   Everything the CLI needs *from us* mid-turn rides the control protocol. The
   harness uses it for the guard hook (generate) and the verdict server
   (evaluate).
2. **Bounds are enforced by the CLI and reported as data.** `maxTurns` and
   budget are not timers in our process; the CLI stops itself and says why in
   the result message. Our job is to read that faithfully — the whole
   `endingOf` / `recoverable` machinery in `src/messages.ts`.
3. **Sessions are files.** `resume` continues a conversation the CLI
   persisted. One conversation can end twice (a background subagent finishing
   wakes it with a `task-notification`), so turns accumulate across endings
   while `total_cost_usd` is already cumulative and must not — both traps are
   handled in `messages.ts`.

## Sharp edges

- **A bound arrives as an error result, then throws when the iterator is
  pulled again.** That is why `endingOf` is read *inside* the loop: it turns
  "the run died" into "no verdict — ask once more", which is what the bounds
  table always promised.
- **The init message is the only truth about capabilities.** Announce skills
  from it, never from what we asked for.
- **`allowRead` is not an allowlist.** The SDK defines it as paths re-allowed
  *within* denied regions, so "deny everything outside the workspace" is
  expressed as a denied region (home) with holes punched in it — see
  `contained()` in `src/evaluate.ts` for the region and the three holes.
- **The sandbox needs the loopback grant.** The evaluator judges an app on a
  loopback port; without `network: { allowLocalBinding: true }` the sandbox
  refuses the connection and the agent's own recovery is to rerun with the
  sandbox off. Granting the one thing it needs beats a containment the agent
  routes around.
- **End-turn tools change the transcript shape.** A turn that ends on
  `claude/endTurn` has no trailing assistant message; the structured output
  rides the tool result. Anything that replays or forks sessions needs to know
  (the SDK's own fork docs call this out).

## Where the machinery lives

- `src/messages.ts` — the SDK-fluent layer: `describeMessage` (raw message →
  tool event), `endingOf` (result → { turns, cost, failure, recoverable }),
  `said` (transcript writes, with the wallet key scrubbed at the write).
- `src/evaluate.ts` — the fullest expression: `contained()` (sandbox rules),
  `verdictServer` (the mailbox), resume-on-cutoff, `adjudicate`.
- `src/generate.ts` — the template: options anatomy, the guard hook, init
  verification.
- `src/init.ts`, `src/resolve.ts`, `src/derive.ts` — the one-shot sites.

## Official docs

[platform.claude.com/docs/en/agent-sdk](https://platform.claude.com/docs/en/agent-sdk/overview)
(JS-rendered; there is no plain-text mirror). The topics they consider the
surface: how the agent loop works, streaming input, structured output, custom
tools, MCP, hooks, sessions, permissions, subagents, skills, plugins,
checkpointing, cost tracking. We use nearly all of them; subagents and
checkpointing are the unused corners.
