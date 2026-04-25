/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ganache = require("ganache");
const solc = require("solc");
const {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  keccak256,
  parseEther,
  stringToHex,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const STATUS = {
  ACTIVE: 0,
  DEGRADED: 1,
  FROZEN: 2,
  REVOKED: 3,
  EXPIRED: 4,
};

const POSTURE = {
  GREEN: 0,
  YELLOW: 1,
  RED: 2,
};

const POLICY_HASH = keccak256(stringToHex("allow executeRoute(bytes32) USDC-WETH under 1 ETH"));
const ENS_NAMEHASH = keccak256(stringToHex("guarded-agent.eth"));
const ROUTE_ID = keccak256(stringToHex("USDC-WETH"));
const BAD_ROUTE_ID = keccak256(stringToHex("USDC-PEPE"));

const compiledArtifacts = compileContracts();

test("createLease stores an active named lease with bounded native spend", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture);
    const lease = await getLease(fixture, leaseId);

    assert.equal(lease.owner.toLowerCase(), fixture.owner.account.address.toLowerCase());
    assert.equal(lease.agent.toLowerCase(), fixture.agent.account.address.toLowerCase());
    assert.equal(lease.allowedTarget.toLowerCase(), fixture.routerAddress.toLowerCase());
    assert.equal(lease.allowedSelector, fixture.executeSelector);
    assert.equal(lease.allowedCalldataHash, fixture.executeCalldataHash);
    assert.equal(lease.maxSpend, parseEther("1"));
    assert.equal(lease.deposited, parseEther("1"));
    assert.equal(lease.spent, 0n);
    assert.equal(lease.policyHash, POLICY_HASH);
    assert.equal(lease.ensNamehash, ENS_NAMEHASH);
    assert.equal(lease.status, STATUS.ACTIVE);
    assert.equal(await trustPosture(fixture, leaseId), POSTURE.GREEN);
  } finally {
    await fixture.close();
  }
});

test("heartbeat restores a degraded lease to active", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture, { heartbeatInterval: 30, staleGracePeriod: 60 });
    await increaseTime(fixture, 31);

    assert.equal(await currentStatus(fixture, leaseId), STATUS.DEGRADED);
    assert.equal(await trustPosture(fixture, leaseId), POSTURE.YELLOW);

    const hash = await fixture.agent.walletClient.writeContract({
      address: fixture.controllerAddress,
      abi: fixture.controllerArtifact.abi,
      functionName: "heartbeat",
      args: [leaseId],
      account: fixture.agent.account,
    });
    await fixture.publicClient.waitForTransactionReceipt({ hash });

    assert.equal(await currentStatus(fixture, leaseId), STATUS.ACTIVE);
    assert.equal(await trustPosture(fixture, leaseId), POSTURE.GREEN);
  } finally {
    await fixture.close();
  }
});

test("executeAction permits the allowed route and accounts for spend", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture);
    const data = executeRouteData(fixture);
    const hash = await fixture.agent.walletClient.writeContract({
      address: fixture.controllerAddress,
      abi: fixture.controllerArtifact.abi,
      functionName: "executeAction",
      args: [leaseId, fixture.routerAddress, parseEther("0.2"), data],
      account: fixture.agent.account,
    });
    const receipt = await fixture.publicClient.waitForTransactionReceipt({ hash });

    assert.ok(findEvent(receipt, fixture.controllerArtifact.abi, "ActionExecuted"));
    assert.ok(findEvent(receipt, fixture.routerArtifact.abi, "RouteExecuted"));

    const lease = await getLease(fixture, leaseId);
    assert.equal(lease.spent, parseEther("0.2"));
    assert.equal(lease.deposited, parseEther("0.8"));
    assert.equal(await fixture.publicClient.getBalance({ address: fixture.routerAddress }), parseEther("0.2"));
  } finally {
    await fixture.close();
  }
});

