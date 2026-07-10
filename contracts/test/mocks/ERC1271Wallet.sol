// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Minimal ERC-1271 contract wallet standing in for a Safe in the contract-maker
///      examples and fork tests: holds tokens, validates order signatures against a
///      configured owner key via `ecrecover`, and exposes an owner-gated call passthrough
///      so the wallet itself can issue ERC-20 approvals (and execute fills as a taker).
///
///      What changes with a real Safe: a Safe does NOT verify the raw order hash — it wraps
///      the message in its own EIP-712 `SafeMessage` envelope (domain = the Safe itself)
///      before checking owner signatures, so the bytes the owner signs differ. The
///      protocol-side shape (raw signature bytes + `fillContractOrderArgs`) is identical.
contract ERC1271Wallet {
    /// @dev ERC-1271 magic value returned when the signature is valid.
    bytes4 internal constant _MAGIC = 0x1626ba7e;

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    /// @notice ERC-1271 hook the LOP calls during `fillContractOrderArgs`: `hash` is the
    ///         EIP-712 order hash, `signature` the raw 65-byte (r ++ s ++ v) owner signature.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        address recovered = ecrecover(hash, v, r, s);
        if (recovered != address(0) && recovered == owner) return _MAGIC;
        return 0xffffffff;
    }

    /// @notice Owner-gated passthrough: how the wallet approves tokens and executes fills.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == owner, "ERC1271Wallet: not owner");
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            // Bubble the callee's revert data unchanged (decoded errors matter in tests).
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}
