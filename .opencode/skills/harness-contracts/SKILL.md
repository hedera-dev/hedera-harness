---
name: harness-contracts
description: When Contracts is solidity, pick a contract base (token, nft, escrow, payroll, vesting, governor, hts, custom), generate it via OpenZeppelin MCP (or Hedera HTS docs), then customize from the interview. Do not invent a .sol from scratch.
---

# Contract bases (Contracts: solidity)

Use this **only** when `harness_tasks_status` says `contracts=solidity`. `contracts=none` means no `.sol` of ours — an existing USDC token is still `none`.

The overlay ships OpenZeppelin Contracts MCP (`openzeppelin-solidity` → `https://mcp.openzeppelin.com/contracts/solidity/mcp`). Tools: `solidity-erc20`, `solidity-erc721`, `solidity-erc1155`, `solidity-governor`, `solidity-custom` (and similar names under that server).

**Call the matching OZ tool first**, then change names, fees, parties, and UI to match **Así está**. Do not write a blank contract from training data when the MCP tool is in the session.

## Header (PRD + `.harness/tasks.md`)

```markdown
Contracts: solidity
ContractBase: escrow
```

`ContractBase` is one of: `token` | `nft` | `escrow` | `payroll` | `vesting` | `governor` | `hts` | `custom`. Omit or `none` when `Contracts: none`.

## Pick a base, then customize

| Base | What it is | OZ MCP | Then change from the interview |
|------|------------|--------|--------------------------------|
| `token` | Fungible token we deploy | `solidity-erc20` | name, symbol, supply, who can mint |
| `nft` | Collectible we deploy | `solidity-erc721` | name, mint, metadata |
| `escrow` | Hold funds until a condition | `solidity-custom` | parties, token vs HBAR, release/refund |
| `payroll` | Pay many people on a schedule | `solidity-custom` | payees, amounts, who triggers |
| `vesting` | Unlock over time | `solidity-custom` | cliff, duration, beneficiary |
| `governor` | On-chain votes | `solidity-governor` | token, voting period, what they vote on |
| `hts` | Hedera token via precompile `0x167` | **none** — `SearchHedera` | treasury/`address(this)`, create/mint UI |
| `custom` | Anything else | `solidity-custom` | the restatement only |

HTS is Hedera-specific. Do not wrap it in OpenZeppelin ERC-20. Seed `packages/hardhat` stays; add/change `.sol` there as the PRD requires.

## GENERATE

1. `harness_tasks_status` — need `contracts=solidity` and `contract_base=`.
2. Load this skill. Call the OZ tool (or `SearchHedera` for `hts`) **before** writing `.sol`.
3. Customize. Compile (`yarn hardhat:compile`). Wire the frontend with scaffold write hooks.
4. Do not rebuild the whole app. Do not invent a second token if they asked for escrow.

If OZ MCP tools are **missing**, say so and write from OpenZeppelin-style imports (`@openzeppelin/contracts`) anyway. Still `SearchHedera` for Hashio / chain 296 / HTS.

## EVALUATE (same MetaMask vault)

Session DOM + `approve` / `confirm`. **Forbidden:** `harness_wallet_e2e` (payments-only). Pass = Connect, the **contract** action from the PRD, MetaMask confirm (repeat if a second popup), **new** hash. Reads need no popup.
