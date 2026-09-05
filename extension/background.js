/**
 * Background service worker: opens the full-page approval UI (never a popup)
 * and forwards pairing URIs to the Harness wallet runtime.
 */

async function loadConfig() {
  const url = chrome.runtime.getURL("runtime-config.json");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("runtime-config.json missing — launch via `hedera-harness wallet demo`");
  }
  return response.json();
}

async function openApprovePage(query = "") {
  const url = chrome.runtime.getURL(`approve.html${query}`);
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("approve.html*") });
  if (tabs[0]?.id) {
    await chrome.tabs.update(tabs[0].id, { url, active: true });
    return tabs[0].id;
  }
  const tab = await chrome.tabs.create({ url, active: true });
  return tab.id;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "harness-wallet-connect") {
    void (async () => {
      try {
        const config = await loadConfig();
        const pairingString = message.pairingString;
        await openApprovePage(`?mode=pair`);
        const response = await fetch(`${config.runtimeBaseUrl}/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uri: pairingString }),
        });
        const body = await response.json();
        sendResponse({ ok: response.ok, body });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return true;
  }

  if (message.type === "harness-wallet-open") {
    void openApprovePage().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "harness-wallet-get-config") {
    void loadConfig()
      .then(config => sendResponse({ ok: true, config }))
      .catch(error =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }
});

chrome.action.onClicked.addListener(() => {
  void openApprovePage();
});
