import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  formatEther,
  keccak256,
  parseEther,
  stringToHex,
  http as httpTransport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CapabilityEnsResolver } from "../lib/ens-resolver.mjs";
import { loadLocalEnv } from "../lib/env-loader.mjs";
import { KeeperHubAdapter } from "../lib/keeperhub-adapter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
loadLocalEnv(rootDir);
const webDir = path.join(rootDir, "web");
const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST ?? "127.0.0.1";
const demoMode = process.env.DEMO_MODE ?? "local";
const isDeployedMode = demoMode === "deployed";
const defaultExplorerBaseUrl = process.env.CHAIN_ID === "11155111" ? "https://sepolia.etherscan.io" : "";
const explorerBaseUrl = stripTrailingSlash(process.env.EXPLORER_BASE_URL ?? defaultExplorerBaseUrl);

const STATUS = ["ACTIVE", "DEGRADED", "FROZEN", "REVOKED", "EXPIRED"];
const POSTURE = ["GREEN", "YELLOW", "RED"];
const POLICY_HASH = keccak256(stringToHex("allow executeRoute(bytes32) USDC-WETH under 1 ETH"));
const ENS_NAME = "guarded-agent.eth";
const ENS_NAMEHASH = keccak256(stringToHex(ENS_NAME));
const GOOD_ROUTE_ID = keccak256(stringToHex("USDC-WETH"));
const BAD_ROUTE_ID = keccak256(stringToHex("USDC-PEPE"));

const controllerArtifact = readArtifact("LeaseController");
const routerArtifact = readArtifact("MockActionRouter");
const provider = isDeployedMode
  ? null
  : (await import("ganache")).default.provider({
      chain: { chainId: 31337 },
      wallet: { totalAccounts: 3, defaultBalance: 1000 },
      logging: { quiet: true },
    });
