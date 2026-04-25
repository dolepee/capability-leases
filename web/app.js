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
let liveApiSeen = false;
let lastLiveState = null;

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
    if (!apiAvailable) throw new Error("Live API unavailable. Start the server-backed demo; no mock transactions are shown.");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "request failed");
    rememberLiveState(payload);
    render(payload);
  } catch (error) {
    apiAvailable = false;
    await renderLiveError(error);
  } finally {
    setBusy(false);
  }
}

async function refresh() {
  if (!apiAvailable) {
    await renderLiveError(new Error("Live API unavailable. This page does not use mock data."));
    return;
  }
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error("API unavailable");
    const payload = await response.json();
    rememberLiveState(payload);
    render(payload);
  } catch (error) {
    apiAvailable = false;
    await renderLiveError(error);
  }
}

async function resolveEns() {
  setBusy(true);
  try {
    const name = els.ensInput.value.trim();
    if (!apiAvailable) throw new Error("Live API unavailable. ENS lookup requires the server API.");
    const response = await fetch(`/api/ens/resolve?name=${encodeURIComponent(name)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "ENS resolve failed");
    rememberLiveState(payload);
    render(payload);
  } catch (error) {
    apiAvailable = false;
    await renderLiveError(error);
  } finally {
    setBusy(false);
  }
}

function rememberLiveState(state) {
  if (state?.demo?.mode && state.demo.mode !== "api-unavailable") {
    liveApiSeen = true;
    lastLiveState = state;
  }
}

async function renderLiveError(error) {
  let state = lastLiveState;
  try {
    const response = await fetch("/api/state");
    if (response.ok) {
      state = await response.json();
      rememberLiveState(state);
    }
  } catch {
    // Keep the last live state. Never downgrade a live session into generated demo data.
  }
  if (!state) {
    renderUnavailable(error);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const event = {
    step: "live API error",
    status: state.lease?.status ?? "ERROR",
    posture: state.lease?.posture ?? "RED",
    provider: "live-api",
    detail: message,
    tx: "no tx",
    txHash: null,
    iso: new Date().toISOString(),
  };
  render({ ...state, timeline: [event, ...(state.timeline ?? [])] });
}

function renderUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error);
  render({
    addresses: {
      controller: "",
      router: "",
      owner: "",
      agent: "",
      keeper: "",
    },
    demo: {
      mode: "api-unavailable",
      chainId: "unknown",
      chainName: "No live API",
      explorerBaseUrl: "",
      maxSpendEth: "unknown",
      actionValueEth: "unknown",
      heartbeatIntervalSeconds: "unknown",
      staleGraceSeconds: "unknown",
      expiresInSeconds: "unknown",
      timeTravelAvailable: false,
    },
    ens: {
      name: "requires-live-api",
      namehash: "",
      records: {
        "capabilityLeases.registry": "",
        "capabilityLeases.leaseId": "",
        "capabilityLeases.policyHash": "",
        "capabilityLeases.guardian": "",
      },
    },
    keeper: {
      running: false,
      scanning: false,
      provider: "not connected",
      keeperHub: {
        mode: "not connected",
        network: "unknown",
        walletConfigured: false,
        apiKeyConfigured: false,
      },
      lastScanIso: null,
      watchedLeaseIds: [],
    },
    ensResolver: { configured: false },
    ensLookup: null,
    lease: null,
    timeline: [
      {
        step: "live API unavailable",
        status: "ERROR",
        posture: "RED",
        provider: "frontend",
        detail: message,
        tx: "no mock data",
        txHash: null,
        iso: new Date().toISOString(),
      },
    ],
  });
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
    demo.mode === "deployed"
      ? `${demo.chainName ?? "Live"} deployment`
      : demo.mode === "local"
        ? "Local deployment"
        : "Live API unavailable";
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

function txMarkup(event, demo) {
  const label = escapeHtml(event.tx ?? "");
  if (!event.txHash || !demo?.explorerBaseUrl) return `<span class="muted">${label}</span>`;
  const href = `${stripTrailingSlash(demo.explorerBaseUrl)}/tx/${encodeURIComponent(event.txHash)}`;
  return `<a class="muted" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>`;
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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
