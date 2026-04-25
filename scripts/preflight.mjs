import fs from "node:fs";
import path from "node:path";
import { KeeperHubAdapter } from "../lib/keeperhub-adapter.mjs";
import { CapabilityEnsResolver } from "../lib/ens-resolver.mjs";

const rootDir = process.cwd();
const checks = [];

checks.push(checkFile("contracts/LeaseController.sol"));
checks.push(checkFile("lib/keeperhub-adapter.mjs"));
checks.push(checkFile("lib/ens-resolver.mjs"));
checks.push(checkFile("INTEGRATIONS.md"));
checks.push(checkFile("README.md"));

const keeperHub = new KeeperHubAdapter();
const keeperStatus = keeperHub.status();
checks.push({
  name: "KeeperHub adapter",
  ok: keeperStatus.ready,
  detail:
    keeperStatus.mode === "local"
      ? "local development mode; not prize-ready until keeperhub-direct is configured"
      : JSON.stringify(keeperStatus),
});

const ensResolver = new CapabilityEnsResolver();
const ensStatus = ensResolver.status();
checks.push({
  name: "ENS resolver RPC",
  ok: ensStatus.configured,
  detail: ensStatus.configured ? "ENS RPC configured" : "missing ETHEREUM_RPC_URL or ENS_RPC_URL",
});

const deploymentFiles = listDeploymentFiles();
checks.push({
  name: "Deployment artifact",
  ok: deploymentFiles.length > 0,
  detail: deploymentFiles.length ? deploymentFiles.join(", ") : "run npm run deploy after setting RPC_URL and PRIVATE_KEY",
});

const agentEnsName = process.env.AGENT_ENS_NAME;
if (agentEnsName && ensStatus.configured) {
  const resolved = await ensResolver.resolve(agentEnsName);
  checks.push({
    name: `ENS records for ${resolved.name}`,
    ok: Boolean(resolved.address) && resolved.missingTextKeys.length === 0,
    detail: Boolean(resolved.address)
      ? `address=${resolved.address}; missing=${resolved.missingTextKeys.join(", ") || "none"}`
      : "name does not resolve to an address",
  });
}

for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "WARN"} ${check.name}: ${check.detail}`);
}

const hardFailures = checks.filter((check) => check.name.startsWith("ENS records") && !check.ok);
if (hardFailures.length > 0) process.exit(1);

function checkFile(relativePath) {
  const exists = fs.existsSync(path.join(rootDir, relativePath));
  return {
    name: relativePath,
    ok: exists,
    detail: exists ? "present" : "missing",
  };
}

function listDeploymentFiles() {
  const deploymentsDir = path.join(rootDir, "deployments");
  if (!fs.existsSync(deploymentsDir)) return [];
  return fs
    .readdirSync(deploymentsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join("deployments", file));
}
