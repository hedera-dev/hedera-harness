# Command timeouts remain failures after a graceful shutdown

A command can receive the harness's timeout signal, clean up, and exit with
code zero. That zero reports a successful shutdown, not completion of the
validation before its deadline.

`CommandExecutionResult` deliberately preserves both pieces of evidence:
`exitCode: 0` and `timedOut: true`. The throwing command helper and the ASSERT
command validator must reject this combination. The command validator keeps
its existing `command:<name>` finding identity and reports that it timed out.
A timeout with empty stdout/stderr still has an actionable finding message.

An `install` command with this outcome must not write the successful-install
fingerprint. Otherwise the next attempt skips an installation that never
finished. Ordinary successful installations still populate and reuse their
fingerprint, and ordinary nonzero exits retain their existing diagnostics.

## Reproduce

Run the repository build, then:

```sh
node --test test/command-timeout-integrity.test.mjs
```

The suite uses real local child processes, real POSIX SIGTERM delivery, and
real temporary files. Its child fixture waits indefinitely and exits zero
only when the harness asks it to terminate. Assertions require both the
actual zero exit code and `timedOut: true`, so an ordinary signal-killed
process cannot accidentally satisfy the regression.

Two ordinary helper controls are portable; twelve signal/shell cases are
skipped on Windows. Windows process-tree behaviour is not established by
these POSIX tests.

This contribution changes ASSERT command acceptance and
`executeCommandOrThrow`, not raw exit-code reporting, timeout duration,
process-tree teardown, log capture, model verdict parsing, or the other
harness stages. No network, agent credential, funded account, or blockchain
transaction is needed for the regression.

Fingerprints written by an older version are not retroactively authenticated.
Invalidate the affected run's install-cache entry before retrying an older run
whose install previously timed out; this patch prevents new false entries.
