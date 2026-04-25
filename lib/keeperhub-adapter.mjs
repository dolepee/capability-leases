const DEFAULT_API_BASE = "https://app.keeperhub.com";

export class KeeperHubAdapter {
  constructor(options = {}) {
    this.mode = options.mode ?? process.env.KEEPERHUB_MODE ?? "local";
    this.apiBase = stripTrailingSlash(options.apiBase ?? process.env.KEEPERHUB_API_BASE ?? DEFAULT_API_BASE);
    this.apiKey = options.apiKey ?? process.env.KEEPERHUB_API_KEY ?? "";
    this.network = options.network ?? process.env.KEEPERHUB_NETWORK ?? "sepolia";
    this.walletId = options.walletId ?? process.env.KEEPERHUB_WALLET_ID ?? "";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.localExecutor = options.localExecutor;
  }

  status() {
    return {
      mode: this.mode,
      apiBase: this.apiBase,
      network: this.network,
      walletConfigured: Boolean(this.walletId),
      apiKeyConfigured: Boolean(this.apiKey),
      ready: this.mode === "local" || (Boolean(this.apiKey) && Boolean(this.walletId)),
    };
  }

  async executeContractCall({ contractAddress, functionName, functionArgs = [], abi, value = "0" }) {
    if (this.mode === "local") {
      if (!this.localExecutor) throw new Error("local KeeperHub executor not configured");
      const result = await this.localExecutor({ contractAddress, functionName, functionArgs, abi, value });
      return {
        provider: "local-dev-keeper",
        status: "completed",
        transactionHash: result.transactionHash,
        detail: result.detail,
      };
    }

    if (!this.apiKey) throw new Error("KEEPERHUB_API_KEY is required for KeeperHub direct execution");
    if (!this.walletId) throw new Error("KEEPERHUB_WALLET_ID is required for KeeperHub write execution");

    const response = await this.fetch(`${this.apiBase}/api/execute/contract-call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": this.apiKey,
      },
      body: JSON.stringify({
        contractAddress,
        network: this.network,
        functionName,
        functionArgs: JSON.stringify(functionArgs),
        abi: JSON.stringify(abi),
        value,
        walletId: this.walletId,
        gasLimitMultiplier: "1.2",
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? `KeeperHub contract-call failed with ${response.status}`);
    }

    return {
      provider: "keeperhub-direct-execution",
      status: payload.status ?? "submitted",
      executionId: payload.executionId ?? null,
      transactionHash: payload.transactionHash ?? null,
      transactionLink: payload.transactionLink ?? null,
      raw: payload,
    };
  }
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
