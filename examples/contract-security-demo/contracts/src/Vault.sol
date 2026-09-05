// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Demo contract with a deliberate reentrancy bug, used to show the
/// harness contract-security validator catching a High-severity finding in
/// ASSERT before the run proceeds. DO NOT deploy — this is intentionally unsafe.
contract Vault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    /// BUG: external call before the state update — classic reentrancy.
    /// Slither flags this as `reentrancy-eth` (High impact).
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing to withdraw");

        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");

        balances[msg.sender] = 0;
    }
}
