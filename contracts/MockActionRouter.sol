// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockActionRouter {
    event RouteExecuted(address indexed caller, bytes32 indexed routeId, uint256 value);
    event AlternativeRouteExecuted(address indexed caller, bytes32 indexed routeId, uint256 value);

    function executeRoute(bytes32 routeId) external payable returns (bool) {
        emit RouteExecuted(msg.sender, routeId, msg.value);
        return true;
    }

    function executeAlternative(bytes32 routeId) external payable returns (bool) {
        emit AlternativeRouteExecuted(msg.sender, routeId, msg.value);
        return true;
    }

    function revertRoute(bytes32) external pure returns (bool) {
        revert("MOCK_ROUTE_REVERTED");
    }
}
