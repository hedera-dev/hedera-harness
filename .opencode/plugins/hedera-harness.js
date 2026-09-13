import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const KEY_RE =
  /0x[a-fA-F0-9]{64}|(?:private[_ ]?key|secretKey|ecdsa)["']?\s*[:=]\s*["']?[^\s"']+|302e020100[a-fA-F0-9]+/gi;

function redact(text) {
  return text.replace(KEY_RE, "[redacted]");
}

function isWalletSecretPath(filePath) {
  if (!filePath) return false;
  const n = normalize(String(filePath)).split(sep).join("/").toLowerCase();
  if (n.includes("/.harness/wallet/")) return true;
  if (n.endsWith(".env") || n.includes("/.env.")) return true;
  return false;
}

function loadPointer(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const pointerPath = join(dir, ".opencode", "hedera-harness.json");
    if (existsSync(pointerPath)) {
      try {
        return JSON.parse(readFileSync(pointerPath, "utf8"));
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function findHarnessRoot(start) {
  const pointer = loadPointer(start);
  if (pointer?.harnessRoot && existsSync(join(pointer.harnessRoot, "dist", "index.js"))) {
    return pointer.harnessRoot;
  }
  if (pointer?.cli && existsSync(pointer.cli)) {
    return dirname(dirname(pointer.cli));
  }
  let dir = start;
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath) && existsSync(join(dir, "dist", "index.js"))) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "hedera-harness") return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function packageName(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
  } catch {
    return undefined;
  }
}

/** Size-only. Never read vault JSON. */
function vaultFileLooksPresent(workspace) {
  const file = join(workspace, ".harness", "wallet", "metamask-test.json");
  try {
    if (!existsSync(file)) return false;
    const st = statSync(file);
    return st.isFile() && st.size >= 80 && st.size <= 8192;
  } catch {
    return false;
  }
}

function isHarnessAppWorkspace(dir) {
  if (!existsSync(join(dir, ".harness", "spec.yaml"))) return false;
  return packageName(dir) !== "hedera-harness";
}

function isHarnessCliPackage(dir) {
  return packageName(dir) === "hedera-harness" && existsSync(join(dir, "dist", "index.js"));
}

function preferTestApp(cliRoot) {
  const nested = join(cliRoot, "test-app");
  if (vaultFileLooksPresent(nested) || isHarnessAppWorkspace(nested)) return nested;
  return undefined;
}

