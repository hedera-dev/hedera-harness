# New template skeleton

Generic placeholders for a Hedera scaffold-hbar benchmark. **Not** runnable until you copy and fill them in.

See the checklist: [`docs/authoring-a-template.md`](../../docs/authoring-a-template.md).

```bash
NAME=my-hedera-demo
cp skeletons/new-template/prd.md docs/prds/${NAME}.md
cp skeletons/new-template/spec.yaml specs/${NAME}.yaml
cp skeletons/new-template/acceptance-contract.json contracts/${NAME}-acceptance.json
cp skeletons/new-template/static.json validators/${NAME}-static.json
cp skeletons/new-template/yarn.json validators/${NAME}-yarn.json
cp skeletons/new-template/playwright-smoke.yaml playwright/${NAME}-smoke.yaml
```

Replace every `my-template` / `REPLACE_ME` / path stub before `run`.

The copied spec defaults to **Tier 0–1 only** (`validators.static` + `validators.commands`). Uncomment Playwright (Tier 2) and `contract` + `validator` (Tier 3) in the spec once the basics pass — acceptance-contract and playwright stubs are still copied so you have them ready.
