// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract LeaseController {
    uint256 public constant MAX_HEARTBEAT_INTERVAL = 1 days;
    uint256 public constant MAX_STALE_GRACE_PERIOD = 7 days;

    enum LeaseStatus {
        ACTIVE,
        DEGRADED,
        FROZEN,
        REVOKED,
        EXPIRED
    }

    enum TrustPosture {
        GREEN,
        YELLOW,
        RED
    }

    struct Lease {
        address owner;
        address agent;
        address spendToken; // address(0) is native ETH in V1.
        uint256 maxSpend;
        uint256 spent;
        uint256 deposited;
        address allowedTarget;
        bytes4 allowedSelector;
        bytes32 allowedCalldataHash; // Optional. When nonzero, the exact calldata must match.
        uint64 heartbeatInterval;
        uint64 staleGracePeriod;
        uint64 lastHeartbeat;
        uint64 expiresAt;
        bytes32 policyHash;
        bytes32 ensNamehash;
        LeaseStatus status;
    }

    uint256 public nextLeaseId = 1;
    mapping(uint256 => Lease) private leases;

    event LeaseCreated(
        uint256 indexed leaseId,
        address indexed owner,
        address indexed agent,
        address spendToken,
        uint256 maxSpend,
        address allowedTarget,
        bytes4 allowedSelector,
        bytes32 allowedCalldataHash,
        uint64 heartbeatInterval,
        uint64 staleGracePeriod,
        uint64 expiresAt,
        bytes32 policyHash,
        bytes32 ensNamehash
    );
    event LeaseFunded(uint256 indexed leaseId, address indexed funder, uint256 amount);
    event AgentHeartbeat(uint256 indexed leaseId, address indexed agent, uint64 timestamp);
    event ActionExecuted(uint256 indexed leaseId, address indexed agent, address target, uint256 value, bytes data);
    event ActionRefused(uint256 indexed leaseId, address indexed agent, string reason);
    event LeaseDegraded(uint256 indexed leaseId, string reason);
    event LeaseFrozen(uint256 indexed leaseId, string reason);
    event LeaseRevoked(uint256 indexed leaseId);
    event LeaseExpired(uint256 indexed leaseId);
    event UnspentWithdrawn(uint256 indexed leaseId, address indexed owner, uint256 amount);

    error InvalidAgent();
    error InvalidTarget();
    error InvalidSelector();
    error InvalidTiming();
    error InvalidSpendToken();
    error InvalidLease();
    error NotOwner();
    error NotAgent();
    error LeaseStillActive();
    error TransferFailed();

    modifier existingLease(uint256 leaseId) {
        if (leaseId == 0 || leaseId >= nextLeaseId) revert InvalidLease();
        _;
    }

    modifier onlyOwner(uint256 leaseId) {
        if (msg.sender != leases[leaseId].owner) revert NotOwner();
        _;
    }

    modifier onlyAgent(uint256 leaseId) {
        if (msg.sender != leases[leaseId].agent) revert NotAgent();
        _;
    }

    receive() external payable {}

    function createLease(
        address agent,
        address spendToken,
        uint256 maxSpend,
        address allowedTarget,
        bytes4 allowedSelector,
        bytes32 allowedCalldataHash,
        uint64 heartbeatInterval,
        uint64 staleGracePeriod,
        uint64 expiresAt,
        bytes32 policyHash,
        bytes32 ensNamehash
    ) external payable returns (uint256 leaseId) {
        if (agent == address(0)) revert InvalidAgent();
        if (allowedTarget == address(0)) revert InvalidTarget();
        if (allowedSelector == bytes4(0)) revert InvalidSelector();
        if (spendToken != address(0)) revert InvalidSpendToken();
        if (
            heartbeatInterval == 0 ||
            heartbeatInterval > MAX_HEARTBEAT_INTERVAL ||
            staleGracePeriod > MAX_STALE_GRACE_PERIOD ||
            expiresAt <= block.timestamp
        ) {
            revert InvalidTiming();
        }
        if (msg.value > maxSpend) revert InvalidTiming();

        leaseId = nextLeaseId++;
        leases[leaseId] = Lease({
            owner: msg.sender,
            agent: agent,
            spendToken: spendToken,
            maxSpend: maxSpend,
            spent: 0,
            deposited: msg.value,
            allowedTarget: allowedTarget,
            allowedSelector: allowedSelector,
            allowedCalldataHash: allowedCalldataHash,
            heartbeatInterval: heartbeatInterval,
            staleGracePeriod: staleGracePeriod,
            lastHeartbeat: uint64(block.timestamp),
            expiresAt: expiresAt,
            policyHash: policyHash,
            ensNamehash: ensNamehash,
            status: LeaseStatus.ACTIVE
        });

        emit LeaseCreated(
            leaseId,
            msg.sender,
            agent,
            spendToken,
            maxSpend,
            allowedTarget,
            allowedSelector,
            allowedCalldataHash,
            heartbeatInterval,
            staleGracePeriod,
            expiresAt,
            policyHash,
            ensNamehash
        );

        if (msg.value > 0) {
            emit LeaseFunded(leaseId, msg.sender, msg.value);
        }
    }

    function fundLease(uint256 leaseId) external payable existingLease(leaseId) {
        Lease storage lease = leases[leaseId];
        if (msg.value == 0) revert InvalidTiming();
        if (lease.spent + lease.deposited + msg.value > lease.maxSpend) revert InvalidTiming();
        lease.deposited += msg.value;
        emit LeaseFunded(leaseId, msg.sender, msg.value);
    }

    function heartbeat(uint256 leaseId) external existingLease(leaseId) onlyAgent(leaseId) {
        Lease storage lease = leases[leaseId];
        LeaseStatus status = currentStatus(leaseId);
        if (status == LeaseStatus.FROZEN || status == LeaseStatus.REVOKED || status == LeaseStatus.EXPIRED) {
            emit ActionRefused(leaseId, msg.sender, "LEASE_NOT_ACTIVE");
            return;
        }

        lease.lastHeartbeat = uint64(block.timestamp);
        lease.status = LeaseStatus.ACTIVE;

        emit AgentHeartbeat(leaseId, msg.sender, uint64(block.timestamp));
    }

    function executeAction(
        uint256 leaseId,
        address target,
        uint256 value,
        bytes calldata data
    ) external existingLease(leaseId) onlyAgent(leaseId) returns (bool ok, bytes memory result) {
        Lease storage lease = leases[leaseId];
        LeaseStatus status = currentStatus(leaseId);
        if (status != LeaseStatus.ACTIVE) {
            emit ActionRefused(leaseId, msg.sender, _statusReason(status));
            return (false, "");
        }
        if (target != lease.allowedTarget) {
            emit ActionRefused(leaseId, msg.sender, "TARGET_NOT_ALLOWED");
            return (false, "");
        }
        if (data.length < 4 || _selectorOf(data) != lease.allowedSelector) {
            emit ActionRefused(leaseId, msg.sender, "SELECTOR_NOT_ALLOWED");
            return (false, "");
        }
        if (lease.allowedCalldataHash != bytes32(0) && keccak256(data) != lease.allowedCalldataHash) {
            emit ActionRefused(leaseId, msg.sender, "CALLDATA_NOT_ALLOWED");
            return (false, "");
        }
        if (lease.spent + value > lease.maxSpend) {
            emit ActionRefused(leaseId, msg.sender, "SPEND_LIMIT_EXCEEDED");
            return (false, "");
        }
        if (lease.deposited < value) {
            emit ActionRefused(leaseId, msg.sender, "INSUFFICIENT_LEASE_BALANCE");
            return (false, "");
        }

        lease.spent += value;
        lease.deposited -= value;
        (ok, result) = target.call{value: value}(data);
        if (!ok) {
            lease.spent -= value;
            lease.deposited += value;
            emit ActionRefused(leaseId, msg.sender, "TARGET_CALL_FAILED");
            return (false, result);
        }

        emit ActionExecuted(leaseId, msg.sender, target, value, data);
    }

    function degradeLease(uint256 leaseId) external existingLease(leaseId) {
        Lease storage lease = leases[leaseId];
        LeaseStatus status = currentStatus(leaseId);
        if (status != LeaseStatus.DEGRADED) {
            emit ActionRefused(leaseId, lease.agent, "LEASE_NOT_DEGRADABLE");
            return;
        }
        lease.status = LeaseStatus.DEGRADED;
        emit LeaseDegraded(leaseId, "HEARTBEAT_LATE");
    }

    function freezeLease(uint256 leaseId) external existingLease(leaseId) {
        Lease storage lease = leases[leaseId];
        LeaseStatus status = currentStatus(leaseId);
        if (status != LeaseStatus.FROZEN) {
            emit ActionRefused(leaseId, lease.agent, "LEASE_NOT_FREEZABLE");
            return;
        }
        lease.status = LeaseStatus.FROZEN;
        emit LeaseFrozen(leaseId, "HEARTBEAT_MISSED");
    }

    function revokeLease(uint256 leaseId) external existingLease(leaseId) onlyOwner(leaseId) {
        Lease storage lease = leases[leaseId];
        if (lease.status == LeaseStatus.REVOKED) return;
        lease.status = LeaseStatus.REVOKED;
        emit LeaseRevoked(leaseId);
    }

    function expireLease(uint256 leaseId) external existingLease(leaseId) {
        Lease storage lease = leases[leaseId];
        if (currentStatus(leaseId) != LeaseStatus.EXPIRED) {
            emit ActionRefused(leaseId, lease.agent, "LEASE_NOT_EXPIRED");
            return;
        }
        lease.status = LeaseStatus.EXPIRED;
        emit LeaseExpired(leaseId);
    }

    function withdrawUnspent(uint256 leaseId) external existingLease(leaseId) onlyOwner(leaseId) {
        LeaseStatus status = currentStatus(leaseId);
        if (status == LeaseStatus.ACTIVE || status == LeaseStatus.DEGRADED) revert LeaseStillActive();

        Lease storage lease = leases[leaseId];
        uint256 remaining = lease.deposited;
        lease.deposited = 0;
        if (lease.maxSpend > lease.spent) {
            lease.maxSpend = lease.spent;
        }
        if (remaining > 0) {
            (bool success, ) = payable(lease.owner).call{value: remaining}("");
            if (!success) revert TransferFailed();
        }
        emit UnspentWithdrawn(leaseId, lease.owner, remaining);
    }

    function currentStatus(uint256 leaseId) public view existingLease(leaseId) returns (LeaseStatus) {
        Lease storage lease = leases[leaseId];
        if (
            lease.status == LeaseStatus.FROZEN ||
            lease.status == LeaseStatus.REVOKED ||
            lease.status == LeaseStatus.EXPIRED
        ) {
            return lease.status;
        }
        if (block.timestamp >= lease.expiresAt) {
            return LeaseStatus.EXPIRED;
        }

        uint256 lateAt = uint256(lease.lastHeartbeat) + uint256(lease.heartbeatInterval);
        uint256 freezeAt = lateAt + uint256(lease.staleGracePeriod);
        if (block.timestamp > freezeAt) {
            return LeaseStatus.FROZEN;
        }
        if (block.timestamp > lateAt) {
            return LeaseStatus.DEGRADED;
        }
        return LeaseStatus.ACTIVE;
    }

    function trustPosture(uint256 leaseId) external view existingLease(leaseId) returns (TrustPosture) {
        LeaseStatus status = currentStatus(leaseId);
        if (status == LeaseStatus.ACTIVE) return TrustPosture.GREEN;
        if (status == LeaseStatus.DEGRADED) return TrustPosture.YELLOW;
        return TrustPosture.RED;
    }

    function getLease(uint256 leaseId) external view existingLease(leaseId) returns (Lease memory lease) {
        lease = leases[leaseId];
        lease.status = currentStatus(leaseId);
    }

    function _statusReason(LeaseStatus status) private pure returns (string memory) {
        if (status == LeaseStatus.DEGRADED) return "LEASE_DEGRADED";
        if (status == LeaseStatus.FROZEN) return "LEASE_FROZEN";
        if (status == LeaseStatus.REVOKED) return "LEASE_REVOKED";
        if (status == LeaseStatus.EXPIRED) return "LEASE_EXPIRED";
        return "LEASE_NOT_ACTIVE";
    }

    function _selectorOf(bytes calldata data) private pure returns (bytes4 selector) {
        assembly {
            selector := calldataload(data.offset)
        }
    }
}
