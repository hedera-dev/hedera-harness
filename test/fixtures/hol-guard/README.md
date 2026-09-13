# HOL Guard fixtures

Offline stand-ins for `uvx --from hol-guard plugin-scanner scan . --format json`.

- `scanner.mjs` is the stub the tests point `validators.holGuard.command` at.
  It prints the fixture named by its first argument and ignores the
  `scan . --format json` arguments the harness appends; `--help` exits 0 like
  the real CLI.
- `findings.json` and `clean.json` follow the `scan-result.v1` payload that
  hol-guard 3.0.1 builds in `codex_plugin_scanner/reporting.py`
  (`build_json_payload`): the harness reads the top-level `findings[]` with
  `ruleId`, `severity` (critical, high, medium, low, info), `filePath`,
  `lineNumber`, `title`, `description` and `remediation`. Rule ids and texts
  are illustrative.
- `malformed.txt` is what a crashing or half-installed scanner leaves on
  stdout: no report.
