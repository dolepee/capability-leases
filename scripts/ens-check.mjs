import { CapabilityEnsResolver } from "../lib/ens-resolver.mjs";

const name = process.argv[2] ?? process.env.AGENT_ENS_NAME;
if (!name) {
  console.error("Usage: npm run ens:check -- <agent.eth>");
  process.exit(1);
}

const resolver = new CapabilityEnsResolver();
const status = resolver.status();
const resolved = await resolver.resolve(name);

console.log(JSON.stringify({ status, resolved }, null, 2));

if (!resolved.configured) {
  console.error("ENS RPC is not configured. Set ETHEREUM_RPC_URL or ENS_RPC_URL.");
  process.exit(1);
}

if (!resolved.address) {
  console.error(`${resolved.name} does not resolve to an address.`);
  process.exit(1);
}

if (resolved.missingTextKeys.length > 0) {
  console.error(`Missing required text records: ${resolved.missingTextKeys.join(", ")}`);
  process.exit(1);
}
