# Feature: withdrawable Vault

Add a `Vault` contract to `contracts/src/Vault.sol` that lets users deposit and
withdraw ETH. `withdraw()` must send the caller their balance and must be safe
against reentrancy.
