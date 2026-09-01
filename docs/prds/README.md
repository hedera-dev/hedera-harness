# PRDs

A PRD says **what to build**, in product terms. It is the brief handed to the
generator agent. It is not the thing the run is graded against — that is the
evaluate checklist, if you enable EVALUATE.

Keeping those separate matters: the PRD can describe intent loosely, while the
checklist has to be checkable in a browser. Mixing them produces a PRD full of
assertions the agent optimises against, and a checklist too vague to grade.

## Where it lives

`.harness/prd.md` in the project the recipe describes. Nothing needs to declare
it — that is the default path.

## Writing one

Sections that earn their place:

- **Goal** — one paragraph: what this is, who it is for, what "working" means.
- **Journeys** — the paths a user takes. Order them by how much they need:
  1. browse with no wallet and no `.env`
  2. wallet-connected affordances
  3. on-chain actions
- **Hedera services** — which appear in the UI, default network, empty states.
- **Non-goals** — what you are explicitly not asking for. This is the section
  that stops an agent inventing scope.
- **Deliverables** — routes, files, and artifacts you expect to exist.

The scope test: *can a stranger open the app with no wallet and no `.env` and
still see something useful?* If yes, that is your first journey and your
minimum viable scope. Wallet and on-chain behaviour layer on top.

## Splitting into increments

Anything beyond a small change is better delivered in ordered pieces:

```yaml
prd:
  - .harness/prds/01-browse.md
  - .harness/prds/02-wallet.md
  - .harness/prds/03-onchain.md
eval:
  - .harness/evals/01-browse.json
  - .harness/evals/02-wallet.json
  - .harness/evals/03-onchain.json
```

Each gets its own attempt budget and its own checkpoint commits, and a failure
stops the sequence rather than discarding everything. Pair checklists 1:1 with
PRDs for true incremental grading; a scalar `eval:` grades every slice with one
checklist. The journey ordering above usually maps directly onto increments.

One large PRD with three repair attempts is a poor fit for a real feature: the
work exceeds the budget, and a failure loses all of it.

## PRD vs evaluate checklist

| | PRD | Evaluate checklist |
|---|---|---|
| Audience | the generator | the validator |
| Style | product prose | numbered, checkable claims |
| Question | what should exist | is it actually true in a browser |
| Required | yes | only for EVALUATE |

If you find yourself writing "the page must show X" in the PRD, that sentence
belongs in the checklist as an assertion with a `howToVerify`.

## Examples

The PRDs in this directory are illustrative. For a real project, start from
`.harness/prd.md` after `hedera-harness init`, or author one with:

```
/plugin marketplace add hedera-dev/hedera-skills
/plugin install hedera-harness
/create-harness-spec
```

See [authoring-a-recipe.md](../authoring-a-recipe.md) for how the PRD fits with
validators, the evaluate checklist, and the stages.
