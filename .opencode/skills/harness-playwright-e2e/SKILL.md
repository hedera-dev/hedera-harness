---
name: harness-playwright-e2e
description: Optional UI pass uses Playwright MCP. Real wallet E2E is MetaMask via dappwright (harness_wallet_e2e). If MCP is missing, ask to install; if disabled, enable; skip is allowed.
---

# Playwright MCP vs MetaMask E2E

Two different browsers.

| Layer | Browser | What it proves |
|------|---------|----------------|
| **MetaMask session** (`harness_wallet_session` + `harness_wallet_dom`) | Visible Chromium + MetaMask extension, kept alive | Aria snapshot + live input values; click/fill any dapp form; `harness_wallet_mm` for Connect/Sign |
| **MetaMask E2E** (`harness_wallet_e2e`) | Same browser, one-shot script driven by `.harness/e2e.json` | Connect approved, Send signed, `tx=new` — on any app, not just `/payments` |
| **Playwright MCP** | Vanilla Chrome, **no** extension | Routes, empty states, Connect **button** visible |
| **hedera-local** | Human Chrome | Same Connect+Send the user will demo |

RainbowKit **burner** “CONNECTED ADDRESS” in MCP Chrome is **not** a MetaMask signature. Do not call that E2E success for the vault.

Never write a per-app Playwright `.spec.ts` for wallet flows. It runs in a Chrome with no extension and dies at the MetaMask password. The all-terrain path is the contract in `harness-e2e-contract` driven through the extension Chromium.

## Detect MCP

Call `harness_playwright_mcp` (`status`).

| kind | What to do |
|------|------------|
| `ready` | Optional UI pass with MCP tools. |
| `disabled` | `action=enable` (including `~/.config/opencode`). Do **not** install a second project copy. Then a **new OpenCode session**. |
| `missing` | Do not install until the human says yes. |

## Missing — ask (question tool)

1. **Enable/install Playwright MCP** — UI pass only
2. **Skip MCP UI this run** — still run `harness_wallet_e2e`

If they install: `action=install` writes **project** `opencode.json` only when nothing is disabled/ready already. New session required.
