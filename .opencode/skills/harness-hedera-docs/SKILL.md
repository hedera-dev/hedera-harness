---
name: harness-hedera-docs
description: Prefer official Hedera Docs MCP (SearchHedera). If it is missing, fall back to web search of docs.hedera.com.
---

# Hedera Docs MCP

The overlay ships a **project** remote MCP (`hedera-docs` → `https://docs.hedera.com/mcp`). OpenCode loads it at session start. Tool name is typically `SearchHedera`.

## When to use it

SDK imports (`@hiero-ledger` vs `@hashgraph`), Hashio, HCS, HTS, HIP numbers, RainbowKit/Hedera chain 296, WalletConnect. Prefer live docs over training data.

## Fallback

If `hedera-docs` / `SearchHedera` tools are **not in this session** (MCP failed to connect, disabled, offline):

1. `websearch` / `webfetch` on `https://docs.hedera.com` (and the page the user named).
2. Do **not** block GENERATE or PRD waiting for MCP.
3. Do not invent package names. If both MCP and search fail, say so.

Do not write `~/.config/opencode` to add this server. It already lives in the project's `opencode.json`.
