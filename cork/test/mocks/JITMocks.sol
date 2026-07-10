// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPoolManager, Market, MarketId} from "../../src/interfaces/IPoolManager.sol";
import {IOrderMixin, Address, MakerTraits} from "../../src/interfaces/I1inchLimitOrderProtocol.sol";
import {CorkLimitOrderAdapter} from "../../src/CorkLimitOrderAdapter.sol";

/// @dev Minimal ERC-20 for JIT tests. `noReturnData` mimics USDT-style tokens whose
///      `transferFrom`/`approve` return nothing, to exercise the hook's safe-ERC20 paths.
contract MockERC20 {
    string public name;
    uint8 public decimals;
    bool public noReturnData;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, uint8 decimals_, bool noReturnData_) {
        name = name_;
        decimals = decimals_;
        noReturnData = noReturnData_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    /// @dev Test helper: set an allowance directly, bypassing `approve`'s return-data chopping
    ///      (a high-level `approve` call on a no-return token reverts at the caller's decode).
    function setAllowance(address owner, address spender, uint256 amount) external {
        allowance[owner][spender] = amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        _handleReturn();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "MockERC20: balance");
        require(allowance[from][msg.sender] >= amount, "MockERC20: allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        _handleReturn();
        return true;
    }

    /// @dev For `noReturnData` tokens, chop the return data like USDT does.
    function _handleReturn() internal view {
        if (noReturnData) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
    }
}

/// @dev Full-featured pool manager mock for the JIT hook: mirrors the phoenix `mint` surface —
///      `previewMint` ceil-divides shares (18 dec) into CA native decimals, `mint` pulls the CA
///      from `msg.sender` and mints both share legs to `receiver`. `setPaused` makes
///      `previewMint` return 0 (phoenix behavior when paused/expired); `setDriftBps` makes
///      `mint` spend more than `previewMint` quoted, to exercise the drift guard.
contract MockJITPoolManager is IPoolManager {
    MockERC20 public collateral;
    MockERC20 public cpt;
    MockERC20 public cst;
    Market internal _market;
    MarketId public poolId;

    bool public paused;
    uint256 public driftBps;

    constructor(MockERC20 collateral_) {
        collateral = collateral_;
        cpt = new MockERC20("cPT", 18, false);
        cst = new MockERC20("cST", 18, false);
        _market.collateralAsset = address(collateral_);
        _market.referenceAsset = address(0x4Efe4e4Ce);
        _market.expiryTimestamp = block.timestamp + 1 days;
        poolId = MarketId.wrap(keccak256(abi.encode(_market)));
    }

    function setPaused(bool paused_) external {
        paused = paused_;
    }

    function setDriftBps(uint256 driftBps_) external {
        driftBps = driftBps_;
    }

    function getId(Market calldata marketParameters) external pure returns (MarketId marketId) {
        marketId = MarketId.wrap(keccak256(abi.encode(marketParameters)));
    }

    function market(MarketId id) external view returns (Market memory parameters) {
        if (MarketId.unwrap(id) == MarketId.unwrap(poolId)) parameters = _market;
    }

    function shares(MarketId) external view returns (address principalToken, address swapToken) {
        principalToken = address(cpt);
        swapToken = address(cst);
    }

    function previewMint(MarketId, uint256 cptAndCstSharesOut) public view returns (uint256 collateralAssetsIn) {
        if (paused) return 0;
        // fixedToTokenNativeDecimalsWithCeilDiv, like phoenix.
        uint256 scale = 10 ** collateral.decimals();
        collateralAssetsIn = (cptAndCstSharesOut * scale + 1e18 - 1) / 1e18;
    }

    function mint(MarketId id, uint256 cptAndCstSharesOut, address receiver)
        external
        returns (uint256 collateralAssetsIn)
    {
        collateralAssetsIn = previewMint(id, cptAndCstSharesOut);
        collateralAssetsIn += (collateralAssetsIn * driftBps) / 10_000;
        // Low-level pull, like phoenix's SafeERC20: tolerates no-return-data collateral.
        (bool ok, bytes memory data) = address(collateral)
            .call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256)", msg.sender, address(this), collateralAssetsIn
                )
            );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "MockJITPoolManager: pull failed");
        cpt.mint(receiver, cptAndCstSharesOut);
        cst.mint(receiver, cptAndCstSharesOut);
    }
}

/// @dev Stands in for the 1inch LOP: the only address allowed to invoke the hook callbacks.
///      Forwards constructed orders into either callback.
contract MockLimitOrderProtocol {
    function callPreInteraction(
        CorkLimitOrderAdapter hook,
        IOrderMixin.Order memory order,
        uint256 makingAmount,
        uint256 takingAmount,
        bytes memory extraData
    ) external {
        hook.preInteraction(order, "", bytes32(0), address(0), makingAmount, takingAmount, 0, extraData);
    }

    function callTakerInteraction(
        CorkLimitOrderAdapter hook,
        IOrderMixin.Order memory order,
        address taker,
        uint256 makingAmount,
        uint256 takingAmount,
        bytes memory extraData
    ) external {
        hook.takerInteraction(order, "", bytes32(0), taker, makingAmount, takingAmount, 0, extraData);
    }
}

/// @dev Order construction helpers shared by the JIT tests.
library OrderBuilder {
    function build(address maker, address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount)
        internal
        pure
        returns (IOrderMixin.Order memory order)
    {
        order = IOrderMixin.Order({
            salt: 1,
            maker: Address.wrap(uint256(uint160(maker))),
            receiver: Address.wrap(0),
            makerAsset: Address.wrap(uint256(uint160(makerAsset))),
            takerAsset: Address.wrap(uint256(uint160(takerAsset))),
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            makerTraits: MakerTraits.wrap(0)
        });
    }
}
