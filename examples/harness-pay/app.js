/**
 * Minimal standard-ish Hedera extension discovery client.
 * Uses the same postMessage protocol as @hashgraph/hedera-wallet-connect
 * (hedera-extension-query / hedera-extension-response / hedera-extension-connect-*).
 *
 * No Harness-specific application code — any compliant wallet can answer.
 */

const connectBtn = document.getElementById("connect-btn");
const payBtn = document.getElementById("pay-btn");
const walletLabel = document.getElementById("wallet-label");
const extensionsEl = document.getElementById("extensions");
const resultEl = document.getElementById("result");

const params = new URLSearchParams(location.search);
const runtimeBaseUrl = params.get("runtime") ?? "";
const payTo = params.get("payTo") ?? "";
const amount = Number(params.get("amount") ?? "1");
const asset = params.get("asset") ?? "hbar";

/** @type {Map<string, { id: string, name?: string, icon?: string, url?: string }>} */
const extensions = new Map();
let connectedAccount = null;

function setResult(text, ok = false) {
  resultEl.textContent = text;
  resultEl.className = ok ? "ok" : "";
}

function renderExtensions() {
  extensionsEl.innerHTML = "";
  for (const extension of extensions.values()) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = extension.name ?? extension.id;
    button.dataset.extensionId = extension.id;
    button.addEventListener("click", () => {
      void connectExtension(extension.id);
    });
    li.appendChild(button);
    extensionsEl.appendChild(li);
  }
}

window.addEventListener("message", event => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type !== "hedera-extension-response" || !data.metadata?.id) return;
  extensions.set(data.metadata.id, data.metadata);
  renderExtensions();
});

function discover() {
  extensions.clear();
  renderExtensions();
  window.postMessage({ type: "hedera-extension-query" }, "*");
  window.postMessage({ type: "hedera-extension-query-harness-test-wallet" }, "*");
}

async function connectExtension(extensionId) {
  const pairingString =
    params.get("wcUri") ??
    `wc:harness-demo@2?relay-protocol=harness&symKey=${crypto.randomUUID().replaceAll("-", "")}`;

  // Standard extension connect — the wallet opens its approval UI and pairs.
  window.postMessage(
    {
      type: `hedera-extension-connect-${extensionId}`,
      pairingString,
    },
    "*",
  );

  setResult("Approve the connection in Harness Test Wallet…");
  connectedAccount = await waitForPairedAccount();
  walletLabel.textContent = connectedAccount;
  payBtn.style.display = "block";
  connectBtn.textContent = "Connected";
  connectBtn.disabled = true;
  setResult("Connected");
}

async function waitForPairedAccount() {
  if (!runtimeBaseUrl) {
    throw new Error("Missing ?runtime= query param pointing at the Harness wallet runtime");
  }
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const state = await (await fetch(`${runtimeBaseUrl}/state`)).json();
    if (state.paired) {
      return state.accountId;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error("Timed out waiting for wallet approval");
}

connectBtn.addEventListener("click", () => {
  discover();
  window.setTimeout(() => {
    const harness = extensions.get("harness-test-wallet");
    if (harness) {
      void connectExtension(harness.id);
    }
  }, 400);
});

payBtn.addEventListener("click", () => {
  void (async () => {
    setResult("Waiting for wallet signature…");
    const response = await fetch(`${runtimeBaseUrl}/request-transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        detail: asset === "usdc" ? `Send ${amount} USDC` : `Send ${amount} HBAR`,
        dappName: "Harness Pay",
        method: "hedera_signAndExecuteTransaction",
        asset,
        amount,
        toAccountId: payTo,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setResult(body.error ?? "Payment failed");
      return;
    }
    const txId = body.result?.transactionId ?? body.lastResult?.transactionId;
    setResult(`Payment successful\nTx: ${txId}`, true);
  })().catch(error => setResult(error.message));
});

discover();
