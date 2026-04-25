const els = {
  postureCard: document.querySelector("#postureCard"),
  posture: document.querySelector("#posture"),
  status: document.querySelector("#status"),
  leaseTitle: document.querySelector("#leaseTitle"),
  leaseFacts: document.querySelector("#leaseFacts"),
  ensName: document.querySelector("#ensName"),
  ensFacts: document.querySelector("#ensFacts"),
  addressFacts: document.querySelector("#addressFacts"),
  addressTitle: document.querySelector("#addressTitle"),
  keeperTitle: document.querySelector("#keeperTitle"),
  keeperFacts: document.querySelector("#keeperFacts"),
  ensInput: document.querySelector("#ensInput"),
  resolveEns: document.querySelector("#resolveEns"),
  counterpartyTitle: document.querySelector("#counterpartyTitle"),
  counterpartyDecision: document.querySelector("#counterpartyDecision"),
  timeline: document.querySelector("#timeline"),
};

const actions = {
  createLease: ["/api/create-lease", {}],
  heartbeat: ["/api/heartbeat", {}],
  validAction: ["/api/execute-valid", {}],
  invalidAction: ["/api/execute-invalid", {}],
  advanceDegrade: ["/api/advance-to-degrade", {}],
  advanceFreeze: ["/api/advance-to-freeze", {}],
  keeperScan: ["/api/keeper-scan", {}],
};
let apiAvailable = true;
let simulatedState = createSimulatedState();

for (const [id, [url, body]] of Object.entries(actions)) {
  document.querySelector(`#${id}`).addEventListener("click", () => mutate(url, body));
}

els.resolveEns.addEventListener("click", resolveEns);
els.ensInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") resolveEns();
});

await refresh();
setInterval(refresh, 2500);

async function mutate(url, body) {
  setBusy(true);
  try {
    if (!apiAvailable) {
      render(simulateMutation(url, body));
      return;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "request failed");
    render(payload);
  } catch (error) {
    apiAvailable = false;
    render(simulateMutation(url, body));
  } finally {
    setBusy(false);
  }
}

async function refresh() {
  if (!apiAvailable) {
    render(simulatedState);
    return;
  }
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error("API unavailable");
    render(await response.json());
  } catch {
    apiAvailable = false;
    render(simulatedState);
  }
}