function resolveAppWorkspace(startDir) {
  const start = resolve(startDir || ".");
  if (isHarnessAppWorkspace(start) || vaultFileLooksPresent(start)) return start;
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (isHarnessCliPackage(dir)) break;
    if (isHarnessAppWorkspace(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (isHarnessCliPackage(start)) {
    const nested = preferTestApp(start);
    if (nested) return nested;
  }
  return start;
}

function toolWorkspace(args, context) {
  return resolveAppWorkspace(args.workspace || context.directory);
}

async function importDist(cwd, rel) {
  const root = findHarnessRoot(cwd);
  const file = join(root, "dist", rel);
  if (!existsSync(file)) {
    throw new Error(`${file} missing. Run npm run build in the hedera-harness repo.`);
  }
  return import(pathToFileURL(file).href);
}

async function walletStatusText(cwd) {
  try {
    const vault = await importDist(cwd, "walletVault.js");
    return vault.formatWalletStatus(vault.inspectWalletReady(cwd));
  } catch (error) {
    if (vaultFileLooksPresent(cwd)) {
      return [
        "ready=true",
        `workspace=${cwd}`,
        "vault=present",
        "reason=TESTNET vault file is on disk. Agent must not read .harness/wallet/.",
        "never_ask_in_chat=true",
      ].join("\n");
    }
    return `ready=false\nworkspace=${cwd}\nerror=${error instanceof Error ? error.message : String(error)}`;
  }
}

const WALLET_PROVISION_PORT = "17373";

function isWalletReady(status) {
  return /\bready=true\b/.test(String(status));
}

/** OpenCode plugins run under opencode.exe — that cannot execute dist/index.js. */
function nodeExecutable() {
  const exe = String(process.execPath || "").replace(/\\/g, "/");
  if (/node(?:\.exe)?$/i.test(exe)) return process.execPath;
  return "node";
}

function waitForProvisionPage(port, timeoutMs) {
  const started = Date.now();
  return new Promise(resolve => {
    const attempt = () => {
      const req = httpRequest(
        { host: "127.0.0.1", port: Number(port), path: "/", timeout: 400 },
        res => {
          res.resume();
          if (res.statusCode === 200) {
            resolve(true);
            return;
          }
          retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
      req.end();
    };
    const retry = () => {
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

async function openWalletGate(start) {
  const cwd = resolveAppWorkspace(start);
  const status = await walletStatusText(cwd);
  const vaultPresent = vaultFileLooksPresent(cwd);
  if (isWalletReady(status) || vaultPresent) {
    const lines = [
      "gate=ok",
      "ready=true",
      `workspace=${cwd}`,
      "vault=present",
      "The provision page closes after save — that is expected. Do not reopen it.",
    ];
    if (isWalletReady(status)) lines.push(status);
    else {
      lines.push(
        "reason=TESTNET vault file is on disk. Agent must not read .harness/wallet/.",
        "never_ask_in_chat=true",
      );
    }
    return lines.join("\n");
  }
  const root = findHarnessRoot(cwd);
  const entry = join(root, "dist", "index.js");
  const port = WALLET_PROVISION_PORT;
  const nodeBin = nodeExecutable();
  const repair = `${nodeBin} "${entry}" wallet provision --workspace "${cwd}" --port ${port}`;
  let up = await waitForProvisionPage(port, 600);
  if (!up) {
    const child = spawn(nodeBin, [entry, "wallet", "provision", "--workspace", cwd, "--port", port], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: root,
    });
    child.unref();
    up = await waitForProvisionPage(port, 8000);
  }
  return [
    "gate=blocked",
    status,
    `workspace=${cwd}`,
    "",
    "FORBIDDEN: do not spawn hedera-prd, hedera-generate, hedera-assert, hedera-smoke, hedera-evaluate, or hedera-local. Do not edit product files.",
    "A local page must be open on this machine. Paste the TESTNET key THERE — never in this chat.",
    `url=http://127.0.0.1:${port}/`,
    `server=${up ? "up" : "down"}`,
    "Create a throwaway testnet account at https://portal.hedera.com/ — never a real wallet.",
    up
      ? "Open that URL in the human's browser if it did not pop up. After Saved, close the tab and say so — the server shutting down is expected."
      : `The page is not listening. Ask the human to run:\n${repair}`,
    "Poll harness_wallet_gate until gate=ok. Do not ask for the key. server=down after a successful save is not a failure.",
  ].join("\n");
}

function runHarness(directory, args, timeoutMs = 120_000) {
  const root = findHarnessRoot(directory);
  const entry = join(root, "dist", "index.js");
  if (!existsSync(entry)) {
    return "dist/index.js missing. Run `npm run build` in the hedera-harness repo first.";
  }
  const result = spawnSync(nodeExecutable(), [entry, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) return redact(result.error.message);
  if (result.status !== 0 && !combined) return `hedera-harness exited ${result.status}`;
  return redact(combined || "(no output)");
}

const INIT_TIMEOUT_MS = 20 * 60 * 1000;

function collectRunDirs(root) {
  const runs = join(root, ".harness", "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .map((name) => join(runs, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

function latestStatus(directory) {
  const root = findHarnessRoot(directory);
  const candidates = [...collectRunDirs(root), ...collectRunDirs(join(root, "demo-app")), ...collectRunDirs(directory)];
  if (candidates.length === 0) return "No .harness/runs directories found.";
  candidates.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  const newest = candidates[0];
  const parts = [`run: ${newest}`];
  for (const file of [join(newest, "status.json"), join(newest, "session.json")]) {
    if (!existsSync(file)) continue;
    try {
      parts.push(`${file}:\n${redact(readFileSync(file, "utf8"))}`);
    } catch (error) {
      parts.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return parts.join("\n\n");
}

function secretHooks() {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read" && isWalletSecretPath(String(output.args.filePath ?? ""))) {
        throw new Error(
          "Do not read .harness/wallet or .env. Use `harness_wallet_status` or `node dist/index.js wallet status`.",
        );
      }
      if (input.tool === "bash") {
        const command = String(output.args.command ?? "");
        if (
          /[\\/]\.harness[\\/]wallet[\\/]|\.env(\s|$)/i.test(command) &&
          /(cat|type|Get-Content|more|less)\b/i.test(command)
        ) {
          throw new Error("Do not dump wallet files or .env from the shell.");
        }
      }
    },
  };
}

export const HederaHarnessPlugin = async () => {
  const hooks = secretHooks();
  try {
    const { tool } = await import("@opencode-ai/plugin");
    hooks.tool = {
      harness_doctor: tool({
        description: "Run hedera-harness doctor. Never prints wallet private keys.",
        args: {
          workspace: tool.schema.string().optional().describe("App workspace for doctor; defaults to project"),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          return runHarness(cwd, ["doctor", "--workspace", cwd]);
        },
      }),
      harness_wallet_status: tool({
        description:
          "Whether a TESTNET MetaMask vault exists (ready true/false). Never returns the private key or password. If ready=false, call harness_wallet_gate next — never ask for the key in chat, never continue to PRD/GENERATE.",
        args: {
          workspace: tool.schema.string().optional().describe("App workspace that holds .harness/wallet"),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          return walletStatusText(cwd);
        },
      }),
      harness_wallet_gate: tool({
        description:
          "HARD GATE independent of INIT. Call immediately before hedera-prd, hedera-generate, hedera-assert, hedera-smoke, hedera-evaluate, or hedera-local — including increments that skip INIT. Returns gate=ok or gate=blocked. If blocked, open the local provision page and poll this tool until gate=ok. Never collect the key via question/chat. Do not spawn those agents or edit product files while blocked.",
        args: {
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return openWalletGate(toolWorkspace(args, context));
        },
      }),
      harness_wallet_provision: tool({
        description:
          "Opens a local 127.0.0.1 page so the human can save a TESTNET MetaMask key+password. Same as harness_wallet_gate when not ready. Never collect the key via question/chat. Poll until gate=ok / ready=true.",
        args: {
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return openWalletGate(toolWorkspace(args, context));
        },
      }),
      harness_wallet_browser: tool({
        description:
          "Start headed Chromium with MetaMask (dappwright). First run imports the TESTNET vault and Hedera Testnet into .harness/wallet/chrome-profile/. Later runs unlock. Never prints keys.",
        args: {
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const status = await walletStatusText(cwd);
          if (!isWalletReady(status)) {
            return `${await openWalletGate(cwd)}\nRun harness_wallet_gate until gate=ok. Do not ask for the key in chat.`;
          }
          const root = findHarnessRoot(cwd);
          const entry = join(root, "dist", "index.js");
          const child = spawn(nodeExecutable(), [entry, "wallet", "browser", "--workspace", cwd], {
            detached: true,
            stdio: "ignore",
            windowsHide: false,
            cwd: root,
          });
          child.unref();
          return `${status}\n\nbrowser=starting\nwallet=metamask\nprofile=.harness/wallet/chrome-profile/\nFirst launch downloads MetaMask and imports the vault. Later launches unlock. Leave that Chromium open.`;
        },
      }),
      harness_wallet_e2e: tool({
        description:
          "Real MetaMask E2E: headed Chromium + extension (dappwright) against the live app. Connect, approve, Send, confirm. Pass amount= and to= when the human asked for a specific send — the tool defaults to 0.01 HBAR and ignores chat otherwise. Quote amount_filled from the result; never invent the requested amount. Playwright MCP vanilla Chrome is NOT this. Never prints keys. SMOKE must already have the app up.",
        args: {
          url: tool.schema.string().optional().describe("Live app URL, default http://127.0.0.1:3000"),
          amount: tool.schema.string().optional().describe("HBAR to send, e.g. 1. Default 0.01"),
          to: tool.schema.string().optional().describe("Destination 0x address. Default: first 0x on /payments"),
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const status = await walletStatusText(cwd);
          if (!isWalletReady(status) && !vaultFileLooksPresent(cwd)) {
            return `${await openWalletGate(cwd)}\nMetaMask E2E needs gate=ok. Do not ask for the key in chat.`;
          }
          const root = findHarnessRoot(cwd);
          const entry = join(root, "dist", "index.js");
          const url = String(args.url || "http://127.0.0.1:3000");
          const cliArgs = [entry, "wallet", "e2e", "--workspace", cwd, "--url", url];
          if (args.amount) cliArgs.push("--amount", String(args.amount));
          if (args.to) cliArgs.push("--to", String(args.to));
          const result = spawnSync(nodeExecutable(), cliArgs, {
              cwd: root,
              encoding: "utf8",
              timeout: 360_000,
              windowsHide: false,
            },
          );
          const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
          if (result.error) return redact(result.error.message);
          return redact(combined || "(no output)");
        },
      }),
      harness_wallet_session: tool({
        description:
          "Keep the MetaMask Chromium (dappwright profile) alive. action=start|stop|status. start always stops leftover launching/chrome-profile processes first (no-op if none), then launches — except a healthy session=up, which it reuses. BLOCKS until session=up or session=hung. Do NOT bash Start-Sleep/netstat. Do NOT cancel start mid-launch. If hung, call start once more or harness_wallet_e2e. After up: harness_wallet_dom + harness_wallet_mm. NOT Playwright MCP vanilla Chrome.",
        args: {
          action: tool.schema.string().optional().describe("start | stop | status (default start)"),
          url: tool.schema.string().optional().describe("Live app URL, default http://127.0.0.1:3000"),
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const status = await walletStatusText(cwd);
          const action = String(args.action || "start").trim().toLowerCase();
          if (action === "start" && !isWalletReady(status) && !vaultFileLooksPresent(cwd)) {
            return `${await openWalletGate(cwd)}\nWallet session needs gate=ok.`;
          }
          if (!["start", "stop", "status"].includes(action)) {
            return `Unknown action ${action}. Use start, stop, or status.`;
          }
          const session = await importDist(cwd, "walletSession.js");
          return redact(
            await session.runWalletSession(cwd, action, { url: args.url ? String(args.url) : undefined }),
          );
        },
      }),
      harness_wallet_dom: tool({
        description:
          "See and drive the dapp tab in the MetaMask Chromium session (aria snapshot + input values). action=snapshot|click|fill|goto|press. Snapshot first; quote input value= from that dump — never invent the amount the human asked for. click/fill with ref= (e12 from snapshot), testid=, name=, or text=. fill requires value=. goto needs url=. press key=Escape to dismiss RainbowKit. Playwright MCP vanilla Chrome is NOT this.",
        args: {
          action: tool.schema.string().describe("snapshot | click | fill | goto | press"),
          url: tool.schema.string().optional(),
          ref: tool.schema.string().optional().describe("aria-ref from the last snapshot, e.g. e12"),
          testid: tool.schema.string().optional(),
          role: tool.schema.string().optional(),
          name: tool.schema.string().optional(),
          text: tool.schema.string().optional(),
          value: tool.schema.string().optional().describe("Required for fill"),
          key: tool.schema.string().optional().describe("For press, e.g. Escape"),
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const action = String(args.action || "snapshot").trim().toLowerCase();
          if (!["snapshot", "click", "fill", "goto", "press"].includes(action)) {
            return `Unknown action ${action}. Use snapshot, click, fill, goto, or press.`;
          }
          const session = await importDist(cwd, "walletSession.js");
          return redact(
            await session.runWalletSession(cwd, action, {
              url: args.url ? String(args.url) : undefined,
              ref: args.ref ? String(args.ref) : undefined,
              testId: args.testid ? String(args.testid) : undefined,
              role: args.role ? String(args.role) : undefined,
              name: args.name ? String(args.name) : undefined,
              text: args.text ? String(args.text) : undefined,
              value: args.value ? String(args.value) : undefined,
              key: args.key ? String(args.key) : undefined,
            }),
          );
        },
      }),
      harness_wallet_mm: tool({
        description:
          "Approve Connect or confirm Send in the MetaMask extension of the live wallet session. action=approve (connect) or confirm (sign). Do not use Playwright MCP for this. Never prints keys.",
        args: {
          action: tool.schema.string().optional().describe("approve | confirm (default approve)"),
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const mm = String(args.action || "approve").trim().toLowerCase();
          if (!["approve", "confirm"].includes(mm)) {
            return `Unknown action ${mm}. Use approve or confirm.`;
          }
          const session = await importDist(cwd, "walletSession.js");
          return redact(await session.runWalletSession(cwd, "mm", { mmAction: mm }));
        },
      }),
      harness_tasks_status: tool({
        description:
          "Read .harness/tasks.md work units (T1, T2…) and contract scope. contracts=none|solidity, contract_base=none|token|nft|escrow|payroll|vesting|governor|hts|custom, hardhat=skip|run, oz_mcp=skip|ready|disabled|missing. Default none (payments/HCS) — skip Hardhat. When contracts=solidity and base is not hts, this enables OpenZeppelin MCP in project opencode.json (it ships disabled so unused sessions do not pay tool-schema tokens). New session needed for OZ tools; GENERATE may use @openzeppelin/contracts this session. EVALUATE uses MetaMask on the contract UI. If file is missing, spawn one hedera-generate for the whole PRD.",
        args: {
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const { inspectTasks, formatTasksStatus } = await importDist(cwd, "harnessTasks.js");
          const oz = await importDist(cwd, "ozMcp.js");
          const before = inspectTasks(cwd);
          const ensured = oz.ensureOzMcpForContracts(cwd, before.contracts, before.contractBase);
          const printed = formatTasksStatus(inspectTasks(cwd));
          if (ensured.skipped || !ensured.justEnabled) return printed;
          return `${printed}\noz_enabled=true\nrestart=${ensured.status.restartHint}`;
        },
      }),
      harness_task_done: tool({
        description: "Mark a work unit done in .harness/tasks.md (e.g. T1). Never prints secrets.",
        args: {
          id: tool.schema.string().describe("Task id such as T1"),
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const { markTaskDone, formatTasksStatus } = await importDist(cwd, "harnessTasks.js");
          try {
            return formatTasksStatus(markTaskDone(cwd, args.id));
          } catch (error) {
            return redact(error instanceof Error ? error.message : String(error));
          }
        },
      }),
      harness_tokens: tool({
        description:
          "Existing HTS token facades. action=lookup (default)|convert|remember. lookup: built-in + .harness/tokens.json, or token=lookup. convert: hts_id=0.0.x → HIP-218 evm=. remember: save to .harness/tokens.json after SearchHedera/webfetch. GENERATE bakes evm=. Never invent. Never ask the human unless MCP and webfetch both failed. symbol=USDC, network=testnet|mainnet.",
        args: {
          action: tool.schema.string().optional().describe("lookup (default), convert, or remember"),
          symbol: tool.schema.string().optional().describe("USDC, USDT, …"),
          network: tool.schema.string().optional().describe("testnet (default) or mainnet"),
          hts_id: tool.schema.string().optional().describe("0.0.x for convert/remember"),
          evm: tool.schema.string().optional().describe("optional 0x if issuer published EVM only"),
          decimals: tool.schema.string().optional().describe("token decimals, default 6"),
          source: tool.schema.string().optional(),
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const tokens = await importDist(cwd, "tokenRegistry.js");
          const network = String(args.network || "testnet").trim().toLowerCase();
          if (network !== "testnet" && network !== "mainnet") {
            return `Unknown network ${network}. Use testnet or mainnet.`;
          }
          const action = String(args.action || "lookup").trim().toLowerCase();
          if (action === "convert") {
            const htsId = String(args.hts_id || "").trim();
            if (!htsId) return "action=convert\ntoken=fail\nnote=hts_id=0.0.x is required.";
            return tokens.formatConvertHtsId(htsId, network);
          }
          if (action === "remember") {
            return tokens.formatRememberWorkspaceToken(cwd, {
              symbol: String(args.symbol || "").trim(),
              network,
              htsId: args.hts_id,
              evm: args.evm,
              decimals: args.decimals != null && args.decimals !== "" ? Number(args.decimals) : undefined,
              source: args.source,
            });
          }
          if (action !== "lookup") {
            return `Unknown action ${action}. Use lookup, convert, or remember.`;
          }
          return tokens.formatTokenLookup(args.symbol || "USDC", network, cwd);
        },
      }),
      harness_e2e_contract: tool({
        description:
          "The UI contract the wallet E2E drives. action=status (default)|set. GENERATE must call set after shipping a write form: route + the data-testid of destination/amount/submit/tx-hash + confirmations (2 when it is approve-then-execute). harness_wallet_e2e and EVALUATE read this instead of guessing selectors, which is what makes E2E work on any app. Missing contract falls back to the seed /payments form and will fail on a custom dApp.",
        args: {
          action: tool.schema.string().optional().describe("status (default) or set"),
          route: tool.schema.string().optional().describe('route with the form, e.g. "/" or "/payments"'),
          to_testid: tool.schema.string().optional().describe("data-testid of the destination input"),
          amount_testid: tool.schema.string().optional().describe("data-testid of the amount input"),
          submit_testid: tool.schema.string().optional().describe("data-testid of the button that opens MetaMask"),
          tx_hash_testid: tool.schema.string().optional().describe("data-testid that renders the tx hash"),
          submit_label: tool.schema.string().optional().describe("regex for the button name, e.g. send usdc|send"),
          confirmations: tool.schema.string().optional().describe("MetaMask popups to confirm, 1 or 2"),
          default_amount: tool.schema.string().optional().describe("amount the runner types by default"),
          notes: tool.schema.string().optional(),
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const e2e = await importDist(cwd, "e2eContract.js");
          const action = String(args.action || "status").trim().toLowerCase();
          if (action === "status") return e2e.formatE2eContract(e2e.inspectE2eContract(cwd));
          if (action !== "set") return `Unknown action ${action}. Use status or set.`;
          const confirmations =
            args.confirmations != null && args.confirmations !== "" ? Number(args.confirmations) : undefined;
          return e2e.formatE2eContract(
            e2e.writeE2eContract(cwd, {
              route: args.route,
              toTestId: args.to_testid,
              amountTestId: args.amount_testid,
              submitTestId: args.submit_testid,
              txHashTestId: args.tx_hash_testid,
              submitLabel: args.submit_label,
              confirmations: Number.isFinite(confirmations) ? confirmations : undefined,
              defaultAmount: args.default_amount,
              notes: args.notes,
            }),
          );
        },
      }),
      harness_oz_mcp: tool({
        description:
          "OpenZeppelin Solidity MCP. Overlay ships it disabled so payments/HCS sessions do not inject those tool schemas. action=status|enable. enable flips project opencode.json only — never ~/.config/opencode. After enable, a new OpenCode session is required for solidity-erc20 / solidity-custom / … to appear. GENERATE still proceeds with @openzeppelin/contracts if tools are missing this session. HTS uses SearchHedera, not this MCP.",
        args: {
          action: tool.schema.string().optional().describe("status (default) or enable"),
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const action = (args.action || "status").trim().toLowerCase();
          if (!["status", "enable"].includes(action)) {
            return `Unknown action ${action}. Use status or enable.`;
          }
          const oz = await importDist(cwd, "ozMcp.js");
          if (action === "enable") {
            return oz.formatOzMcpStatus(oz.enableOzMcp(cwd));
          }
          return oz.formatOzMcpStatus(oz.inspectOzMcp(cwd));
        },
      }),
      harness_playwright_mcp: tool({
        description:
          "Playwright MCP E2E gate. action=status|enable|install. status: ready (use MCP), disabled (enable it), missing (ask the human to install or skip). enable flips an existing disabled entry. install writes project opencode.json only — never ~/.config/opencode unless the entry already lives there. After install/enable, a new OpenCode session is required for tools to appear.",
        args: {
          action: tool.schema.string().optional().describe("status (default), enable, or install"),
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const action = (args.action || "status").trim().toLowerCase();
          if (!["status", "enable", "install"].includes(action)) {
            return `Unknown action ${action}. Use status, enable, or install.`;
          }
          const mcp = await importDist(cwd, "playwrightMcp.js");
          if (action === "enable") {
            return mcp.formatPlaywrightMcpStatus(mcp.enablePlaywrightMcp(cwd));
          }
          if (action === "install") {
            const before = mcp.inspectPlaywrightMcp(cwd);
            const after = mcp.installPlaywrightMcp(cwd);
            const note =
              before.kind === "disabled"
                ? "\nnote=Enabled the existing Playwright MCP entry instead of installing a second copy."
                : before.kind === "ready"
                  ? "\nnote=Playwright MCP was already ready."
                  : "\nnote=Wrote project opencode.json. New OpenCode session required.";
            return `${mcp.formatPlaywrightMcpStatus(after)}${note}`;
          }
          return mcp.formatPlaywrightMcpStatus(mcp.inspectPlaywrightMcp(cwd));
        },
      }),
      harness_dev_serve: tool({
        description:
          "Tracked yarn next:dev for SMOKE/E2E/local. start reuses a healthy server or kills leftover nohup/orphan next:dev for this app then starts one. stop before yarn next:build. NEVER nohup yarn next:dev. Never prints keys.",
        args: {
          action: tool.schema.string().optional().describe("start | stop | status (default start)"),
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const action = String(args.action || "start").trim().toLowerCase();
          if (!["start", "stop", "status"].includes(action)) {
            return `Unknown action ${action}. Use start, stop, or status.`;
          }
          const serve = await importDist(cwd, "devServe.js");
          return serve.formatDevServeReport(await serve.runDevServe(cwd, action));
        },
      }),
      harness_latest_run: tool({
        description: "Read the newest .harness/runs/*/status.json without secrets.",
        args: {
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return latestStatus(toolWorkspace(args, context));
        },
      }),
      harness_prd_status: tool({
        description:
          "Classify the workspace PRD: missing, skeleton (init 'edit me' template), or real. Call before GENERATE. Skeleton is not a PRD — interview the human.",
        args: {
          workspace: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const { inspectWorkspacePrd } = await importDist(cwd, "prdStatus.js");
          return JSON.stringify(inspectWorkspacePrd(cwd), null, 2);
        },
      }),
      harness_ensure_init: tool({
        description:
          "Hard gate: ensure .harness/spec.yaml exists. Yarn is NOT installed here — tui install already ran yarn in a terminal. If yarn=missing, tell the human to run `hedera-harness tui install` (or yarn install) outside OpenCode. Never bash yarn install.",
        args: {
          workspace: tool.schema.string().optional(),
          skipInstall: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          const cwd = toolWorkspace(args, context);
          const spec = join(cwd, ".harness", "spec.yaml");
          const parts = [];
          if (!existsSync(spec)) {
            parts.push(runHarness(cwd, ["init", cwd, "--skip-install"], INIT_TIMEOUT_MS));
          } else {
            parts.push(`Already initialized: ${spec}`);
          }
          if (args.skipInstall !== true) {
            const yarn = await importDist(cwd, "yarnInstall.js");
            parts.push(yarn.formatYarnInstallReport(await yarn.ensureYarnInstall(cwd)));
          }
          return parts.join("\n\n");
        },
      }),
    };
  } catch {
    // OpenCode still loads key-protection hooks if the plugin SDK is unavailable.
  }
  return hooks;
};
