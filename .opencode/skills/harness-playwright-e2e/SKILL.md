---
name: harness-playwright-e2e
description: Optional UI pass uses Playwright MCP. Real wallet E2E is MetaMask via dappwright (harness_wallet_e2e). If MCP is missing, ask to install; if disabled, enable; skip is allowed.
---

# Playwright MCP vs MetaMask E2E

Two different browsers.

| Layer | Browser | What it proves |
|------|---------|----------------|
| **MetaMask E2E** (`harness_wallet_e2e`) | Chromium + MetaMask extension (dappwright, vault profile) | Connect popup **approved**, Send **signed**, `tx=new` (not leftover HashScan history) |
| **Playwright MCP** | Vanilla Chrome, **no** extension | Routes, empty states, Connect **button** visible |
| **hedera-local** | Human Chrome | Same Connect+Send the user will demo |

RainbowKit **burner** “CONNECTED ADDRESS” in MCP Chrome is **not** a MetaMask signature. Do not call that E2E success for the vault.

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
