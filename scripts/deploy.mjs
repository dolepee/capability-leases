import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rootDir = process.cwd();
const rpcUrl = requiredEnv("RPC_URL");
const privateKey = normalizePrivateKey(requiredEnv("PRIVATE_KEY"));
const chainId = Number(process.env.CHAIN_ID ?? "11155111");
const chainName = process.env.CHAIN_NAME ?? "Deployment chain";
const nativeSymbol = process.env.NATIVE_SYMBOL ?? "ETH";
const deployMockRouter = process.env.DEPLOY_MOCK_ROUTER !== "false";

const chain = defineChain({
  id: chainId,
  name: chainName,
  nativeCurrency: { name: nativeSymbol, symbol: nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

const balance = await publicClient.getBalance({ address: account.address });
console.log(`Deployer: ${account.address}`);
console.log(`Balance:  ${formatEther(balance)} ${nativeSymbol}`);
console.log(`Chain:    ${chainId}`);

const controller = await deployArtifact("LeaseController");
let router = null;
if (deployMockRouter) {
  router = await deployArtifact("MockActionRouter");
}

const deployment = {
  chainId,
  chainName,
  deployedAt: new Date().toISOString(),
  deployer: account.address,
  contracts: {
    LeaseController: controller,
    ...(router ? { MockActionRouter: router } : {}),
  },
};

const outputDir = path.join(rootDir, "deployments");
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `${chainId}.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(deployment, null, 2)}\n`);

console.log(`Deployment written: ${outputPath}`);

async function deployArtifact(contractName) {
  const artifact = readArtifact(contractName);
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account,
  });
  console.log(`${contractName} tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${contractName}: ${receipt.contractAddress}`);
  return {
    address: receipt.contractAddress,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
  };
}

function readArtifact(name) {
  const artifactPath = path.join(rootDir, "artifacts", `${name}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing artifact ${artifactPath}. Run npm run compile first.`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}
