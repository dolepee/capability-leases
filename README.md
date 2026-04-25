# Capability Leases

Onchain authority leases for autonomous agents.

Capability Leases lets an owner grant an agent narrow, expiring authority:

- allowed target contract
- allowed function selector
- optional exact calldata hash for route-level constraints
- max spend
- heartbeat interval
- stale grace window
- automatic degrade/freeze/revoke/expire states

The thesis is simple: an agent's power should expire unless trust is continuously earned.

## Current Scope

This repo starts with the contract primitive and regression tests:

- `LeaseController.sol`
- `MockActionRouter.sol`
- Node test suite using Ganache, Solc, and Viem
- local demo script that runs the full create -> heartbeat -> execute -> refuse -> freeze loop
- browser demo explorer with a KeeperHub-compatible execution adapter

KeeperHub is the execution layer for the prize-ready path:

- local mode uses the same adapter interface with a dev signer
- production mode calls KeeperHub Direct Execution API
- stale leases are degraded/frozen through the adapter, not raw UI code

ENS is the public trust handle layer:

- `guarded-agent.eth` resolves to the agent/controller
- ENS text records point to registry, lease id, policy hash, trust URL, and guardian
- UI accepts either raw address or ENS name

## Commands

```bash
npm install
npm test
npm run compile
npm run preflight
npm run deploy
npm run ens:check -- agent.yourname.eth
npm run demo:local
npm run demo:web
```

`npm run demo:web` starts a local browser demo at `http://localhost:4317`.

Demo sequence:

1. Create lease.
2. Heartbeat.
3. Run valid action.
4. Run invalid route.
5. Miss heartbeat.
6. Miss grace.

The keeper loop scans watched leases and records degrade/freeze receipts.

Local mode defaults to a longer `120s + 60s` heartbeat window so manual clicking does not accidentally degrade the lease before the valid action. The `Miss heartbeat` and `Miss grace` buttons jump to the exact local-chain thresholds.

For a public testnet demo, run the same browser surface in deployed mode:

```bash
DEMO_MODE=deployed
RPC_URL=https://...
CHAIN_ID=11155111
OWNER_PRIVATE_KEY=0x...
AGENT_PRIVATE_KEY=0x...
LEASE_CONTROLLER_ADDRESS=0x...
MOCK_ACTION_ROUTER_ADDRESS=0x...
DEMO_MAX_SPEND_ETH=0.001
DEMO_ACTION_VALUE_ETH=0.0001
DEMO_HEARTBEAT_INTERVAL_SECONDS=20
DEMO_STALE_GRACE_SECONDS=20
DEMO_EXPIRES_SECONDS=600
npm run demo:web
```

In deployed mode, the UI cannot time-travel. Let the heartbeat window pass on the live chain, then trigger a keeper scan.

## Prize-Ready Environment

Local mode is useful for development, but it is not the final KeeperHub/ENS submission path.

KeeperHub Direct Execution:

```bash
KEEPERHUB_MODE=keeperhub-direct
KEEPERHUB_API_BASE=https://app.keeperhub.com
KEEPERHUB_API_KEY=keeper_...
KEEPERHUB_WALLET_ID=...
KEEPERHUB_NETWORK=sepolia
```

Deploy contracts:

```bash
RPC_URL=https://...
PRIVATE_KEY=0x...
CHAIN_ID=11155111
CHAIN_NAME=Sepolia
NATIVE_SYMBOL=ETH
npm run deploy
```

ENS lookup:

```bash
ETHEREUM_RPC_URL=https://...
AGENT_ENS_NAME=agent.yourname.eth
npm run ens:check -- agent.yourname.eth
```

Required ENS text records for the named agent:

```txt
capabilityLeases.registry = 0xLeaseController
capabilityLeases.leaseId = 1
capabilityLeases.policyHash = 0x...
capabilityLeases.trustUrl = https://...
capabilityLeases.guardian = 0xGuardian
```

The browser shows whether KeeperHub credentials and ENS RPC are configured. If ENS is not configured, the UI labels the name as a placeholder instead of pretending it is prize-ready.

## Track Prize Checklist

KeeperHub:

- `KEEPERHUB_MODE=keeperhub-direct`
- `KEEPERHUB_API_KEY` set
- `KEEPERHUB_WALLET_ID` set
- demo receipt shows `provider=keeperhub-direct-execution`

ENS:

- real ENS name or subname resolves to an address
- required `capabilityLeases.*` text records are present
- app resolves the name from RPC, not hard-coded state

Repo:

- `npm test` passes
- `npm run preflight` has no critical warnings
- `deployments/<chainId>.json` exists after testnet deploy

## V1 Contract Boundary

V1 intentionally keeps policy narrow. A lease can bind:

- agent
- max native spend
- allowed target
- allowed function selector
- optional exact calldata hash
- heartbeat interval
- stale grace window
- expiry
- policy hash
- ENS namehash

The calldata hash matters. Without it, a lease could allow the same function selector with different route arguments. With it, a demo lease can prove "this exact action is allowed; nearby actions are refused."
