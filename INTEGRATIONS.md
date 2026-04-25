# Sponsor Integrations

## KeeperHub

Capability Leases uses KeeperHub as the execution reliability layer for authority decay.

Development mode:

- `KEEPERHUB_MODE=local`
- The local demo uses a dev signer behind `KeeperHubAdapter`.
- This proves the adapter boundary and receipt flow without external credentials.

Prize-ready mode:

- `KEEPERHUB_MODE=keeperhub-direct`
- `KeeperHubAdapter` calls KeeperHub Direct Execution API:
  - `POST /api/execute/contract-call`
  - `X-API-Key: keeper_...`
  - write calls use `KEEPERHUB_WALLET_ID`
- Stale leases are degraded/frozen through KeeperHub-triggered contract calls.
- The receipt timeline must show `provider=keeperhub-direct-execution`.

What KeeperHub owns in the final demo:

- detecting that the lease crossed a liveness threshold
- submitting `degradeLease(leaseId)` or `freezeLease(leaseId)`
- returning execution metadata for the receipt timeline

## ENS

Capability Leases uses ENS as the agent trust handle.

The final demo should use a real ENS name or subname with these text records:

```txt
capabilityLeases.registry = 0xLeaseController
capabilityLeases.leaseId = 1
capabilityLeases.policyHash = 0x...
capabilityLeases.trustUrl = https://...
capabilityLeases.guardian = 0xGuardian
```

The app resolves:

- address
- required Capability Leases text records
- missing records

The counterparty view should read the ENS-resolved records before deciding whether to delegate authority.

Local placeholder mode is not enough for ENS prize eligibility. Run:

```bash
ETHEREUM_RPC_URL=https://... npm run ens:check -- agent.yourname.eth
```

The check must pass before claiming ENS integration.

## Deployment

Deploy testnet contracts before recording the track-prize demo:

```bash
RPC_URL=https://...
PRIVATE_KEY=0x...
CHAIN_ID=11155111
npm run deploy
```

The deployment script writes `deployments/<chainId>.json` with contract addresses and transaction hashes.

## Uniswap

Uniswap is optional for this project. If added, include `FEEDBACK.md` in the repo root because the Uniswap prize requires it.

## Gensyn

Do not claim Gensyn unless the demo includes two separate AXL nodes communicating. In-process messaging does not qualify.