const chain = defineChain({
  id: Number(process.env.CHAIN_ID ?? (isDeployedMode ? "11155111" : "31337")),
  name: process.env.CHAIN_NAME ?? (isDeployedMode ? "Deployment chain" : "Capability Lease Local"),
  nativeCurrency: {
    name: process.env.NATIVE_SYMBOL ?? "ETH",
    symbol: process.env.NATIVE_SYMBOL ?? "ETH",
    decimals: 18,
  },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? "http://127.0.0.1:31337"] } },
});
const transport = isDeployedMode ? httpTransport(requiredEnv("RPC_URL")) : custom(provider);
const publicClient = createPublicClient({ chain, transport });
const accounts = isDeployedMode ? [] : Object.values(provider.getInitialAccounts());
const owner = makeWallet(isDeployedMode ? requiredEnv("OWNER_PRIVATE_KEY") : accounts[0].secretKey);
const agent = makeWallet(isDeployedMode ? requiredEnv("AGENT_PRIVATE_KEY") : accounts[1].secretKey);
const keeper = makeWallet(
  isDeployedMode ? process.env.KEEPER_PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY : accounts[2].secretKey,
);
const maxSpendEth = process.env.DEMO_MAX_SPEND_ETH ?? (isDeployedMode ? "0.001" : "1");
const actionValueEth = process.env.DEMO_ACTION_VALUE_ETH ?? (isDeployedMode ? "0.0001" : "0.1");
const heartbeatIntervalSeconds = BigInt(process.env.DEMO_HEARTBEAT_INTERVAL_SECONDS ?? (isDeployedMode ? "30" : "120"));
const staleGraceSeconds = BigInt(process.env.DEMO_STALE_GRACE_SECONDS ?? (isDeployedMode ? "30" : "60"));
const expiresInSeconds = BigInt(process.env.DEMO_EXPIRES_SECONDS ?? "900");
const ensResolver = new CapabilityEnsResolver();
const keeperHub = new KeeperHubAdapter({
  localExecutor: async ({ contractAddress, functionName, functionArgs }) => {
    const hash = await keeper.walletClient.writeContract({
      address: contractAddress,
      abi: controllerArtifact.abi,
      functionName,
      args: functionArgs.map((arg) => (typeof arg === "string" && /^\d+$/.test(arg) ? BigInt(arg) : arg)),
      account: keeper.account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return {
      transactionHash: receipt.transactionHash,
      detail: `local KeeperHub-compatible executor called ${functionName}`,
    };
  },
});

const app = {
  controllerAddress: null,
  routerAddress: null,
  activeLeaseId: null,
  watchedLeaseIds: [],
  timeline: [],
  keeper: {
    running: true,
    scanning: false,
    activeScan: null,
    lastScanIso: null,
    lastAppliedStatusByLease: {},
    lastProvider: keeperHub.status().mode === "local" ? "local-dev-keeper" : "keeperhub-direct-execution",
  },
  ensLookup: null,
};

if (isDeployedMode) {
  app.controllerAddress = requiredEnv("LEASE_CONTROLLER_ADDRESS");
  app.routerAddress = requiredEnv("MOCK_ACTION_ROUTER_ADDRESS");
} else {
  app.controllerAddress = await deployContract(owner.walletClient, controllerArtifact);
  app.routerAddress = await deployContract(owner.walletClient, routerArtifact);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Capability Leases demo running at http://${host}:${port}`);
  console.log(`Mode ${demoMode}`);
  console.log(`Controller ${app.controllerAddress}`);
});

setInterval(() => {
  void scanKeeper("interval").catch((error) => {
    console.error("keeper scan failed", error);
  });
}, 2_000).unref();

async function handleApi(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (req.method === "GET" && url.pathname === "/api/state") {
    await scanKeeper("state");
    sendJson(res, 200, await statePayload());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/ens/resolve") {
    const name = url.searchParams.get("name") ?? "";
    app.ensLookup = await ensResolver.resolve(name);
    sendJson(res, 200, await statePayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/create-lease") {
    app.timeline = [];
    app.watchedLeaseIds = [];
    app.keeper.lastAppliedStatusByLease = {};
    const leaseId = await createLease();
    app.activeLeaseId = leaseId;
    app.watchedLeaseIds = Array.from(new Set([...app.watchedLeaseIds, leaseId.toString()]));
    sendJson(res, 200, await statePayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/heartbeat") {
    requireLease();
    const hash = await agent.walletClient.writeContract({
      address: app.controllerAddress,
      abi: controllerArtifact.abi,
      functionName: "heartbeat",
      args: [app.activeLeaseId],
      account: agent.account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    await appendReceipt("heartbeat", receipt, "agent proved liveness");
    app.keeper.lastAppliedStatusByLease[app.activeLeaseId.toString()] = "ACTIVE";
    sendJson(res, 200, await statePayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/execute-valid") {
    await executeAction("valid action", GOOD_ROUTE_ID, "allowed route executed and spend accounted");
    sendJson(res, 200, await statePayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/execute-invalid") {
    await executeAction("invalid route", BAD_ROUTE_ID, null);
    sendJson(res, 200, await statePayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/advance-time") {
    requireLease();
    if (!provider) {
      sendJson(res, 400, { error: "time travel is only available in local demo mode; wait for live chain time instead" });
      return;
    }
    const body = await readJson(req);
    const seconds = Number(body.seconds ?? 31);
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 3600) {
      sendJson(res, 400, { error: "seconds must be an integer from 1 to 3600" });
      return;
    }
    await provider.request({ method: "evm_increaseTime", params: [seconds] });
    await provider.request({ method: "evm_mine", params: [] });
    app.timeline.unshift({
      step: `time +${seconds}s`,
      status: await statusLabel(app.activeLeaseId),
      posture: await postureLabel(app.activeLeaseId),
      tx: "local-time",
      detail: "local chain time advanced for deadman demo",
      iso: new Date().toISOString(),
    });
    await scanKeeper("time advanced");
    sendJson(res, 200, await statePayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/advance-to-degrade") {
    await advanceToLeasePhase("degrade");
    sendJson(res, 200, await statePayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/advance-to-freeze") {
    await advanceToLeasePhase("freeze");
    sendJson(res, 200, await statePayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/keeper-scan") {
    await scanKeeper("manual");
    sendJson(res, 200, await statePayload());
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function createLease() {
  const goodData = routeData(GOOD_ROUTE_ID);
  const block = await publicClient.getBlock();
  const hash = await owner.walletClient.writeContract({
    address: app.controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "createLease",
    args: [
      agent.account.address,
      "0x0000000000000000000000000000000000000000",
      parseEther(maxSpendEth),
      app.routerAddress,
      goodData.slice(0, 10),
      keccak256(goodData),
      heartbeatIntervalSeconds,
      staleGraceSeconds,
      block.timestamp + expiresInSeconds,
      POLICY_HASH,
      ENS_NAMEHASH,
    ],
    value: parseEther(maxSpendEth),
    account: owner.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const created = findEvent(receipt, controllerArtifact.abi, "LeaseCreated");
  const leaseId = created.args.leaseId;
  await appendReceipt("created", receipt, `${maxSpendEth} ETH max spend, executeRoute(USDC-WETH) only`, leaseId);
  return leaseId;
}

async function executeAction(step, routeId, successDetail) {
  requireLease();
  const hash = await agent.walletClient.writeContract({
    address: app.controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "executeAction",
    args: [app.activeLeaseId, app.routerAddress, parseEther(actionValueEth), routeData(routeId)],
    account: agent.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  await appendReceipt(step, receipt, successDetail);
}

async function advanceToLeasePhase(phase) {
  requireLease();
  if (!provider) {
    throw new Error("phase jump is only available in local demo mode; wait for live chain time instead");
  }
  const lease = await publicClient.readContract({
    address: app.controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "getLease",
    args: [app.activeLeaseId],
  });
  const block = await publicClient.getBlock();
  const targetTimestamp =
    phase === "degrade"
      ? lease.lastHeartbeat + lease.heartbeatInterval + 1n
      : lease.lastHeartbeat + lease.heartbeatInterval + lease.staleGracePeriod + 1n;
  const seconds = targetTimestamp > block.timestamp ? Number(targetTimestamp - block.timestamp) : 1;
  await provider.request({ method: "evm_increaseTime", params: [seconds] });
  await provider.request({ method: "evm_mine", params: [] });
  app.timeline.unshift({
    step: phase === "degrade" ? "miss heartbeat" : "miss grace",
    status: await statusLabel(app.activeLeaseId),
    posture: await postureLabel(app.activeLeaseId),
    tx: "local-time",
    provider: "local-time",
    detail:
      phase === "degrade"
        ? `advanced ${seconds}s to cross heartbeat deadline`
        : `advanced ${seconds}s to cross freeze deadline`,
    iso: new Date().toISOString(),
  });
  await scanKeeper(phase === "degrade" ? "heartbeat deadline" : "freeze deadline");
}

async function scanKeeper(trigger) {
  if (app.keeper.activeScan) return app.keeper.activeScan;
  app.keeper.activeScan = runKeeperScan(trigger).finally(() => {
    app.keeper.activeScan = null;
  });
  return app.keeper.activeScan;
}

async function runKeeperScan(trigger) {
  app.keeper.scanning = true;
  app.keeper.lastScanIso = new Date().toISOString();
  try {
    for (const leaseIdString of app.watchedLeaseIds) {
      const leaseId = BigInt(leaseIdString);
      const status = await statusLabel(leaseId);
      const previous = app.keeper.lastAppliedStatusByLease[leaseIdString];
      if (status === "ACTIVE") {
        app.keeper.lastAppliedStatusByLease[leaseIdString] = "ACTIVE";
        continue;
      }
      if (status === "DEGRADED" && previous !== "DEGRADED") {
        const execution = await keeperHub.executeContractCall({
          contractAddress: app.controllerAddress,
          functionName: "degradeLease",
          functionArgs: [leaseId.toString()],
          abi: controllerArtifact.abi,
        });
        app.keeper.lastProvider = execution.provider;
        await appendExecution("keeper degraded", execution, `KeeperHub scan (${trigger}) found late heartbeat`, leaseId);
        app.keeper.lastAppliedStatusByLease[leaseIdString] = "DEGRADED";
        continue;
      }
      if (status === "FROZEN" && previous !== "FROZEN") {
        const execution = await keeperHub.executeContractCall({
          contractAddress: app.controllerAddress,
          functionName: "freezeLease",
          functionArgs: [leaseId.toString()],
          abi: controllerArtifact.abi,
        });
        app.keeper.lastProvider = execution.provider;
        await appendExecution(
          "deadman freeze",
          execution,
          `KeeperHub scan (${trigger}) found missed heartbeat beyond grace`,
          leaseId,
        );
        app.keeper.lastAppliedStatusByLease[leaseIdString] = "FROZEN";
      }
    }
  } finally {
    app.keeper.scanning = false;
  }
}

async function statePayload() {
  return {
    addresses: {
      controller: app.controllerAddress,
      router: app.routerAddress,
      owner: owner.account.address,
      agent: agent.account.address,
      keeper: keeper.account.address,
    },
    demo: {
      mode: demoMode,
      chainId: chain.id,
      chainName: chain.name,
      explorerBaseUrl,
      maxSpendEth,
      actionValueEth,
      heartbeatIntervalSeconds: heartbeatIntervalSeconds.toString(),
      staleGraceSeconds: staleGraceSeconds.toString(),
      expiresInSeconds: expiresInSeconds.toString(),
      timeTravelAvailable: Boolean(provider),
    },
    ens: {
      name: ENS_NAME,
      namehash: ENS_NAMEHASH,
      records: {
        "capabilityLeases.registry": app.controllerAddress,
        "capabilityLeases.leaseId": app.activeLeaseId?.toString() ?? "",
        "capabilityLeases.policyHash": POLICY_HASH,
        "capabilityLeases.guardian": keeper.account.address,
      },
    },
    keeper: {
      running: app.keeper.running,
      scanning: app.keeper.scanning,
      provider: app.keeper.lastProvider,
      keeperHub: keeperHub.status(),
      lastScanIso: app.keeper.lastScanIso,
      watchedLeaseIds: app.watchedLeaseIds,
    },
    ensResolver: ensResolver.status(),
    ensLookup: app.ensLookup,
    lease: await leaseView(),
    timeline: app.timeline,
  };
}

async function leaseView() {
  if (!app.activeLeaseId) return null;
  const lease = await publicClient.readContract({
    address: app.controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "getLease",
    args: [app.activeLeaseId],
  });
  const posture = await publicClient.readContract({
    address: app.controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "trustPosture",
    args: [app.activeLeaseId],
  });
  return {
    leaseId: app.activeLeaseId.toString(),
    owner: lease.owner,
    agent: lease.agent,
    spendToken: lease.spendToken,
    maxSpendEth: formatEther(lease.maxSpend),
    spentEth: formatEther(lease.spent),
    unspentEth: formatEther(lease.deposited),
    allowedTarget: lease.allowedTarget,
    allowedSelector: lease.allowedSelector,
    allowedCalldataHash: lease.allowedCalldataHash,
    heartbeatIntervalSeconds: lease.heartbeatInterval.toString(),
    staleGracePeriodSeconds: lease.staleGracePeriod.toString(),
    lastHeartbeatIso: unixIso(lease.lastHeartbeat),
    expiresAtIso: unixIso(lease.expiresAt),
    policyHash: lease.policyHash,
    ensNamehash: lease.ensNamehash,
    status: STATUS[Number(lease.status)],
    posture: POSTURE[Number(posture)],
  };
}

async function statusLabel(leaseId) {
  const status = await publicClient.readContract({
    address: app.controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "currentStatus",
    args: [leaseId],
  });
  return STATUS[Number(status)];
}

async function postureLabel(leaseId) {
  const posture = await publicClient.readContract({
    address: app.controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "trustPosture",
    args: [leaseId],
  });
  return POSTURE[Number(posture)];
}

async function appendReceipt(step, receipt, fallbackDetail, leaseId = app.activeLeaseId) {
  const refused = findEvent(receipt, controllerArtifact.abi, "ActionRefused");
  const detail = refused ? `refused: ${refused.args.reason}` : fallbackDetail ?? "transaction submitted";
  app.timeline.unshift({
    step,
    status: leaseId ? await statusLabel(leaseId) : "ACTIVE",
    posture: leaseId ? await postureLabel(leaseId) : "GREEN",
    tx: shortHash(receipt.transactionHash),
    txHash: receipt.transactionHash,
    provider: "wallet-direct",
    detail,
    iso: new Date().toISOString(),
  });
}

async function appendExecution(step, execution, fallbackDetail, leaseId = app.activeLeaseId) {
  app.timeline.unshift({
    step,
    status: leaseId ? await statusLabel(leaseId) : "ACTIVE",
    posture: leaseId ? await postureLabel(leaseId) : "GREEN",
    tx: execution.transactionHash ? shortHash(execution.transactionHash) : execution.executionId ?? execution.status,
    txHash: execution.transactionHash ?? null,
    provider: execution.provider,
    detail: `${fallbackDetail} via ${execution.provider}`,
    iso: new Date().toISOString(),
  });
}

function requireLease() {
  if (!app.activeLeaseId) {
    throw new Error("create a lease first");
  }
}

function readArtifact(name) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "artifacts", `${name}.json`), "utf8"));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in ${demoMode} demo mode`);
  return value;
}

function makeWallet(secretKey) {
  const account = privateKeyToAccount(secretKey.startsWith("0x") ? secretKey : `0x${secretKey}`);
  return {
    account,
    walletClient: createWalletClient({ account, chain, transport }),
  };
}

async function deployContract(walletClient, artifact) {
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account: walletClient.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress;
}

function routeData(routeId) {
  return encodeFunctionData({
    abi: routerArtifact.abi,
    functionName: "executeRoute",
    args: [routeId],
  });
}

function findEvent(receipt, abi, eventName) {
  for (const entry of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi, data: entry.data, topics: entry.topics });
      if (decoded.eventName === eventName) return decoded;
    } catch {
      // Ignore unrelated logs.
    }
  }
  return null;
}

function serveStatic(req, res) {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(webDir, requested));
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function unixIso(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

function shortHash(value) {
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
