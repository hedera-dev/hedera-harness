/**
 * Optional peer dependencies used only by higher validation gates.
 * Gate 0–1 consumers should not need to install these (~hundreds of MB).
 */

export async function importPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch (error) {
    throw new Error(formatOptionalDepError("playwright", "Tier 2 Playwright gate", [
      "npm install -D playwright",
      "npx playwright install chromium",
    ], error));
  }
}

export async function importHieroSdk(): Promise<typeof import("@hiero-ledger/sdk")> {
  try {
    return await import("@hiero-ledger/sdk");
  } catch (error) {
    throw new Error(formatOptionalDepError("@hiero-ledger/sdk", "Tier 3.5 on-chain validation", [
      "npm install -D @hiero-ledger/sdk",
    ], error));
  }
}

function formatOptionalDepError(
  packageName: string,
  feature: string,
  installLines: string[],
  error: unknown,
): string {
  const underlying = error instanceof Error ? error.message : String(error);
  return [
    `${feature} requires the optional peer dependency "${packageName}".`,
    "Install it in the project that depends on hedera-harness:",
    ...installLines.map(line => `  ${line}`),
    `Underlying error: ${underlying}`,
  ].join("\n");
}
