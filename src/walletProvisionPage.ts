export function walletProvisionPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hedera Harness — test wallet (local)</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; background: #111; color: #eee; }
    h1 { font-size: 1.25rem; }
    .warn { border: 1px solid #c2410c; background: #431407; padding: 0.75rem 1rem; border-radius: 0.5rem; }
    label { display: block; margin-top: 1rem; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; margin-top: 0.35rem; padding: 0.5rem; border-radius: 0.35rem; border: 1px solid #444; background: #1a1a1a; color: #eee; }
    button { margin-top: 1.25rem; padding: 0.6rem 1rem; font-weight: 600; border: 0; border-radius: 0.35rem; background: #8259ef; color: #fff; cursor: pointer; }
    button:disabled { opacity: 0.5; }
    .ok { color: #86efac; }
    .err { color: #fca5a5; }
    a { color: #c4b5fd; }
  </style>
</head>
<body>
  <h1>MetaMask test vault (this machine only)</h1>
  <div class="warn">
    <p><strong>TESTNET ONLY.</strong> Create a throwaway account at
      <a href="https://portal.hedera.com/" target="_blank" rel="noreferrer">portal.hedera.com</a>
      and fund it from the faucet. <strong>Never</strong> paste a mainnet or personal wallet key.</p>
    <p>This page is <code>127.0.0.1</code> only. The key is written to <code>.harness/wallet/</code> (gitignored). The OpenCode agent cannot read that folder and you should not paste the key in chat.</p>
  </div>
  <form id="form">
    <label>MetaMask password (min 8 characters)
      <input type="password" name="password" id="password" autocomplete="new-password" minlength="8" required />
    </label>
    <label>Testnet private key (64 hex, optional 0x)
      <input type="password" name="privateKey" id="privateKey" autocomplete="off" required />
    </label>
    <button type="submit" id="save">Save locally</button>
  </form>
  <p id="out"></p>
  <script>
    const form = document.getElementById("form");
    const out = document.getElementById("out");
    const save = document.getElementById("save");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      out.textContent = "Saving…";
      out.className = "";
      try {
        const body = {
          password: document.getElementById("password").value,
          privateKey: document.getElementById("privateKey").value,
        };
        const res = await fetch("/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(text || res.statusText);
        out.textContent = text;
        out.className = "ok";
        form.reset();
      } catch (error) {
        out.textContent = error instanceof Error ? error.message : String(error);
        out.className = "err";
        save.disabled = false;
      }
    });
  </script>
</body>
</html>
`;
}
