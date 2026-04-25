# Capability Leases Track Demo Runbook

Use this when moving from local proof to public testnet proof.

## 1. Local Verification

```bash
npm install
npm run compile
npm test
npm run preflight
PORT=4317 npm run demo:web
```

Local browser sequence:

1. Create lease.
2. Heartbeat.
3. Valid action.
4. Invalid route.
5. Miss heartbeat.
6. Miss grace.
7. Confirm final posture is `RED / FROZEN`.

Local mode uses a longer default heartbeat window for manual clicking. The miss buttons jump the local chain to the exact degradation/freeze thresholds.

## 2. Deploy Contracts

Use a funded deployer key on the target testnet.

```bash
export RPC_URL=https://...
export PRIVATE_KEY=0x...
export CHAIN_ID=11155111
export CHAIN_NAME=Sepolia
export NATIVE_SYMBOL=ETH
export DEPLOY_MOCK_ROUTER=true
npm run deploy
```

Copy addresses from `deployments/<chainId>.json`.

## 3. Configure KeeperHub

KeeperHub must own the stale-lease execution path in the prize demo.

```bash
export KEEPERHUB_MODE=keeperhub-direct
export KEEPERHUB_API_BASE=https://app.keeperhub.com
export KEEPERHUB_API_KEY=keeper_...
export KEEPERHUB_WALLET_ID=...
export KEEPERHUB_NETWORK=sepolia
```

The demo timeline must show:

```txt
provider=keeperhub-direct-execution
```

If it shows `local-dev-keeper`, the demo is not KeeperHub prize-ready.

## 4. Configure ENS

Use a real ENS name or subname. Required records:

```txt
addr = 0xAgentOrController
capabilityLeases.registry = 0xLeaseController
capabilityLeases.leaseId = <current lease id>
capabilityLeases.policyHash = 0x...
capabilityLeases.trustUrl = https://...
capabilityLeases.guardian = 0xGuardianOrKeeperHubWallet
```

Verify:

```bash
export ETHEREUM_RPC_URL=https://...
npm run ens:check -- agent.yourname.eth
```

If this fails, do not claim ENS prize readiness.

## 5. Run Deployed Browser Demo

```bash
export DEMO_MODE=deployed
export RPC_URL=https://...
export CHAIN_ID=11155111
export CHAIN_NAME=Sepolia
export NATIVE_SYMBOL=ETH
export OWNER_PRIVATE_KEY=0x...
export AGENT_PRIVATE_KEY=0x...
export LEASE_CONTROLLER_ADDRESS=0x...
export MOCK_ACTION_ROUTER_ADDRESS=0x...
export DEMO_MAX_SPEND_ETH=0.001
export DEMO_ACTION_VALUE_ETH=0.0001
export DEMO_HEARTBEAT_INTERVAL_SECONDS=20
export DEMO_STALE_GRACE_SECONDS=20
export DEMO_EXPIRES_SECONDS=600
npm run demo:web
```

Live-chain sequence:

1. Create lease.
2. Heartbeat.
3. Valid action.
4. Invalid route.
5. Wait past heartbeat interval.
6. Keeper scan: should degrade.
7. Wait past grace.
8. Keeper scan: should freeze.
9. Resolve ENS name.
10. Show counterparty refuses delegation because posture is red.

## 6. Record Demo

Three-minute structure:

1. Problem: agents should not hold permanent authority.
2. Create named agent lease.
3. Valid action succeeds.
4. Invalid action is refused by the contract.
5. KeeperHub freezes authority after missed heartbeat.
6. ENS trust handle resolves current posture.
7. Counterparty refuses delegation to the red agent.

## 7. Submission Claims

Safe claims:

- Onchain capability lease state machine.
- KeeperHub-compatible execution adapter.
- KeeperHub Direct Execution path when env is configured.
- ENS trust-handle resolver and required text record validation.
- Local and deployed browser demo modes.

Do not claim:

- Gensyn integration unless two AXL nodes are actually shown.
- Uniswap prize eligibility unless `FEEDBACK.md` exists.
- Production security audit.
