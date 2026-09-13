/**
 * The E2E contract: what GENERATE promises the wallet runner about this app.
 *
 * `harness_wallet_e2e` used to hardcode `/payments` + `pay-amount`, so a dApp
 * whose send form lives anywhere else was un-drivable. GENERATE now stamps
 * `.harness/e2e.json` (route + data-testid + how many MetaMask confirms), and
 * both the scripted runner and EVALUATE read that instead of guessing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const E2E_CONTRACT_REL = [".harness", "e2e.json"] as const;

export interface E2eContract {
  /** Route that holds the write form, e.g. "/" or "/payments". */
  route: string;
  /** data-testid of the destination / recipient input. */
  toTestId: string;
  /** data-testid of the amount input. */
  amountTestId: string;
  /** data-testid of the button that opens MetaMask. */
  submitTestId: string;
  /** data-testid of the element that renders the resulting tx hash. */
  txHashTestId: string;
  /** Regex source for the submit button's accessible name (fallback click). */
  submitLabel: string;
  /** MetaMask popups to confirm (2 when the flow is approve then execute). */
  confirmations: number;
  /** Amount the scripted runner types when the caller passes none. */
  defaultAmount: string;
  notes?: string;
}

export type E2eContractKind = "ready" | "missing" | "invalid";

export interface E2eContractStatus {
  kind: E2eContractKind;
  file: string;
  contract: E2eContract;
  problems: string[];
}

/**
 * scaffold-hbar's seed `/payments` page. Only a fallback for apps generated
 * before the contract existed — a new unit must write its own.
 */
export const LEGACY_PAYMENTS_CONTRACT: E2eContract = {
  route: "/payments",
  toTestId: "pay-to",
  amountTestId: "pay-amount",
  submitTestId: "pay-send",
  txHashTestId: "pay-tx-hash",
  submitLabel: "send hbar|send",
  confirmations: 1,
  defaultAmount: "0.01",
  notes: "Legacy scaffold payments form (no .harness/e2e.json in this app).",
};

/**
 * Resolve a contract field by `data-testid`, then `id`, then `name`.
 *
 * Plenty of real forms only carry `id` (the label's `htmlFor`), and refusing to
 * drive those is what made E2E look app-specific. Playwright's `getByTestId`
 * only sees `data-testid`, so the runner uses this CSS selector instead.
 */
export function fieldSelector(testId: string): string {
  const value = testId.trim();
  if (!value) return "input";
  const escaped = value.replace(/["\\]/g, "\\$&");
  const idSelector = /^[A-Za-z][\w-]*$/.test(value) ? `, #${value}` : "";
  return `[data-testid="${escaped}"]${idSelector}, [name="${escaped}"]`;
}

export function e2eContractPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), ...E2E_CONTRACT_REL);
}

export function inspectE2eContract(workspaceDir: string): E2eContractStatus {
  const file = e2eContractPath(workspaceDir);
  if (!existsSync(file)) {
    return {
      kind: "missing",
      file,
      contract: LEGACY_PAYMENTS_CONTRACT,
      problems: ["No .harness/e2e.json — falling back to the seed /payments form."],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      kind: "invalid",
      file,
      contract: LEGACY_PAYMENTS_CONTRACT,
      problems: [`Unreadable JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const { contract, problems } = normalizeContract(raw);
  return {
    kind: problems.length === 0 ? "ready" : "invalid",
    file,
    contract,
    problems,
  };
}

export function writeE2eContract(
  workspaceDir: string,
  input: Partial<E2eContract> & { route?: string },
): E2eContractStatus {
  const { contract, problems } = normalizeContract(input);
  if (problems.length > 0) {
    return { kind: "invalid", file: e2eContractPath(workspaceDir), contract, problems };
  }
  const file = e2eContractPath(workspaceDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  return { kind: "ready", file, contract, problems: [] };
}

export function formatE2eContract(status: E2eContractStatus): string {
  const c = status.contract;
  return [
    `e2e_contract=${status.kind}`,
    `file=${status.file}`,
    `route=${c.route}`,
    `to_testid=${c.toTestId}`,
    `amount_testid=${c.amountTestId}`,
    `submit_testid=${c.submitTestId}`,
    `tx_hash_testid=${c.txHashTestId}`,
    `submit_label=${c.submitLabel}`,
    `confirmations=${c.confirmations}`,
    `default_amount=${c.defaultAmount}`,
    c.notes ? `notes=${c.notes}` : undefined,
    ...status.problems.map(problem => `problem=${problem}`),
    status.kind === "ready"
      ? "note=EVALUATE drives these testids in the MetaMask Chromium. Keep them stable."
      : "note=GENERATE must call harness_e2e_contract action=set with route + testids of the form it shipped.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function normalizeContract(raw: unknown): { contract: E2eContract; problems: string[] } {
  const problems: string[] = [];
  const rec = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const read = (...keys: string[]): string => {
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };

  const route = read("route", "path") || "/";
  const toTestId = read("toTestId", "to_testid", "to");
  const amountTestId = read("amountTestId", "amount_testid", "amount");
  const submitTestId = read("submitTestId", "submit_testid", "submit");
  const txHashTestId = read("txHashTestId", "tx_hash_testid", "txHash") || `${submitTestId || "tx"}-hash`;
  const submitLabel = read("submitLabel", "submit_label", "label") || "send";
  const rawConfirmations = rec.confirmations ?? rec.confirms;
  const confirmations =
    typeof rawConfirmations === "number" && rawConfirmations >= 1 && rawConfirmations <= 3
      ? Math.trunc(rawConfirmations)
      : 1;
  const defaultAmount = read("defaultAmount", "default_amount") || "0.01";
  const notes = read("notes", "note");

  if (!route.startsWith("/")) problems.push(`route must start with "/" (got ${route}).`);
  if (!toTestId) problems.push("toTestId is required (data-testid of the destination input).");
  if (!amountTestId) problems.push("amountTestId is required (data-testid of the amount input).");
  if (!submitTestId) problems.push("submitTestId is required (data-testid of the button that signs).");

  return {
    contract: {
      route,
      toTestId,
      amountTestId,
      submitTestId,
      txHashTestId,
      submitLabel,
      confirmations,
      defaultAmount,
      ...(notes ? { notes } : {}),
    },
    problems,
  };
}
