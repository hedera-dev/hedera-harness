---
name: harness-hedera-docs
description: MUST call Hedera Docs MCP (SearchHedera) before any web search for Hedera APIs. Web fallback only after MCP is missing or the call failed.
---

# Hedera Docs MCP

The overlay ships a **project** remote MCP (`hedera-docs` → `https://docs.hedera.com/mcp`). OpenCode loads it at session start. The tool is `SearchHedera` (or another name under server `hedera-docs`).

## Mandatory

For anything Hedera — SDK imports (`@hiero-ledger` vs `@hashgraph`), Hashio, HCS, HTS, HIP numbers, RainbowKit/Hedera chain 296, WalletConnect, JSON-RPC — **call `SearchHedera` first**. Live docs beat training data.

`websearch` / `webfetch` being **allowed** is not permission to skip MCP. Speed is not a reason to skip. “I already know this” is not a reason to skip.

**FORBIDDEN:** `websearch` / `webfetch` for Hedera docs while `SearchHedera` or any `hedera-docs` tool is in this session’s tool list.

One MCP call is not stalling GENERATE or PRD.

## Fallback (only after MCP)

Use `websearch` / `webfetch` on `https://docs.hedera.com` **only if**:

1. No `hedera-docs` / `SearchHedera` tool exists in this session, **or**
2. You already called it and it **failed or returned empty**.

Then say you fell back. Do not invent package names. If both MCP and search fail, say so.

Do not write `~/.config/opencode` to add this server. It already lives in the project's `opencode.json`.
