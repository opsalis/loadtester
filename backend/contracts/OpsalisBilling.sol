// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * OpsalisBilling — shared billing contract for Opsalis-network services.
 *
 * One deployment serves many services. Each service has its own revenue wallet,
 * registered by the deployer (platform operator) via setServiceRevenueWallet.
 *
 * Customers call pay(serviceId, productId, amount). USDC is transferred via
 * transferFrom from the customer to the service's revenue wallet. A Paid event
 * is emitted with the full context so backends can verify payment by tx hash.
 *
 * Free-tier (amount == 0) calls still emit a Paid event for accounting parity.
 *
 * serviceId   = keccak256(bytes(service-slug))   — e.g. keccak256("loadtester")
 * productId   = keccak256(bytes(product-slug))   — e.g. keccak256("pro")
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract OpsalisBilling {
    address public owner;
    IERC20 public immutable usdc;

    // serviceId => revenue wallet
    mapping(bytes32 => address) public serviceRevenueWallet;

    event Paid(
        bytes32 indexed serviceId,
        bytes32 indexed productId,
        address indexed customer,
        uint256 amount,
        uint256 timestamp
    );

    event ServiceRegistered(bytes32 indexed serviceId, address revenueWallet);
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "OpsalisBilling: not owner");
        _;
    }

    constructor(address _usdc) {
        require(_usdc != address(0), "OpsalisBilling: usdc zero");
        owner = msg.sender;
        usdc = IERC20(_usdc);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "OpsalisBilling: zero owner");
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setServiceRevenueWallet(bytes32 serviceId, address wallet) external onlyOwner {
        require(wallet != address(0), "OpsalisBilling: zero wallet");
        serviceRevenueWallet[serviceId] = wallet;
        emit ServiceRegistered(serviceId, wallet);
    }

    /**
     * Pay for a service/product.
     * Customer must have approved `amount` USDC to this contract beforehand.
     * If amount == 0 (free tier accounting), no transfer happens but event still fires.
     */
    function pay(bytes32 serviceId, bytes32 productId, uint256 amount) external {
        address wallet = serviceRevenueWallet[serviceId];
        require(wallet != address(0), "OpsalisBilling: service not registered");

        if (amount > 0) {
            bool ok = usdc.transferFrom(msg.sender, wallet, amount);
            require(ok, "OpsalisBilling: usdc transfer failed");
        }

        emit Paid(serviceId, productId, msg.sender, amount, block.timestamp);
    }
}
