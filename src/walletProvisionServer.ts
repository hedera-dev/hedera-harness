import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { inspectWalletReady, writeVaultFile } from "./walletVault.js";
import { walletProvisionPageHtml } from "./walletProvisionPage.js";

export interface ProvisionServerResult {
  url: string;
  close: () => Promise<void>;
  /** Resolves when the human saves a valid vault (or the server closes). */
  saved: Promise<void>;
}

/**
 * Bind 127.0.0.1 only. The POST body is never logged.
 */
export function startWalletProvisionServer(
  workspaceDir: string,
  port = 0,
): Promise<ProvisionServerResult> {
  return new Promise((resolve, reject) => {
    let settleSaved: () => void = () => undefined;
    const saved = new Promise<void>(res => {
      settleSaved = res;
    });

    const server = createServer((req, res) => {
      void handle(req, res, workspaceDir, () => {
        settleSaved();
      });
    });

    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Wallet provision server failed to bind 127.0.0.1."));
        return;
      }
      const url = `http://127.0.0.1:${address.port}/`;
      resolve({
        url,
        saved,
        close: () =>
          new Promise((res, rej) => {
            server.close(err => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  onSaved: () => void,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(walletProvisionPageHtml());
    return;
  }
  if (req.method === "POST" && url.pathname === "/save") {
    try {
      const raw = await readBody(req, 16_384);
      const parsed = JSON.parse(raw) as { password?: unknown; privateKey?: unknown };
      writeVaultFile(workspaceDir, {
        password: String(parsed.password ?? ""),
        privateKey: String(parsed.privateKey ?? ""),
      });
      const status = inspectWalletReady(workspaceDir);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("Saved. You can close this tab. The agent never received the key.");
      if (status.ready) onSaved();
    } catch (error) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  res.writeHead(404);
  res.end("Not found");
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
