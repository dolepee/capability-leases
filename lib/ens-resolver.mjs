import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { namehash, normalize } from "viem/ens";

const TEXT_KEYS = [
  "capabilityLeases.registry",
  "capabilityLeases.leaseId",
  "capabilityLeases.policyHash",
  "capabilityLeases.trustUrl",
  "capabilityLeases.guardian",
];

export class CapabilityEnsResolver {
  constructor(options = {}) {
    this.rpcUrl = options.rpcUrl ?? process.env.ETHEREUM_RPC_URL ?? process.env.ENS_RPC_URL ?? "";
    this.client = options.client ?? null;
  }

  status() {
    return {
      configured: Boolean(this.rpcUrl || this.client),
      rpcConfigured: Boolean(this.rpcUrl),
      requiredTextKeys: TEXT_KEYS,
    };
  }

  async resolve(name) {
    if (!name || !name.includes(".")) {
      throw new Error("ENS name is required");
    }
    const normalizedName = normalize(name);
    const client = this.getClient();
    if (!client) {
      return {
        name: normalizedName,
        namehash: namehash(normalizedName),
        configured: false,
        address: null,
        textRecords: Object.fromEntries(TEXT_KEYS.map((key) => [key, null])),
        missingTextKeys: TEXT_KEYS,
      };
    }

    const address = await client.getEnsAddress({ name: normalizedName });
    const entries = await Promise.all(
      TEXT_KEYS.map(async (key) => {
        const value = await client.getEnsText({ name: normalizedName, key }).catch(() => null);
        return [key, value];
      }),
    );
    const textRecords = Object.fromEntries(entries);
    return {
      name: normalizedName,
      namehash: namehash(normalizedName),
      configured: true,
      address,
      textRecords,
      missingTextKeys: TEXT_KEYS.filter((key) => !textRecords[key]),
    };
  }

  getClient() {
    if (this.client) return this.client;
    if (!this.rpcUrl) return null;
    this.client = createPublicClient({
      chain: mainnet,
      transport: http(this.rpcUrl),
    });
    return this.client;
  }
}

export { TEXT_KEYS as CAPABILITY_ENS_TEXT_KEYS };
