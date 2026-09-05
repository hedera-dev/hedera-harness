/**
 * Hedera WalletConnect extension discovery (HIP-820 / hedera-wallet-connect).
 * Responds to hedera-extension-query and relays pairing strings to the background.
 */

const EXTENSION_ID = "harness-test-wallet";
const EXTENSION_NAME = "Harness Test Wallet";

function metadata() {
  return {
    id: EXTENSION_ID,
    name: EXTENSION_NAME,
    url: chrome.runtime.getURL("approve.html"),
    icon: chrome.runtime.getURL("icon.svg"),
    description: "Persistent Hedera testnet wallet for hedera-harness",
  };
}

window.addEventListener("message", event => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "hedera-extension-query" || data.type === `hedera-extension-query-${EXTENSION_ID}`) {
    window.postMessage(
      {
        type: "hedera-extension-response",
        metadata: metadata(),
      },
      "*",
    );
    return;
  }

  if (data.type === `hedera-extension-connect-${EXTENSION_ID}`) {
    const pairingString = data.pairingString;
    if (typeof pairingString !== "string" || !pairingString) return;
    chrome.runtime.sendMessage({
      type: "harness-wallet-connect",
      pairingString,
    });
  }

  if (data.type === `hedera-extension-open-${EXTENSION_ID}`) {
    chrome.runtime.sendMessage({ type: "harness-wallet-open" });
  }
});

// Announce presence for dApps that listen after load.
window.postMessage(
  {
    type: "hedera-extension-response",
    metadata: metadata(),
  },
  "*",
);