test("executeAction refuses wrong selector without spending", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture);
    const data = encodeFunctionData({
      abi: fixture.routerArtifact.abi,
      functionName: "executeAlternative",
      args: [ROUTE_ID],
    });

    const hash = await fixture.agent.walletClient.writeContract({
      address: fixture.controllerAddress,
      abi: fixture.controllerArtifact.abi,
      functionName: "executeAction",
      args: [leaseId, fixture.routerAddress, parseEther("0.2"), data],
      account: fixture.agent.account,
    });
    const receipt = await fixture.publicClient.waitForTransactionReceipt({ hash });
    const refused = findEvent(receipt, fixture.controllerArtifact.abi, "ActionRefused");

    assert.equal(refused.args.reason, "SELECTOR_NOT_ALLOWED");
    const lease = await getLease(fixture, leaseId);
    assert.equal(lease.spent, 0n);
    assert.equal(lease.deposited, parseEther("1"));
  } finally {
    await fixture.close();
  }
});

test("executeAction refuses overspend without spending", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture, { maxSpend: parseEther("1"), value: parseEther("1") });
    const hash = await fixture.agent.walletClient.writeContract({
      address: fixture.controllerAddress,
      abi: fixture.controllerArtifact.abi,
      functionName: "executeAction",
      args: [leaseId, fixture.routerAddress, parseEther("1.1"), executeRouteData(fixture)],
      account: fixture.agent.account,
    });
    const receipt = await fixture.publicClient.waitForTransactionReceipt({ hash });
    const refused = findEvent(receipt, fixture.controllerArtifact.abi, "ActionRefused");

    assert.equal(refused.args.reason, "SPEND_LIMIT_EXCEEDED");
    const lease = await getLease(fixture, leaseId);
    assert.equal(lease.spent, 0n);
    assert.equal(lease.deposited, parseEther("1"));
  } finally {
    await fixture.close();
  }
});

test("executeAction refuses same selector with unapproved route calldata", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture);
    const data = executeRouteData(fixture, BAD_ROUTE_ID);

    const hash = await fixture.agent.walletClient.writeContract({
      address: fixture.controllerAddress,
      abi: fixture.controllerArtifact.abi,
      functionName: "executeAction",
      args: [leaseId, fixture.routerAddress, parseEther("0.2"), data],
      account: fixture.agent.account,
    });
    const receipt = await fixture.publicClient.waitForTransactionReceipt({ hash });
    const refused = findEvent(receipt, fixture.controllerArtifact.abi, "ActionRefused");

    assert.equal(refused.args.reason, "CALLDATA_NOT_ALLOWED");
    const lease = await getLease(fixture, leaseId);
    assert.equal(lease.spent, 0n);
    assert.equal(lease.deposited, parseEther("1"));
  } finally {
    await fixture.close();
  }
});

test("freezeLease locks stale authority and blocks later execution", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture, { heartbeatInterval: 30, staleGracePeriod: 30 });
    await increaseTime(fixture, 62);

    assert.equal(await currentStatus(fixture, leaseId), STATUS.FROZEN);
    assert.equal(await trustPosture(fixture, leaseId), POSTURE.RED);

    const freezeHash = await fixture.keeper.walletClient.writeContract({
      address: fixture.controllerAddress,
      abi: fixture.controllerArtifact.abi,
      functionName: "freezeLease",
      args: [leaseId],
      account: fixture.keeper.account,
    });
    const freezeReceipt = await fixture.publicClient.waitForTransactionReceipt({ hash: freezeHash });
    assert.ok(findEvent(freezeReceipt, fixture.controllerArtifact.abi, "LeaseFrozen"));

    const executeHash = await fixture.agent.walletClient.writeContract({
      address: fixture.controllerAddress,
      abi: fixture.controllerArtifact.abi,
      functionName: "executeAction",
      args: [leaseId, fixture.routerAddress, parseEther("0.1"), executeRouteData(fixture)],
      account: fixture.agent.account,
    });
    const executeReceipt = await fixture.publicClient.waitForTransactionReceipt({ hash: executeHash });
    const refused = findEvent(executeReceipt, fixture.controllerArtifact.abi, "ActionRefused");
    assert.equal(refused.args.reason, "LEASE_FROZEN");
  } finally {
    await fixture.close();
  }
});

