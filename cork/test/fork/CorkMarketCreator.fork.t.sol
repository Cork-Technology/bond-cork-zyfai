// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {CorkMarketCreator} from "../../src/CorkMarketCreator.sol";
import {FixedRateOracleFactory} from "../../src/FixedRateOracleFactory.sol";
import {IDefaultCorkController} from "../../src/interfaces/IDefaultCorkController.sol";
import {IPoolManager, Market, MarketId} from "../../src/interfaces/IPoolManager.sol";

/// @dev Access-control surface of DefaultCorkController needed for the wiring step.
interface IAccessControlLike {
    function grantRole(bytes32 role, address account) external;
}

/// @dev Fee getters on the real CorkPoolManager (not part of the vendored minimal interface).
interface IPoolManagerFees {
    function swapFee(MarketId poolId) external view returns (uint256 fees);
    function unwindSwapFee(MarketId poolId) external view returns (uint256 fees);
}

/// @dev Phoenix errors expected to bubble up through the creator. NOTE: phoenix's
///      `IErrors.InvalidRate()` has the same signature and selector as `IRateOracle.InvalidRate()`;
///      this local declaration makes it explicit which error the fork assertions target.
interface IPhoenixForkErrors {
    error InvalidRate();
}

/// @dev Minimal ERC-20 satisfying phoenix's token requirements (non-rebasing, decimals <= 18).
contract ForkTestERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }
}

