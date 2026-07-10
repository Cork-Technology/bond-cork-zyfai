// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IDefaultCorkController, PoolCreationParams} from "../../src/interfaces/IDefaultCorkController.sol";
import {IPoolManager, Market, MarketId} from "../../src/interfaces/IPoolManager.sol";

/// @dev Phoenix error surface used to assert revert propagation in tests. Signatures match
///      phoenix's IErrors (`AlreadyInitialized()`, `InvalidExpiry()`, `InvalidParams()`).
interface IPhoenixErrors {
    error AlreadyInitialized();
    error InvalidExpiry();
    error InvalidParams();
}

/// @dev Mirrors the real CorkPoolManager behavior the creator relies on: `getId` hashes the
///      Market struct, `market` returns an ALL-ZERO struct for unknown ids (never reverts).
contract MockPoolManager is IPoolManager {
    mapping(bytes32 id => Market parameters) internal _markets;

    function getId(Market calldata marketParameters) external pure returns (MarketId marketId) {
        marketId = MarketId.wrap(keccak256(abi.encode(marketParameters)));
    }

    function market(MarketId poolId) external view returns (Market memory parameters) {
        parameters = _markets[MarketId.unwrap(poolId)];
    }

    function register(Market memory marketParameters) public {
        _markets[keccak256(abi.encode(marketParameters))] = marketParameters;
    }

    // -- Mint surface (added to IPoolManager for the JIT hook) --------------------------------
    // The market-creator tests never touch these; the JIT hook tests use the full-featured
    // MockJITPoolManager in JITMocks.sol instead.

    function shares(MarketId) external pure returns (address, address) {
        revert("MockPoolManager: shares not mocked");
    }

    function previewMint(MarketId, uint256) external pure returns (uint256) {
        revert("MockPoolManager: previewMint not mocked");
    }

    function mint(MarketId, uint256, address) external pure returns (uint256) {
        revert("MockPoolManager: mint not mocked");
    }
}

/// @dev Records `createNewPool` calls (count + last params) and registers the created market in
///      the mock pool manager. Mirrors the two phoenix creation checks the creator relies on, in
///      phoenix's order: expiry-in-future first (CorkPoolManager `InvalidExpiry()`), then
///      not-already-initialized (`AlreadyInitialized()`). Can also be armed to revert with
///      arbitrary error data to test revert propagation.
contract MockController is IDefaultCorkController {
    MockPoolManager public immutable poolManager;

    uint256 public callCount;
    PoolCreationParams internal _lastParams;
    bytes internal _revertData;

    constructor(MockPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function setRevertData(bytes calldata revertData_) external {
        _revertData = revertData_;
    }

    function createNewPool(PoolCreationParams calldata params) external {
        bytes memory revertData = _revertData;
        if (revertData.length != 0) {
            assembly ("memory-safe") {
                revert(add(revertData, 0x20), mload(revertData))
            }
        }
        require(params.pool.expiryTimestamp > block.timestamp, IPhoenixErrors.InvalidExpiry());
        Market memory existing = poolManager.market(MarketId.wrap(keccak256(abi.encode(params.pool))));
        require(existing.collateralAsset == address(0), IPhoenixErrors.AlreadyInitialized());
        callCount++;
        _lastParams = params;
        poolManager.register(params.pool);
    }

    function lastParams() external view returns (PoolCreationParams memory) {
        return _lastParams;
    }
}
