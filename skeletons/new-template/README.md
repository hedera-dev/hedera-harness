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

# Align internal paths / names with $NAME (macOS; on Linux drop the '').
sed -i '' "s/my-template/${NAME}/g" \
  specs/${NAME}.yaml \
  validators/${NAME}-static.json \
  validators/${NAME}-yarn.json \
  contracts/${NAME}-acceptance.json \
  playwright/${NAME}-smoke.yaml
```

Fill remaining `REPLACE_ME` stubs (description, routes, PRD) before `run`. `seed.repo` already defaults to the public scaffold-hbar remote.

The copied spec defaults to **Tier 0–1 only** (`validators.static` + `validators.commands`). Uncomment Playwright (Tier 2) and `contract` + `validator` (Tier 3) in the spec once the basics pass — acceptance-contract and playwright stubs are still copied so you have them ready.
