import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { importHieroSdk } from "../optionalDeps.js";
import type { PersistentWallet } from "../types.js";
import { HARNESS_WALLET_EXTENSION_ID, HARNESS_WALLET_NAME } from "./constants.js";
import { signAndExecuteTransactionBytes, transferHbar, transferHtsFungible } from "./signer.js";
import { assertTestnetOnly } from "./store.js";

export interface PendingApproval {
  id: string;
  kind: "session_proposal" | "transaction";
  title: string;
  detail: string;
  createdAt: string;
  /** Raw WalletConnect request payload when kind=transaction. */
  transactionListBase64?: string;
  method?: string;
  dappName?: string;
}

export interface WalletRuntimeState {
  accountId: string;
  network: "testnet";
  extensionId: string;
  extensionName: string;
  paired: boolean;
  sessionTopic?: string;
  pending: PendingApproval | null;
  lastResult?: {
    transactionId: string;
    status: string;
    at: string;
  };
}

export interface WalletRuntimeHandle {
  port: number;
  baseUrl: string;
  state: () => WalletRuntimeState;
  /** Inject a pairing URI (from extension hedera-extension-connect). */
  submitPairingUri: (uri: string) => Promise<void>;
  close: () => Promise<void>;
}

export interface StartWalletRuntimeOptions {
  wallet: PersistentWallet;
  projectId: string;
  /** Prefer real WalletKit when deps are installed; otherwise use local demo bridge. */
  preferWalletKit?: boolean;
  host?: string;
}

/**
 * Local Harness wallet runtime.
 *
 * Holds the persistent key, exposes a tiny HTTP API the extension approve page
 * talks to, and (when @reown/walletkit is available) pairs via WalletConnect.
 * Signing always goes through {@link signAndExecuteTransactionBytes} — never WalletKit.
 */
export async function startWalletRuntime(
  options: StartWalletRuntimeOptions,
): Promise<WalletRuntimeHandle> {
  assertTestnetOnly(options.wallet.network);
  const host = options.host ?? "127.0.0.1";

  let pending: PendingApproval | null = null;
  let paired = false;
  let sessionTopic: string | undefined;
  let lastResult: WalletRuntimeState["lastResult"];
  let walletKit: WalletKitAdapter | undefined;
  const pendingResolvers = new Map<
    string,
    { resolve: (approved: boolean) => void; reject: (error: Error) => void }
  >();

  if (options.preferWalletKit !== false) {
    walletKit = await tryInitWalletKit({
      projectId: options.projectId,
      wallet: options.wallet,
      onSessionProposal: proposal => {
        const id = `session-${proposal.id}`;
        pending = {
          id,
          kind: "session_proposal",
          title: "Connection request",
          detail: `${proposal.dappName} wants access to ${options.wallet.accountId}`,
          createdAt: new Date().toISOString(),
          dappName: proposal.dappName,
        };
        return waitForDecision(id);
      },
      onTransactionRequest: request => {
        const id = `tx-${request.id}`;
        pending = {
          id,
          kind: "transaction",
          title: "Transaction request",
          detail: request.detail,
          createdAt: new Date().toISOString(),
          transactionListBase64: request.transactionListBase64,
          method: request.method,
          dappName: request.dappName,
        };
        return waitForDecision(id);
      },
      onPaired: topic => {
        paired = true;
        sessionTopic = topic;
      },
      onSigned: result => {
        lastResult = { ...result, at: new Date().toISOString() };
        pending = null;
      },
    });
  }

  function waitForDecision(id: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      pendingResolvers.set(id, { resolve, reject });
    });
  }

  function decide(id: string, approved: boolean): void {
    const resolver = pendingResolvers.get(id);
    if (!resolver) {
      throw new Error(`No pending approval ${id}`);
    }
    pendingResolvers.delete(id);
    resolver.resolve(approved);
  }

  async function handleApprove(): Promise<WalletRuntimeState> {
    if (!pending) {
      throw new Error("No pending approval");
    }
    const current = pending;
    decide(current.id, true);
    if (current.kind === "session_proposal") {
      paired = true;
      pending = null;
    }
    // Transaction pending is cleared by the request handler after signing.
    return snapshot();
  }

  async function handleReject(): Promise<WalletRuntimeState> {
    if (!pending) {
      throw new Error("No pending approval");
    }
    decide(pending.id, false);
    pending = null;
    return snapshot();
  }

  function snapshot(): WalletRuntimeState {
    return {
      accountId: options.wallet.accountId,
      network: "testnet",
      extensionId: HARNESS_WALLET_EXTENSION_ID,
      extensionName: HARNESS_WALLET_NAME,
      paired,
      sessionTopic,
      pending,
      lastResult,
    };
  }

  const server = createServer((req, res) => {
    void routeRequest(req, res, {
      snapshot,
      submitPairingUri: async uri => {
        if (walletKit) {
          await walletKit.pair(uri);
          return;
        }
        // Demo bridge: treat pairing URI arrival as a session proposal.
        const id = `session-local-${Date.now()}`;
        pending = {
          id,
          kind: "session_proposal",
          title: "Connection request",
          detail: `dApp wants access to ${options.wallet.accountId}`,
          createdAt: new Date().toISOString(),
          dappName: "Harness Pay",
        };
        const approved = await waitForDecision(id);
        if (!approved) {
          throw new Error("Connection rejected");
        }
        paired = true;
        sessionTopic = `local:${Buffer.from(uri).toString("base64url").slice(0, 16)}`;
        pending = null;
      },
      enqueueLocalTransaction: async body => {
        const id = `tx-local-${Date.now()}`;
        pending = {
          id,
          kind: "transaction",
          title: "Transaction request",
          detail: body.detail,
          createdAt: new Date().toISOString(),
          transactionListBase64: body.transactionListBase64,
          method: body.method ?? "hedera_signAndExecuteTransaction",
          dappName: body.dappName ?? "Harness Pay",
        };
        const approved = await waitForDecision(id);
        if (!approved) {
          throw new Error("Transaction rejected");
        }
        if (!body.transactionListBase64) {
          // Convenience path for demo dApp that asks runtime to build a transfer.
          const result =
            body.asset === "usdc" && body.tokenId && body.toAccountId && body.amount
              ? await transferHtsFungible(
                  options.wallet,
                  body.tokenId,
                  body.toAccountId,
                  body.amount,
                )
              : await transferHbar(
                  options.wallet,
                  body.toAccountId ?? "",
                  body.amount ?? 1,
                );
          lastResult = { ...result, at: new Date().toISOString() };
          pending = null;
          return result;
        }
        const result = await signAndExecuteTransactionBytes(
          options.wallet,
          body.transactionListBase64,
        );
        lastResult = { ...result, at: new Date().toISOString() };
        pending = null;
        return result;
      },
      handleApprove,
      handleReject,
    });
  });

  const port = await listen(server, host);

  return {
    port,
    baseUrl: `http://${host}:${port}`,
    state: snapshot,
    submitPairingUri: async uri => {
      if (walletKit) {
        await walletKit.pair(uri);
        return;
      }
      const id = `session-local-${Date.now()}`;
      pending = {
        id,
        kind: "session_proposal",
        title: "Connection request",
        detail: `dApp wants access to ${options.wallet.accountId}`,
        createdAt: new Date().toISOString(),
        dappName: "Harness Pay",
      };
      const approved = await waitForDecision(id);
      if (!approved) {
        throw new Error("Connection rejected");
      }
      paired = true;
      sessionTopic = `local:${Buffer.from(uri).toString("base64url").slice(0, 16)}`;
      pending = null;
    },
    close: async () => {
      for (const [, resolver] of pendingResolvers) {
        resolver.reject(new Error("Wallet runtime closed"));
      }
      pendingResolvers.clear();
      if (walletKit) {
        await walletKit.close();
      }
      await closeServer(server);
    },
  };
}

