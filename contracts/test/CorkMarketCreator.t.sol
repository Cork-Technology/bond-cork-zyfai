// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {CorkMarketCreator} from "../src/CorkMarketCreator.sol";
import {FixedRateOracleFactory} from "../src/FixedRateOracleFactory.sol";
import {IDefaultCorkController, PoolCreationParams} from "../src/interfaces/IDefaultCorkController.sol";
import {IPoolManager, Market, MarketId} from "../src/interfaces/IPoolManager.sol";
import {IPhoenixErrors, MockController, MockPoolManager} from "./mocks/Mocks.sol";

contract CorkMarketCreatorTest is Test {
    address internal constant COLLATERAL = address(0xC011a7e4a1);
    address internal constant REFERENCE = address(0x4Efe4e4Ce);

    MockPoolManager internal poolManager;
    MockController internal controller;
    FixedRateOracleFactory internal factory;
    CorkMarketCreator internal creator;

    function setUp() public {
        poolManager = new MockPoolManager();
        controller = new MockController(poolManager);
        factory = new FixedRateOracleFactory();
        creator = new CorkMarketCreator(controller, poolManager, factory);
    }

    /// @dev Distinct values in every slot so any field mix-up (especially the unwind/swap fee
    ///      order footgun) fails an assertion.
    function _defaultParams() internal view returns (CorkMarketCreator.CreateParams memory params) {
        params = CorkMarketCreator.CreateParams({
            collateralAsset: COLLATERAL,
            referenceAsset: REFERENCE,
            expiryTimestamp: block.timestamp + 1 days,
            rate: 0.8e18,
            rateMin: 0.8e18,
            rateMax: 0.8e18 + 1,
            rateChangePerDayMax: 7,
            rateChangeCapacityMax: 11,
            swapFeePercentage: 1e18,
            unwindSwapFeePercentage: 2e18,
            isWhitelistEnabled: true
        });
    }

    function _expectedMarket(CorkMarketCreator.CreateParams memory params, address oracle)
        internal
        pure
        returns (Market memory market)
    {
        market = Market({
            collateralAsset: params.collateralAsset,
            referenceAsset: params.referenceAsset,
            expiryTimestamp: params.expiryTimestamp,
            rateMin: params.rateMin,
            rateMax: params.rateMax,
            rateChangePerDayMax: params.rateChangePerDayMax,
            rateChangeCapacityMax: params.rateChangeCapacityMax,
            rateOracle: oracle
        });
    }

    function test_createMarket_callsControllerWithCorrectParams() public {
        CorkMarketCreator.CreateParams memory params = _defaultParams();
        address expectedOracle = factory.computeAddress(params.rate);
        Market memory expectedMarket = _expectedMarket(params, expectedOracle);
        MarketId expectedId = MarketId.wrap(keccak256(abi.encode(expectedMarket)));

        vm.expectEmit(true, true, true, true, address(creator));
        emit CorkMarketCreator.MarketCreated(
            expectedId,
            expectedOracle,
            params.collateralAsset,
            params.referenceAsset,
            params.expiryTimestamp,
            params.rate
        );
        creator.createMarket(params);

        assertEq(controller.callCount(), 1, "controller must be called exactly once");
        assertGt(expectedOracle.code.length, 0, "oracle not deployed");

        // Assert EVERY PoolCreationParams field, especially the unwind/swap fee slots.
        PoolCreationParams memory sent = controller.lastParams();
        assertEq(sent.pool.collateralAsset, params.collateralAsset, "pool.collateralAsset");
        assertEq(sent.pool.referenceAsset, params.referenceAsset, "pool.referenceAsset");
        assertEq(sent.pool.expiryTimestamp, params.expiryTimestamp, "pool.expiryTimestamp");
        assertEq(sent.pool.rateMin, params.rateMin, "pool.rateMin");
        assertEq(sent.pool.rateMax, params.rateMax, "pool.rateMax");
        assertEq(sent.pool.rateChangePerDayMax, params.rateChangePerDayMax, "pool.rateChangePerDayMax");
        assertEq(sent.pool.rateChangeCapacityMax, params.rateChangeCapacityMax, "pool.rateChangeCapacityMax");
        assertEq(sent.pool.rateOracle, expectedOracle, "pool.rateOracle");
        assertEq(sent.unwindSwapFeePercentage, params.unwindSwapFeePercentage, "unwindSwapFeePercentage slot");
        assertEq(sent.swapFeePercentage, params.swapFeePercentage, "swapFeePercentage slot");
        assertEq(sent.isWhitelistEnabled, params.isWhitelistEnabled, "isWhitelistEnabled");
    }

    function test_createMarket_repeatRate_revertsAtFactory() public {
        CorkMarketCreator.CreateParams memory params = _defaultParams();
        creator.createMarket(params);
        assertEq(controller.callCount(), 1, "first call must create");

        // The repeat reverts at the oracle factory (CREATE2 salt collision, no error data),
        // before the controller is reached — hence the low-level call instead of expectRevert.
        (bool ok,) = address(creator).call(abi.encodeCall(creator.createMarket, (params)));
        assertFalse(ok, "repeat call must revert");
        assertEq(controller.callCount(), 1, "repeat call must not create a second market");
    }

    function test_createMarket_sameRate_differentFees_revertsAtFactory() public {
        // Same rate means the same oracle salt, so any repeat with that rate — even with
        // different fees — collides at the factory before phoenix's duplicate check.
        CorkMarketCreator.CreateParams memory params = _defaultParams();
        creator.createMarket(params);

        // NOTE: memory-struct assignment aliases, so build a fresh struct instead of copying.
        CorkMarketCreator.CreateParams memory laterParams = _defaultParams();
        laterParams.swapFeePercentage = 3e18;
        laterParams.unwindSwapFeePercentage = 4e18;
        laterParams.isWhitelistEnabled = false;

        (bool ok,) = address(creator).call(abi.encodeCall(creator.createMarket, (laterParams)));
        assertFalse(ok, "different fees must still revert");

        assertEq(controller.callCount(), 1, "different fees must not create a second market");
        assertEq(controller.lastParams().swapFeePercentage, params.swapFeePercentage, "first writer's fee must stick");
    }

    function test_createMarket_sameRate_differentMarket_revertsAtFactory() public {
        // One deploy per rate: even a genuinely different market (different expiry) cannot
        // reuse a rate that has already been used through this factory.
        creator.createMarket(_defaultParams());

        CorkMarketCreator.CreateParams memory other = _defaultParams();
        other.expiryTimestamp = block.timestamp + 2 days;

        (bool ok,) = address(creator).call(abi.encodeCall(creator.createMarket, (other)));
        assertFalse(ok, "same rate can only be used once");
        assertEq(controller.callCount(), 1, "second market must not be created");
    }

    function test_createMarket_pastExpiry_reverts() public {
        CorkMarketCreator.CreateParams memory params = _defaultParams();
        params.expiryTimestamp = block.timestamp; // not strictly in the future

        vm.expectRevert(IPhoenixErrors.InvalidExpiry.selector);
        creator.createMarket(params);
    }

    function test_createMarket_controllerRevert_alreadyInitialized_bubbles() public {
        controller.setRevertData(abi.encodeWithSelector(IPhoenixErrors.AlreadyInitialized.selector));

        vm.expectRevert(IPhoenixErrors.AlreadyInitialized.selector);
        creator.createMarket(_defaultParams());
    }

    function test_createMarket_controllerRevert_invalidParams_bubbles() public {
        controller.setRevertData(abi.encodeWithSelector(IPhoenixErrors.InvalidParams.selector));

        vm.expectRevert(IPhoenixErrors.InvalidParams.selector);
        creator.createMarket(_defaultParams());
    }

    function test_constructor_zeroController_reverts() public {
        vm.expectRevert(CorkMarketCreator.ZeroAddress.selector);
        new CorkMarketCreator(IDefaultCorkController(address(0)), poolManager, factory);
    }

    function test_constructor_zeroPoolManager_reverts() public {
        vm.expectRevert(CorkMarketCreator.ZeroAddress.selector);
        new CorkMarketCreator(controller, IPoolManager(address(0)), factory);
    }

    function test_constructor_zeroOracleFactory_reverts() public {
        vm.expectRevert(CorkMarketCreator.ZeroAddress.selector);
        new CorkMarketCreator(controller, poolManager, FixedRateOracleFactory(address(0)));
    }
}
