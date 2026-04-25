const test = require("node:test");
const assert = require("node:assert/strict");

test("KeeperHubAdapter builds direct execution contract-call requests", async () => {
  const { KeeperHubAdapter } = await import("../lib/keeperhub-adapter.mjs");
  const calls = [];
  const adapter = new KeeperHubAdapter({
    mode: "keeperhub-direct",
    apiBase: "https://keeper.example",
    apiKey: "keeper_test",
    walletId: "wallet_123",
    network: "sepolia",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return { executionId: "direct_1", status: "completed", transactionHash: "0xabc" };
        },
      };
    },
  });

  const result = await adapter.executeContractCall({
    contractAddress: "0x0000000000000000000000000000000000000001",
    functionName: "freezeLease",
    functionArgs: ["1"],
    abi: [{ type: "function", name: "freezeLease" }],
  });

  assert.equal(result.provider, "keeperhub-direct-execution");
  assert.equal(result.executionId, "direct_1");
  assert.equal(calls[0].url, "https://keeper.example/api/execute/contract-call");
  assert.equal(calls[0].init.headers["X-API-Key"], "keeper_test");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.network, "sepolia");
  assert.equal(body.walletId, "wallet_123");
  assert.equal(body.functionName, "freezeLease");
  assert.equal(body.functionArgs, "[\"1\"]");
});

test("KeeperHubAdapter refuses remote mode without required credentials", async () => {
  const { KeeperHubAdapter } = await import("../lib/keeperhub-adapter.mjs");
  const adapter = new KeeperHubAdapter({ mode: "keeperhub-direct", apiKey: "", walletId: "" });

  await assert.rejects(
    adapter.executeContractCall({
      contractAddress: "0x0000000000000000000000000000000000000001",
      functionName: "freezeLease",
      abi: [],
    }),
    /KEEPERHUB_API_KEY/,
  );
});

test("CapabilityEnsResolver reports unresolved state when RPC is not configured", async () => {
  const { CapabilityEnsResolver } = await import("../lib/ens-resolver.mjs");
  const resolver = new CapabilityEnsResolver({ rpcUrl: "" });
  const resolved = await resolver.resolve("agent.example.eth");

  assert.equal(resolved.configured, false);
  assert.equal(resolved.address, null);
  assert.ok(resolved.namehash.startsWith("0x"));
  assert.ok(resolved.missingTextKeys.includes("capabilityLeases.registry"));
});

test("CapabilityEnsResolver reads address and required text records from a client", async () => {
  const { CapabilityEnsResolver } = await import("../lib/ens-resolver.mjs");
  const resolver = new CapabilityEnsResolver({
    client: {
      async getEnsAddress({ name }) {
        assert.equal(name, "agent.example.eth");
        return "0x0000000000000000000000000000000000000002";
      },
      async getEnsText({ key }) {
        return key === "capabilityLeases.leaseId" ? "7" : `value:${key}`;
      },
    },
  });

  const resolved = await resolver.resolve("agent.example.eth");

  assert.equal(resolved.configured, true);
  assert.equal(resolved.address, "0x0000000000000000000000000000000000000002");
  assert.equal(resolved.textRecords["capabilityLeases.leaseId"], "7");
  assert.deepEqual(resolved.missingTextKeys, []);
});