test("owner can revoke a lease and withdraw unspent funds", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture);
    const revokeHash = await fixture.owner.walletClient.writeContract({
      address: fixture.controllerAddress,
      abi: fixture.controllerArtifact.abi,
      functionName: "revokeLease",
      args: [leaseId],
      account: fixture.owner.account,
    });
    await fixture.publicClient.waitForTransactionReceipt({ hash: revokeHash });
    assert.equal(await currentStatus(fixture, leaseId), STATUS.REVOKED);

    const withdrawHash = await fixture.owner.walletClient.writeContract({
      address: fixture.controllerAddress,
      abi: fixture.controllerArtifact.abi,
      functionName: "withdrawUnspent",
      args: [leaseId],
      account: fixture.owner.account,
    });
    await fixture.publicClient.waitForTransactionReceipt({ hash: withdrawHash });
    const lease = await getLease(fixture, leaseId);
    assert.equal(lease.deposited, 0n);
  } finally {
    await fixture.close();
  }
});

test("expireLease marks expired authority red", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture, { expiresInSeconds: 90 });
    await increaseTime(fixture, 91);

    assert.equal(await currentStatus(fixture, leaseId), STATUS.EXPIRED);
    assert.equal(await trustPosture(fixture, leaseId), POSTURE.RED);

    const hash = await fixture.keeper.walletClient.writeContract({
      address: fixture.controllerAddress,
      abi: fixture.controllerArtifact.abi,
      functionName: "expireLease",
      args: [leaseId],
      account: fixture.keeper.account,
    });
    const receipt = await fixture.publicClient.waitForTransactionReceipt({ hash });
    assert.ok(findEvent(receipt, fixture.controllerArtifact.abi, "LeaseExpired"));
  } finally {
    await fixture.close();
  }
});

test("non-agent cannot heartbeat or execute", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture);
    await assert.rejects(
      fixture.keeper.walletClient.writeContract({
        address: fixture.controllerAddress,
        abi: fixture.controllerArtifact.abi,
        functionName: "heartbeat",
        args: [leaseId],
        account: fixture.keeper.account,
      }),
    );
    await assert.rejects(
      fixture.keeper.walletClient.writeContract({
        address: fixture.controllerAddress,
        abi: fixture.controllerArtifact.abi,
        functionName: "executeAction",
        args: [leaseId, fixture.routerAddress, parseEther("0.1"), executeRouteData(fixture)],
        account: fixture.keeper.account,
      }),
    );
  } finally {
    await fixture.close();
  }
});

test("fundLease cannot exceed the max spend budget", async () => {
  const fixture = await createFixture();
  try {
    const leaseId = await createLease(fixture, { maxSpend: parseEther("1"), value: parseEther("0.7") });
    await assert.rejects(
      fixture.owner.walletClient.writeContract({
        address: fixture.controllerAddress,
        abi: fixture.controllerArtifact.abi,
        functionName: "fundLease",
        args: [leaseId],
        value: parseEther("0.4"),
        account: fixture.owner.account,
      }),
    );
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
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
    name: "Ganache",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1:31337"] } },
  });
  const transport = custom(provider);
  const publicClient = createPublicClient({ chain, transport });
  const accounts = Object.values(provider.getInitialAccounts());
  const owner = makeWallet(chain, transport, accounts[0].secretKey);
  const agent = makeWallet(chain, transport, accounts[1].secretKey);
  const keeper = makeWallet(chain, transport, accounts[2].secretKey);

  const controllerAddress = await deployContract(publicClient, owner.walletClient, compiledArtifacts.controllerArtifact, []);
  const routerAddress = await deployContract(publicClient, owner.walletClient, compiledArtifacts.routerArtifact, []);
  const executeData = executeRouteData({ routerArtifact: compiledArtifacts.routerArtifact });

  return {
    provider,
    chain,
    publicClient,
    owner,
    agent,
    keeper,
    controllerAddress,
    routerAddress,
    controllerArtifact: compiledArtifacts.controllerArtifact,
    routerArtifact: compiledArtifacts.routerArtifact,
    executeSelector: executeData.slice(0, 10),
    executeCalldataHash: keccak256(executeData),
    async close() {
      if (typeof provider.disconnect === "function") {
        await provider.disconnect();
      }
    },
  };
}

