// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {ERC1271Wallet} from "./mocks/ERC1271Wallet.sol";
import {MockERC20} from "./mocks/JITMocks.sol";

/// @notice Non-fork coverage of the ERC-1271 wallet mock (the fork suite skips without an
///         RPC): signature validation against the owner key, rejection of everything else,
///         and the owner-gated execute passthrough used for approvals.
contract ERC1271WalletTest is Test {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant NOT_MAGIC = 0xffffffff;

    uint256 internal ownerKey;
    address internal ownerAddr;
    ERC1271Wallet internal wallet;

    function setUp() public {
        (ownerAddr, ownerKey) = makeAddrAndKey("wallet-owner");
        wallet = new ERC1271Wallet(ownerAddr);
    }

    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function test_isValidSignature_ownerSignature_returnsMagic() public view {
        bytes32 hash = keccak256("some order hash");
        assertEq(wallet.isValidSignature(hash, _sign(ownerKey, hash)), MAGIC, "owner signature must validate");
    }

    function test_isValidSignature_strangerSignature_rejected() public {
        bytes32 hash = keccak256("some order hash");
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        assertEq(wallet.isValidSignature(hash, _sign(strangerKey, hash)), NOT_MAGIC, "stranger must be rejected");
    }

    function test_isValidSignature_wrongLength_rejected() public view {
        assertEq(wallet.isValidSignature(keccak256("x"), hex"deadbeef"), NOT_MAGIC, "non-65-byte sig must be rejected");
    }

    function test_isValidSignature_wrongHash_rejected() public view {
        bytes memory sig = _sign(ownerKey, keccak256("signed hash"));
        assertEq(wallet.isValidSignature(keccak256("other hash"), sig), NOT_MAGIC, "hash mismatch must be rejected");
    }

    function test_execute_ownerCanApprove() public {
        MockERC20 token = new MockERC20("TOKEN", 18, false);
        vm.prank(ownerAddr);
        wallet.execute(address(token), abi.encodeCall(MockERC20.approve, (address(0xBEEF), 123e18)));
        assertEq(token.allowance(address(wallet), address(0xBEEF)), 123e18, "approval must come from the wallet");
    }

    function test_execute_nonOwner_reverts() public {
        MockERC20 token = new MockERC20("TOKEN", 18, false);
        vm.expectRevert(bytes("ERC1271Wallet: not owner"));
        wallet.execute(address(token), abi.encodeCall(MockERC20.approve, (address(0xBEEF), 1)));
    }

    function test_execute_bubblesCalleeRevert() public {
        MockERC20 token = new MockERC20("TOKEN", 18, false);
        // transferFrom with no balance/allowance reverts inside the token; the wallet
        // must bubble that exact revert data, not mask it.
        vm.prank(ownerAddr);
        vm.expectRevert(bytes("MockERC20: balance"));
        wallet.execute(address(token), abi.encodeCall(MockERC20.transferFrom, (address(1), address(2), 1)));
    }
}