interface LocalTxBody {
  detail: string;
  transactionListBase64?: string;
  method?: string;
  dappName?: string;
  asset?: "hbar" | "usdc";
  tokenId?: string;
  toAccountId?: string;
  amount?: number;
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: {
    snapshot: () => WalletRuntimeState;
    submitPairingUri: (uri: string) => Promise<void>;
    enqueueLocalTransaction: (body: LocalTxBody) => Promise<{ transactionId: string; status: string }>;
    handleApprove: () => Promise<WalletRuntimeState>;
    handleReject: () => Promise<WalletRuntimeState>;
  },
): Promise<void> {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      json(res, 200, handlers.snapshot());
      return;
    }
    if (req.method === "POST" && url.pathname === "/pair") {
      const body = (await readJson(req)) as { uri?: string };
      if (!body.uri) {
        json(res, 400, { error: "uri required" });
        return;
      }
      await handlers.submitPairingUri(body.uri);
      json(res, 200, handlers.snapshot());
      return;
    }
    if (req.method === "POST" && url.pathname === "/approve") {
      json(res, 200, await handlers.handleApprove());
      return;
    }
    if (req.method === "POST" && url.pathname === "/reject") {
      json(res, 200, await handlers.handleReject());
      return;
    }
    if (req.method === "POST" && url.pathname === "/request-transaction") {
      const body = (await readJson(req)) as LocalTxBody;
      if (!body.detail) {
        json(res, 400, { error: "detail required" });
        return;
      }
      const result = await handlers.enqueueLocalTransaction(body);
      json(res, 200, { ...handlers.snapshot(), result });
      return;
    }
    if (req.method === "GET" && url.pathname === "/build-hbar-transfer") {
      // Helper for tests: build a TransactionList base64 the demo can submit.
      const to = url.searchParams.get("to");
      const amount = Number(url.searchParams.get("amount") ?? "1");
      const from = url.searchParams.get("from");
      if (!to || !from) {
        json(res, 400, { error: "from and to required" });
        return;
      }
      const sdk = await importHieroSdk();
      const client = sdk.Client.forTestnet();
      try {
        const tx = await new sdk.TransferTransaction()
          .addHbarTransfer(sdk.AccountId.fromString(from), new sdk.Hbar(amount).negated())
          .addHbarTransfer(sdk.AccountId.fromString(to), new sdk.Hbar(amount))
          .freezeWith(client);
        json(res, 200, {
          transactionListBase64: Buffer.from(tx.toBytes()).toString("base64"),
        });
      } finally {
        client.close();
      }
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { error: message });
  }
}

interface WalletKitAdapter {
  pair: (uri: string) => Promise<void>;
  close: () => Promise<void>;
}

async function tryInitWalletKit(_args: {
  projectId: string;
  wallet: PersistentWallet;
  onSessionProposal: (proposal: { id: number; dappName: string }) => Promise<boolean>;
  onTransactionRequest: (request: {
    id: number;
    detail: string;
    transactionListBase64: string;
    method: string;
    dappName?: string;
  }) => Promise<boolean>;
  onPaired: (topic: string) => void;
  onSigned: (result: { transactionId: string; status: string }) => void;
}): Promise<WalletKitAdapter | undefined> {
  // WalletKit relay pairing is optional stretch. The golden-path demo uses the
  // local HTTP bridge after standard extension discovery so PO1/PO2 hold
  // without a Reown relay dependency at runtime.
  void _args;
  return undefined;
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind wallet runtime"));
        return;
      }
      resolve(address.port);
    });
    server.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