async function createLease(fixture, options = {}) {
  const block = await fixture.publicClient.getBlock();
  const expiresInSeconds = BigInt(options.expiresInSeconds ?? 900);
  const maxSpend = options.maxSpend ?? parseEther("1");
  const value = options.value ?? maxSpend;
  const heartbeatInterval = BigInt(options.heartbeatInterval ?? 60);
  const staleGracePeriod = BigInt(options.staleGracePeriod ?? 60);
  const executeData = executeRouteData(fixture);

  const hash = await fixture.owner.walletClient.writeContract({
    address: fixture.controllerAddress,
    abi: fixture.controllerArtifact.abi,
    functionName: "createLease",
    args: [
      fixture.agent.account.address,
      "0x0000000000000000000000000000000000000000",
      maxSpend,
      fixture.routerAddress,
      executeData.slice(0, 10),
      keccak256(executeData),
      heartbeatInterval,
      staleGracePeriod,
      block.timestamp + expiresInSeconds,
      POLICY_HASH,
      ENS_NAMEHASH,
    ],
    value,
    account: fixture.owner.account,
  });
  const receipt = await fixture.publicClient.waitForTransactionReceipt({ hash });
  const created = findEvent(receipt, fixture.controllerArtifact.abi, "LeaseCreated");
  return created.args.leaseId;
}

async function getLease(fixture, leaseId) {
  return fixture.publicClient.readContract({
    address: fixture.controllerAddress,
    abi: fixture.controllerArtifact.abi,
    functionName: "getLease",
    args: [leaseId],
  });
}

async function currentStatus(fixture, leaseId) {
  return fixture.publicClient.readContract({
    address: fixture.controllerAddress,
    abi: fixture.controllerArtifact.abi,
    functionName: "currentStatus",
    args: [leaseId],
  });
}

async function trustPosture(fixture, leaseId) {
  return fixture.publicClient.readContract({
    address: fixture.controllerAddress,
    abi: fixture.controllerArtifact.abi,
    functionName: "trustPosture",
    args: [leaseId],
  });
}

async function increaseTime(fixture, seconds) {
  await fixture.provider.request({ method: "evm_increaseTime", params: [seconds] });
  await fixture.provider.request({ method: "evm_mine", params: [] });
}

function executeRouteData(fixture, routeId = ROUTE_ID) {
  return encodeFunctionData({
    abi: fixture.routerArtifact.abi,
    functionName: "executeRoute",
    args: [routeId],
  });
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
      // Ignore logs emitted by other contracts.
    }
  }
  return null;
}

async function deployContract(publicClient, walletClient, artifact, args) {
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    account: walletClient.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress;
}

function makeWallet(chain, transport, secretKey) {
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

function compileContracts() {
  const controllerSource = fs.readFileSync(path.join(__dirname, "..", "contracts", "LeaseController.sol"), "utf8");
  const routerSource = fs.readFileSync(path.join(__dirname, "..", "contracts", "MockActionRouter.sol"), "utf8");
  const input = {
    language: "Solidity",
    sources: {
      "LeaseController.sol": { content: controllerSource },
      "MockActionRouter.sol": { content: routerSource },
    },
    settings: {
      evmVersion: "paris",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors?.some((entry) => entry.severity === "error")) {
    throw new Error(output.errors.map((entry) => entry.formattedMessage).join("\n"));
  }
  return {
    controllerArtifact: {
      abi: output.contracts["LeaseController.sol"].LeaseController.abi,
      bytecode: `0x${output.contracts["LeaseController.sol"].LeaseController.evm.bytecode.object}`,
    },
    routerArtifact: {
      abi: output.contracts["MockActionRouter.sol"].MockActionRouter.abi,
      bytecode: `0x${output.contracts["MockActionRouter.sol"].MockActionRouter.evm.bytecode.object}`,
    },
  };
}
