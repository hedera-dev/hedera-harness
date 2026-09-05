const accountEl = document.getElementById("account");
const sessionEl = document.getElementById("session");
const pendingPanel = document.getElementById("pending-panel");
const pendingTitle = document.getElementById("pending-title");
const pendingDetail = document.getElementById("pending-detail");
const idleMsg = document.getElementById("idle-msg");
const statusEl = document.getElementById("status");
const approveBtn = document.getElementById("approve-btn");
const signBtn = document.getElementById("sign-btn");
const rejectBtn = document.getElementById("reject-btn");

let runtimeBaseUrl = "";
let pollTimer;

async function loadConfig() {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    const response = await fetch(chrome.runtime.getURL("runtime-config.json"));
    return response.json();
  }
  // Standalone page fallback for local debugging.
  const response = await fetch("./runtime-config.json");
  return response.json();
}

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
}

function render(state) {
  accountEl.textContent = state.accountId ?? "—";
  sessionEl.textContent = state.paired ? state.sessionTopic ?? "paired" : "not paired";

  if (state.pending) {
    pendingPanel.hidden = false;
    idleMsg.hidden = true;
    pendingTitle.textContent = state.pending.title;
    pendingDetail.textContent = state.pending.detail;
    const isTx = state.pending.kind === "transaction";
    approveBtn.style.display = isTx ? "none" : "block";
    signBtn.style.display = isTx ? "block" : "none";
  } else {
    pendingPanel.hidden = true;
    idleMsg.hidden = false;
    approveBtn.style.display = "block";
    signBtn.style.display = "none";
  }

  if (state.lastResult) {
    setStatus(`Signed ${state.lastResult.transactionId} (${state.lastResult.status})`, "ok");
  }
}

async function refresh() {
  if (!runtimeBaseUrl) return;
  const response = await fetch(`${runtimeBaseUrl}/state`);
  if (!response.ok) {
    setStatus(`Runtime unreachable (${response.status})`, "err");
    return;
  }
  render(await response.json());
}

async function post(path) {
  const response = await fetch(`${runtimeBaseUrl}${path}`, { method: "POST" });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  render(body);
  return body;
}

approveBtn.addEventListener("click", () => {
  void post("/approve")
    .then(() => setStatus("Connection approved", "ok"))
    .catch(error => setStatus(error.message, "err"));
});

signBtn.addEventListener("click", () => {
  void post("/approve")
    .then(() => setStatus("Transaction signed", "ok"))
    .catch(error => setStatus(error.message, "err"));
});

rejectBtn.addEventListener("click", () => {
  void post("/reject")
    .then(() => setStatus("Rejected", "err"))
    .catch(error => setStatus(error.message, "err"));
});

void (async () => {
  try {
    const config = await loadConfig();
    runtimeBaseUrl = config.runtimeBaseUrl;
    accountEl.textContent = config.accountId;
    await refresh();
    pollTimer = window.setInterval(() => {
      void refresh();
    }, 500);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "err");
  }
})();

window.addEventListener("unload", () => {
  if (pollTimer) window.clearInterval(pollTimer);
});
