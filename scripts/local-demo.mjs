import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ganache from "ganache";
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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const STATUS = ["ACTIVE", "DEGRADED", "FROZEN", "REVOKED", "EXPIRED"];
const POSTURE = ["GREEN", "YELLOW", "RED"];
const POLICY_HASH = keccak256(stringToHex("allow executeRoute(bytes32) USDC-WETH under 1 ETH"));
const ENS_NAMEHASH = keccak256(stringToHex("guarded-agent.eth"));
const GOOD_ROUTE_ID = keccak256(stringToHex("USDC-WETH"));
const BAD_ROUTE_ID = keccak256(stringToHex("USDC-PEPE"));

const controllerArtifact = readArtifact("LeaseController");
const routerArtifact = readArtifact("MockActionRouter");

const provider = ganache.provider({
  chain: { chainId: 31337 },
  wallet: {
    totalAccounts: 3,
    defaultBalance: 1000,
  },
  logging: {
    quiet: true,
  },
});

const chain = defineChain({
  id: 31337,
  name: "Capability Lease Local",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:31337"] } },
});
const transport = custom(provider);
const publicClient = createPublicClient({ chain, transport });
const accounts = Object.values(provider.getInitialAccounts());
const owner = makeWallet(accounts[0].secretKey);
const agent = makeWallet(accounts[1].secretKey);
const keeper = makeWallet(accounts[2].secretKey);
const timeline = [];

try {
  const controllerAddress = await deployContract(owner.walletClient, controllerArtifact);
  const routerAddress = await deployContract(owner.walletClient, routerArtifact);
  const goodData = routeData(GOOD_ROUTE_ID);
  const badData = routeData(BAD_ROUTE_ID);
  const block = await publicClient.getBlock();

  const leaseHash = await owner.walletClient.writeContract({
    address: controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "createLease",
    args: [
      agent.account.address,
      "0x0000000000000000000000000000000000000000",
      parseEther("1"),
      routerAddress,
      goodData.slice(0, 10),
      keccak256(goodData),
      30n,
      30n,
      block.timestamp + 900n,
      POLICY_HASH,
      ENS_NAMEHASH,
    ],
    value: parseEther("1"),
    account: owner.account,
  });
  const leaseReceipt = await publicClient.waitForTransactionReceipt({ hash: leaseHash });
  const leaseId = findEvent(leaseReceipt, controllerArtifact.abi, "LeaseCreated").args.leaseId;
  await capture(controllerAddress, leaseId, "created", leaseHash, "1 ETH max spend, executeRoute(USDC-WETH) only");

  const heartbeatHash = await agent.walletClient.writeContract({
    address: controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "heartbeat",
    args: [leaseId],
    account: agent.account,
  });
  await publicClient.waitForTransactionReceipt({ hash: heartbeatHash });
  await capture(controllerAddress, leaseId, "heartbeat", heartbeatHash, "agent proved liveness");

  const validHash = await agent.walletClient.writeContract({
    address: controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "executeAction",
    args: [leaseId, routerAddress, parseEther("0.2"), goodData],
    account: agent.account,
  });
  await publicClient.waitForTransactionReceipt({ hash: validHash });
  await capture(controllerAddress, leaseId, "valid action", validHash, "allowed route executed and spend accounted");

  const invalidHash = await agent.walletClient.writeContract({
    address: controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "executeAction",
    args: [leaseId, routerAddress, parseEther("0.1"), badData],
    account: agent.account,
  });
  const invalidReceipt = await publicClient.waitForTransactionReceipt({ hash: invalidHash });
  await capture(controllerAddress, leaseId, "invalid route", invalidHash, refusedReason(invalidReceipt));

  await increaseTime(31);
  const degradeHash = await keeper.walletClient.writeContract({
    address: controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "degradeLease",
    args: [leaseId],
    account: keeper.account,
  });
  await publicClient.waitForTransactionReceipt({ hash: degradeHash });
  await capture(controllerAddress, leaseId, "heartbeat late", degradeHash, "authority degraded to yellow posture");

  await increaseTime(31);
  const freezeHash = await keeper.walletClient.writeContract({
    address: controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "freezeLease",
    args: [leaseId],
    account: keeper.account,
  });
  await publicClient.waitForTransactionReceipt({ hash: freezeHash });
  await capture(controllerAddress, leaseId, "deadman freeze", freezeHash, "missed heartbeat beyond grace window");

  const frozenHash = await agent.walletClient.writeContract({
    address: controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "executeAction",
    args: [leaseId, routerAddress, parseEther("0.1"), goodData],
    account: agent.account,
  });
  const frozenReceipt = await publicClient.waitForTransactionReceipt({ hash: frozenHash });
  await capture(controllerAddress, leaseId, "post-freeze action", frozenHash, refusedReason(frozenReceipt));

  console.log("\nCapability Leases local demo");
  console.log(`Controller: ${controllerAddress}`);
  console.log(`Agent:      ${agent.account.address}`);
  console.log(`ENS handle: guarded-agent.eth (namehash stored on lease)`);
  console.table(timeline);
} finally {
  if (typeof provider.disconnect === "function") {
    await provider.disconnect();
  }
}

function readArtifact(name) {
  const artifactPath = path.join(rootDir, "artifacts", `${name}.json`);
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

function makeWallet(secretKey) {
  const account = privateKeyToAccount(secretKey);
  return {
    account,
    walletClient: createWalletClient({
      account,
      chain,
      transport,
    }),
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

async function capture(controllerAddress, leaseId, step, txHash, detail) {
  const lease = await publicClient.readContract({
    address: controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "getLease",
    args: [leaseId],
  });
  const posture = await publicClient.readContract({
    address: controllerAddress,
    abi: controllerArtifact.abi,
    functionName: "trustPosture",
    args: [leaseId],
  });
  timeline.push({
    step,
    status: STATUS[Number(lease.status)],
    posture: POSTURE[Number(posture)],
    spent: `${formatEther(lease.spent)} ETH`,
    unspent: `${formatEther(lease.deposited)} ETH`,
    tx: shortHash(txHash),
    detail,
  });
}

function refusedReason(receipt) {
  const refused = findEvent(receipt, controllerArtifact.abi, "ActionRefused");
  return refused ? `refused: ${refused.args.reason}` : "no refusal event found";
}

function findEvent(receipt, abi, eventName) {
  for (const entry of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi,
        data: entry.data,
        topics: entry.topics,
      });
      if (decoded.eventName === eventName) return decoded;
    } catch {
      // Ignore logs from other contracts.
    }
  }
  return null;
}

async function increaseTime(seconds) {
  await provider.request({ method: "evm_increaseTime", params: [seconds] });
  await provider.request({ method: "evm_mine", params: [] });
}

function shortHash(value) {
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