/// @notice Arbitrum fork test against a real Phoenix stack.
/// @dev Gated on ARBITRUM_RPC_URL being nonempty — skips cleanly otherwise. Stack addresses come
///      from the CONTROLLER, POOL_MANAGER, and ADMIN environment variables (either the shadow
///      Phoenix deployment or a throwaway stack deployed onto a local Arbitrum fork).
contract CorkMarketCreatorForkTest is Test {
    bytes32 internal constant POOL_CREATOR_ROLE = keccak256("POOL_CREATOR_ROLE");

    bool internal forkConfigured;

    IDefaultCorkController internal controller;
    IPoolManager internal poolManager;
    address internal admin;

    FixedRateOracleFactory internal factory;
    CorkMarketCreator internal creator;

    ForkTestERC20 internal collateralAsset;
    ForkTestERC20 internal referenceAsset;

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_RPC_URL", string(""));
        forkConfigured = bytes(rpcUrl).length != 0;
        if (!forkConfigured) return;

        vm.createSelectFork(rpcUrl);

        controller = IDefaultCorkController(vm.envAddress("CONTROLLER"));
        poolManager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        admin = vm.envAddress("ADMIN");

        factory = new FixedRateOracleFactory();
        creator = new CorkMarketCreator(controller, poolManager, factory);

        // The one privileged wiring step: admin grants POOL_CREATOR_ROLE to the creator.
        vm.prank(admin);
        IAccessControlLike(address(controller)).grantRole(POOL_CREATOR_ROLE, address(creator));

        collateralAsset = new ForkTestERC20("Collateral Asset", "CA", 18);
        referenceAsset = new ForkTestERC20("Reference Asset", "REF", 18);
    }

    /// @dev The confirmed fixed-rate recipe: rateMin = rate, rateMax = rate + 1, both rate-change
    ///      clamps zero. Fees deliberately distinct (1% swap, 2% unwind) to catch slot mix-ups.
    function _recipeParams() internal view returns (CorkMarketCreator.CreateParams memory params) {
        params = CorkMarketCreator.CreateParams({
            collateralAsset: address(collateralAsset),
            referenceAsset: address(referenceAsset),
            expiryTimestamp: block.timestamp + 1 days,
            rate: 0.8e18,
            rateMin: 0.8e18,
            rateMax: 0.8e18 + 1,
            rateChangePerDayMax: 0,
            rateChangeCapacityMax: 0,
            swapFeePercentage: 1e18, // 1%
            unwindSwapFeePercentage: 2e18, // 2%
            isWhitelistEnabled: false
        });
    }

    function _marketOf(CorkMarketCreator.CreateParams memory params, address oracle)
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

    function _idOf(CorkMarketCreator.CreateParams memory params) internal view returns (MarketId id) {
        id = MarketId.wrap(keccak256(abi.encode(_marketOf(params, factory.computeAddress(params.rate)))));
    }

    function test_fork_createMarket_happyPath() public {
        vm.skip(!forkConfigured);

        CorkMarketCreator.CreateParams memory params = _recipeParams();
        address expectedOracle = factory.computeAddress(params.rate);
        MarketId expectedId = _idOf(params);

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

        // Market exists on the real pool manager with the exact fields we sent.
        Market memory stored = poolManager.market(expectedId);
        assertEq(stored.collateralAsset, params.collateralAsset, "stored collateralAsset");
        assertEq(stored.referenceAsset, params.referenceAsset, "stored referenceAsset");
        assertEq(stored.expiryTimestamp, params.expiryTimestamp, "stored expiryTimestamp");
        assertEq(stored.rateMin, params.rateMin, "stored rateMin");
        assertEq(stored.rateMax, params.rateMax, "stored rateMax");
        assertEq(stored.rateChangePerDayMax, 0, "stored rateChangePerDayMax");
        assertEq(stored.rateChangeCapacityMax, 0, "stored rateChangeCapacityMax");
        assertEq(stored.rateOracle, expectedOracle, "stored rateOracle");

        // Oracle deployed at the precomputed CREATE2 address.
        assertGt(expectedOracle.code.length, 0, "oracle not deployed at precomputed address");
    }

    function test_fork_createMarket_repeatCall_reverts() public {
        vm.skip(!forkConfigured);

        CorkMarketCreator.CreateParams memory params = _recipeParams();
        creator.createMarket(params);

        // The repeat reverts at the oracle factory (CREATE2 salt collision, no error data),
        // before phoenix's duplicate check — hence the low-level call instead of expectRevert.
        (bool ok,) = address(creator).call(abi.encodeCall(creator.createMarket, (params)));
        assertFalse(ok, "repeat call must revert");
    }

    function test_fork_createMarket_oracleRateOutsideBand_bubblesPhoenixRevert() public {
        vm.skip(!forkConfigured);

        // Oracle rate (0.8e18) below the band [0.9e18, 1e18] -> bootstrap reverts InvalidRate().
        CorkMarketCreator.CreateParams memory params = _recipeParams();
        params.rateMin = 0.9e18;
        params.rateMax = 1e18;

        vm.expectRevert(IPhoenixForkErrors.InvalidRate.selector);
        creator.createMarket(params);
    }

    function test_fork_createMarket_frontRun_firstWriterWins() public {
        vm.skip(!forkConfigured);

        CorkMarketCreator.CreateParams memory victimParams = _recipeParams();
        MarketId id = _idOf(victimParams);

        // Attacker front-runs with the victim's Market fields but different fees.
        CorkMarketCreator.CreateParams memory attackerParams = _recipeParams();
        attackerParams.swapFeePercentage = 5e18; // 5%, the maximum
        attackerParams.unwindSwapFeePercentage = 5e18;
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        creator.createMarket(attackerParams);

        // Victim's call reverts at the oracle factory (the attacker already used this rate,
        // so the CREATE2 salt collides — no error data, hence the low-level call)...
        (bool ok,) = address(creator).call(abi.encodeCall(creator.createMarket, (victimParams)));
        assertFalse(ok, "victim's call must revert");

        // ...and the stored configuration is the ATTACKER's, not the victim's intended fees.
        uint256 storedSwapFee = IPoolManagerFees(address(poolManager)).swapFee(id);
        uint256 storedUnwindFee = IPoolManagerFees(address(poolManager)).unwindSwapFee(id);
        assertEq(storedSwapFee, attackerParams.swapFeePercentage, "first writer's swap fee must be stored");
        assertNotEq(storedSwapFee, victimParams.swapFeePercentage, "stored swap fee must differ from victim's");
        assertNotEq(storedUnwindFee, victimParams.unwindSwapFeePercentage, "stored unwind fee must differ");
    }

    function test_fork_feeReadBack_matchesIntendedScale() public {
        vm.skip(!forkConfigured);

        // Catches a silent 100x scale failure: 1e18 must read back as 1e18 (= 1%).
        CorkMarketCreator.CreateParams memory params = _recipeParams();
        creator.createMarket(params);
        MarketId id = _idOf(params);

        assertEq(IPoolManagerFees(address(poolManager)).swapFee(id), params.swapFeePercentage, "swap fee read-back");
        assertEq(
            IPoolManagerFees(address(poolManager)).unwindSwapFee(id),
            params.unwindSwapFeePercentage,
            "unwind fee read-back"
        );
    }
}