async function resolveEns() {
  setBusy(true);
  try {
    const name = els.ensInput.value.trim();
    if (!apiAvailable) {
      simulatedState.ensLookup = simulatedEnsLookup(name);
      render(simulatedState);
      return;
    }
    const response = await fetch(`/api/ens/resolve?name=${encodeURIComponent(name)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "ENS resolve failed");
    render(payload);
  } catch (error) {
    apiAvailable = false;
    simulatedState.ensLookup = simulatedEnsLookup(els.ensInput.value.trim());
    render(simulatedState);
  } finally {
    setBusy(false);
  }
}

function render(state) {
  renderPosture(state.lease);
  renderLease(state.lease);
  renderEns(state.ens, state.ensResolver, state.ensLookup);
  renderAddresses(state.addresses, state.demo);
  renderKeeper(state.keeper);
  renderCounterparty(state.lease, state.ensLookup);
  renderTimeline(state.timeline, state.demo);
}

function renderPosture(lease) {
  const dot = els.postureCard.querySelector(".status-dot");
  dot.className = `status-dot ${dotClass(lease?.posture)}`;
  els.posture.textContent = lease?.posture ?? "NO LEASE";
  els.status.textContent = lease ? `${lease.status} lease #${lease.leaseId}` : "Create a lease to start.";
}

function renderLease(lease) {
  if (!lease) {
    els.leaseTitle.textContent = "No active lease";
    els.leaseFacts.innerHTML = "";
    return;
  }
  els.leaseTitle.textContent = `Lease #${lease.leaseId} / ${lease.status}`;
  els.leaseFacts.innerHTML = facts([
    ["agent", short(lease.agent)],
    ["max spend", `${lease.maxSpendEth} ETH`],
    ["spent", `${lease.spentEth} ETH`],
    ["unspent", `${lease.unspentEth} ETH`],
    ["allowed target", short(lease.allowedTarget)],
    ["selector", lease.allowedSelector],
    ["calldata hash", short(lease.allowedCalldataHash)],
    ["heartbeat", `${lease.heartbeatIntervalSeconds}s + ${lease.staleGracePeriodSeconds}s grace`],
    ["last heartbeat", formatDate(lease.lastHeartbeatIso)],
    ["expires", formatDate(lease.expiresAtIso)],
  ]);
}

function renderEns(ens, resolver, lookup) {
  const activeName = lookup?.name ?? ens.name;
  els.ensName.textContent = activeName;
  els.ensFacts.innerHTML = facts([
    ["resolver", resolver.configured ? "live ENS RPC" : "not configured"],
    ["namehash", short(lookup?.namehash ?? ens.namehash)],
    ["resolved addr", lookup?.address ? short(lookup.address) : "none"],
    ["registry", short(ens.records["capabilityLeases.registry"])],
    ["lease id", ens.records["capabilityLeases.leaseId"] || "not created"],
    ["policy hash", short(ens.records["capabilityLeases.policyHash"])],
    ["guardian", short(ens.records["capabilityLeases.guardian"])],
    ["missing records", lookup?.missingTextKeys?.length ? lookup.missingTextKeys.join(", ") : "none checked"],
  ]);
}

function renderAddresses(addresses, demo) {
  els.addressTitle.textContent =
    demo.mode === "deployed" ? `${demo.chainName ?? "Live"} deployment` : demo.mode === "local" ? "Local deployment" : "Static demo";
  els.addressFacts.innerHTML = facts([
    ["mode", demo.mode],
    ["chain", demo.chainName ?? "unknown"],
    ["chain id", demo.chainId],
    ["max spend", `${demo.maxSpendEth} ETH`],
    ["action value", `${demo.actionValueEth} ETH`],
    ["heartbeat", `${demo.heartbeatIntervalSeconds}s + ${demo.staleGraceSeconds}s grace`],
    ["expiry", `${demo.expiresInSeconds}s`],
    ["time travel", demo.timeTravelAvailable ? "available" : "live chain only"],
    ["explorer", demo.explorerBaseUrl ? "configured" : "not configured"],
    ["controller", short(addresses.controller)],
    ["router", short(addresses.router)],
    ["owner", short(addresses.owner)],
    ["agent", short(addresses.agent)],
    ["keeper", short(addresses.keeper)],
  ]);
}

function renderKeeper(keeper) {
  els.keeperTitle.textContent = keeper.running ? "Keeper online" : "Keeper paused";
  els.keeperFacts.innerHTML = facts([
    ["provider", keeper.provider],
    ["mode", keeper.keeperHub.mode],
    ["api key", keeper.keeperHub.apiKeyConfigured ? "configured" : "not configured"],
    ["wallet", keeper.keeperHub.walletConfigured ? "configured" : "not configured"],
    ["network", keeper.keeperHub.network],
    ["last scan", keeper.lastScanIso ? formatDate(keeper.lastScanIso) : "not yet"],
    ["watched leases", keeper.watchedLeaseIds.length ? keeper.watchedLeaseIds.join(", ") : "none"],
    ["role", "degrade late heartbeat; freeze missed heartbeat"],
  ]);
}

function renderCounterparty(lease, lookup) {
  const name = lookup?.name ?? "named agent";
  if (!lookup && !lease) {
    els.counterpartyTitle.textContent = "Waiting for named agent";
    els.counterpartyDecision.textContent =
      "Resolve a real ENS name or create a lease. The counterparty only delegates when the named agent resolves and its lease posture is green.";
    return;
  }
  if (lookup && !lookup.configured) {
    els.counterpartyTitle.textContent = "ENS resolver not configured";
    els.counterpartyDecision.innerHTML =
      "Set <strong>ETHEREUM_RPC_URL</strong> or <strong>ENS_RPC_URL</strong> to verify real ENS records. Placeholder identity is not prize-ready.";
    return;
  }
  if (lookup && !lookup.address) {
    els.counterpartyTitle.textContent = "Counterparty refuses";
    els.counterpartyDecision.innerHTML = `<strong>${escapeHtml(name)}</strong> did not resolve to an address. No delegation.`;
    return;
  }
  if (lease?.posture === "GREEN") {
    els.counterpartyTitle.textContent = "Counterparty can delegate";
    els.counterpartyDecision.innerHTML = `<strong>${escapeHtml(name)}</strong> is green. Lease is active, scoped, and heartbeat-current.`;
    return;
  }
  if (lease) {
    els.counterpartyTitle.textContent = "Counterparty refuses";
    els.counterpartyDecision.innerHTML = `<strong>${escapeHtml(name)}</strong> is ${escapeHtml(lease.posture)} / ${escapeHtml(lease.status)}. No new authority should be delegated.`;
    return;
  }
  els.counterpartyTitle.textContent = "Resolved, no active lease";
  els.counterpartyDecision.innerHTML = `<strong>${escapeHtml(name)}</strong> resolved, but no lease is active in this demo session.`;
}

function renderTimeline(events, demo) {
  if (!events.length) {
    els.timeline.innerHTML = `<p class="muted">No receipts yet. Create a lease to start the loop.</p>`;
    return;
  }
  els.timeline.innerHTML = events
    .map(
      (event) => `
        <article class="event">
          <strong>${escapeHtml(event.step)}</strong>
          <span class="pill ${pillClass(event.posture)}">${escapeHtml(event.posture)}</span>
          <span>${escapeHtml(event.detail ?? "")}</span>
          ${txMarkup(event, demo)}
        </article>
      `,
    )
    .join("");
}

function createSimulatedState() {
  return {
    addresses: {
      controller: "0x442781f981457813da9198871055ae91dfcb5a1d",
      router: "0xb23be6d0dff5ebbe7e15b1f48ab821b6ce0d2f39",
      owner: "0x3840022b7c29afc7e2ed204b4c30a60a85f6b87c",
      agent: "0x42475eac4d3b2ed0f8b5ff391824bf961aa51303",
      keeper: "0x9cb5c9214c0bfa1cf3b005019715987372262a94",
    },
    demo: {
      mode: "static-vercel-demo",
      chainId: 31337,
      chainName: "Static demo",
      explorerBaseUrl: "",
      maxSpendEth: "1",
      actionValueEth: "0.1",
      heartbeatIntervalSeconds: "120",
      staleGraceSeconds: "60",
      expiresInSeconds: "900",
      timeTravelAvailable: true,
    },
    ens: {
      name: "guarded-agent.eth",
      namehash: "0x7f1e364c1e85796dfde9454c3c272f86eb19c2aa92b26fa80a322ff6334ad03b",
      records: {
        "capabilityLeases.registry": "0x442781f981457813da9198871055ae91dfcb5a1d",
        "capabilityLeases.leaseId": "",
        "capabilityLeases.policyHash": "0x3e6a293fe369039cf7dfaa5ee57cc8f695520097905f423acd1295bd88b15434",
        "capabilityLeases.guardian": "0x9cb5c9214c0bfa1cf3b005019715987372262a94",
      },
    },
    keeper: {
      running: true,
      scanning: false,
      provider: "browser-simulated-keeper",
      keeperHub: {
        mode: "static-demo",
        network: "sepolia",
        walletConfigured: false,
        apiKeyConfigured: false,
      },
      lastScanIso: null,
      watchedLeaseIds: [],
    },
    ensResolver: {
      configured: false,
    },
    ensLookup: null,
    lease: null,
    timeline: [],
  };
}

function txMarkup(event, demo) {
  const label = escapeHtml(event.tx ?? "");
  if (!event.txHash || !demo?.explorerBaseUrl) return `<span class="muted">${label}</span>`;
  const href = `${stripTrailingSlash(demo.explorerBaseUrl)}/tx/${encodeURIComponent(event.txHash)}`;
  return `<a class="muted" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>`;
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function simulateMutation(url) {
  const nowIso = new Date().toISOString();
  if (url === "/api/create-lease") {
    simulatedState = createSimulatedState();
    simulatedState.ens.records["capabilityLeases.leaseId"] = "1";
    simulatedState.keeper.watchedLeaseIds = ["1"];
    simulatedState.lease = createSimulatedLease("ACTIVE", "GREEN", "0", "1");
    simulatedState.timeline.unshift(simEvent("created", "GREEN", "wallet-direct", "1 ETH max spend, executeRoute(USDC-WETH) only", "0xd0a5f8...0d02cf"));
    return simulatedState;
  }
  if (!simulatedState.lease) {
    simulatedState.lease = createSimulatedLease("ACTIVE", "GREEN", "0", "1");
    simulatedState.keeper.watchedLeaseIds = ["1"];
  }
  if (url === "/api/heartbeat") {
    simulatedState.lease.status = "ACTIVE";
    simulatedState.lease.posture = "GREEN";
    simulatedState.lease.lastHeartbeatIso = nowIso;
    simulatedState.timeline.unshift(simEvent("heartbeat", "GREEN", "wallet-direct", "agent proved liveness", "0x267772...fed0a4"));
  }
  if (url === "/api/execute-valid") {
    if (simulatedState.lease.status === "ACTIVE") {
      simulatedState.lease.spentEth = "0.1";
      simulatedState.lease.unspentEth = "0.9";
      simulatedState.timeline.unshift(
        simEvent("valid action", "GREEN", "wallet-direct", "allowed route executed and spend accounted", "0xba8bde...a4de13"),
      );
    } else {
      simulatedState.timeline.unshift(
        simEvent("valid action", simulatedState.lease.posture, "wallet-direct", `refused: LEASE_${simulatedState.lease.status}`, "0x0c0ed8...16c450"),
      );
    }
  }
  if (url === "/api/execute-invalid") {
    simulatedState.timeline.unshift(
      simEvent("invalid route", simulatedState.lease.posture, "wallet-direct", "refused: CALLDATA_NOT_ALLOWED", "0xee80d9...1ecf15"),
    );
  }
  if (url === "/api/advance-to-degrade") {
    simulatedState.lease.status = "DEGRADED";
    simulatedState.lease.posture = "YELLOW";
    simulatedState.timeline.unshift(simEvent("miss heartbeat", "YELLOW", "local-time", "advanced to cross heartbeat deadline", "local-time"));
    simulatedState.timeline.unshift(
      simEvent("keeper degraded", "YELLOW", "browser-simulated-keeper", "KeeperHub scan found late heartbeat via browser-simulated-keeper", "0x1b42aa...380e8a"),
    );
  }
  if (url === "/api/advance-to-freeze") {
    simulatedState.lease.status = "FROZEN";
    simulatedState.lease.posture = "RED";
    simulatedState.timeline.unshift(simEvent("miss grace", "RED", "local-time", "advanced to cross freeze deadline", "local-time"));
    simulatedState.timeline.unshift(
      simEvent("deadman freeze", "RED", "browser-simulated-keeper", "KeeperHub scan found missed heartbeat beyond grace via browser-simulated-keeper", "0x5e0d7a...678634"),
    );
  }
  if (url === "/api/keeper-scan") {
    simulatedState.keeper.lastScanIso = nowIso;
  }
  return simulatedState;
}

function createSimulatedLease(status, posture, spentEth, unspentEth) {
  return {
    leaseId: "1",
    owner: simulatedState.addresses.owner,
    agent: simulatedState.addresses.agent,
    spendToken: "0x0000000000000000000000000000000000000000",
    maxSpendEth: "1",
    spentEth,
    unspentEth,
    allowedTarget: simulatedState.addresses.router,
    allowedSelector: "0x4b9245c1",
    allowedCalldataHash: "0x9033d86b4f5d09024f300f0a7858c37127a6922ab2b199190c0c0853cd126c1e",
    heartbeatIntervalSeconds: "120",
    staleGracePeriodSeconds: "60",
    lastHeartbeatIso: new Date().toISOString(),
    expiresAtIso: new Date(Date.now() + 900_000).toISOString(),
    policyHash: simulatedState.ens.records["capabilityLeases.policyHash"],
    ensNamehash: simulatedState.ens.namehash,
    status,
    posture,
  };
}

function simulatedEnsLookup(name) {
  return {
    name: name || "guarded-agent.eth",
    namehash: simulatedState.ens.namehash,
    configured: false,
    address: null,
    textRecords: {
      "capabilityLeases.registry": null,
      "capabilityLeases.leaseId": null,
      "capabilityLeases.policyHash": null,
      "capabilityLeases.trustUrl": null,
      "capabilityLeases.guardian": null,
    },
    missingTextKeys: [
      "capabilityLeases.registry",
      "capabilityLeases.leaseId",
      "capabilityLeases.policyHash",
      "capabilityLeases.trustUrl",
      "capabilityLeases.guardian",
    ],
  };
}

function simEvent(step, posture, provider, detail, tx) {
  return {
    step,
    status: posture === "GREEN" ? "ACTIVE" : posture === "YELLOW" ? "DEGRADED" : "FROZEN",
    posture,
    provider,
    detail,
    tx,
    iso: new Date().toISOString(),
  };
}

function facts(rows) {
  return rows
    .map(
      ([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</dd>
        </div>
      `,
    )
    .join("");
}

function dotClass(posture) {
  if (posture === "GREEN") return "status-green";
  if (posture === "YELLOW") return "status-yellow";
  if (posture === "RED") return "status-red";
  return "status-muted";
}

function pillClass(posture) {
  if (posture === "GREEN") return "pill-green";
  if (posture === "YELLOW") return "pill-yellow";
  return "pill-red";
}

function short(value) {
  if (!value) return "";
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function setBusy(isBusy) {
  for (const control of document.querySelectorAll("button, input")) {
    control.disabled = isBusy;
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#039;";
    }
  });
}
