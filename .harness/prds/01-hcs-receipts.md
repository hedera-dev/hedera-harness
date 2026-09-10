# Feature: tamper-evident receipts on HCS

Write an application receipt to a Hedera Consensus Service topic whenever an
order completes, so a third party can audit the sequence without trusting the
application database.

## Requirements

1. Create an HCS topic at startup if `HEDERA_TOPIC_ID` is unset, and log the id.
2. On order completion, submit one message under 1024 bytes so it is a single
   chunk, shaped `{"type":"receipt","orderId":"...","total":"...","at":"..."}`.
3. Expose `GET /receipts/:orderId` returning the sequence number and consensus
   timestamp so the record can be re-fetched from the mirror node.

## Acceptance

- The topic contains at least one message matching `"type":"receipt"`.
- The running hash chain verifies from genesis.
- Every stored receipt carries the sequence number needed to re-verify
  independently.


## Numbering, and why the harness checks it

Each receipt carries a `seq` field: a dense counter that increments by one per receipt,
starting at 1.

This is not decoration. The running hash chain proves no receipt was altered, removed or
reordered *after* it was written. It cannot prove a receipt was never written at all — an
implementation that skips an inconvenient one breaks no hash, and every integrity check
still passes.

A hole in `seq` is the only signal that reveals the omission, which is why the acceptance
criteria assert density rather than merely a count.

**Acceptance:** receipts on the topic carry `seq` values with no gaps in the observed
range. Re-run if the agent still has work in flight: from outside the topic, a receipt not
yet written is indistinguishable from one withheld.
