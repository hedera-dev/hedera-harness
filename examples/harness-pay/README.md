# Harness Pay

Minimal one-page Hedera dApp used to prove that **Harness Test Wallet** is discoverable through the standard extension protocol (`hedera-extension-query` / `hedera-extension-response` / `hedera-extension-connect-*`).

No Harness-specific wallet SDK.

```bash
# Usually launched by `hedera-harness wallet demo`
node server.mjs
# http://127.0.0.1:5173/?runtime=http://127.0.0.1:<wallet-runtime-port>&payTo=0.0.x&asset=hbar
```
