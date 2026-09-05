import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { buildSlitherFindings, validateContractSecurity, ContractSecurityInfraError } = await import(
  pathToFileURL(path.resolve("dist/validation/contractSecurity.js")).href
);
const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);

const WORKSPACE = "/tmp/example-workspace";

function slitherReport(detectors) {
  return JSON.stringify({ success: true, error: null, results: { detectors } });
}

function detector({ check, impact, file = "contracts/Vault.sol", line = 42 }) {
  return {
    check,
    impact,
    confidence: "High",
    description: `${check} at ${file}:${line}`,
    elements: [{ type: "function", source_mapping: { filename_relative: file, lines: [line] } }],
  };
}

test("maps a High detector to a single security finding with a stable id", () => {
  const stdout = slitherReport([detector({ check: "reentrancy-eth", impact: "High" })]);
  const findings = buildSlitherFindings(stdout, { workspacePath: WORKSPACE, failOnSeverity: "high" });

  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.category, "security");
  assert.equal(finding.status, "open");
  assert.equal(finding.id, "security:slither:reentrancy-eth:contracts/Vault.sol:42");
  assert.match(finding.message, /\[HIGH\] reentrancy-eth in contracts\/Vault\.sol:42/);
});

test("failOnSeverity=high does not flag a Medium detector", () => {
  const stdout = slitherReport([detector({ check: "timestamp", impact: "Medium" })]);
  const findings = buildSlitherFindings(stdout, { workspacePath: WORKSPACE, failOnSeverity: "high" });
  assert.equal(findings.length, 0);
});

test("failOnSeverity=medium flags both Medium and High", () => {
  const stdout = slitherReport([
    detector({ check: "timestamp", impact: "Medium", line: 10 }),
    detector({ check: "reentrancy-eth", impact: "High", line: 20 }),
  ]);
  const findings = buildSlitherFindings(stdout, {
    workspacePath: WORKSPACE,
    failOnSeverity: "medium",
  });
  assert.equal(findings.length, 2);
});

test("ids are stable across identical scans (repair-loop delta relies on this)", () => {
  const stdout = slitherReport([detector({ check: "reentrancy-eth", impact: "High" })]);
  const first = buildSlitherFindings(stdout, { workspacePath: WORKSPACE, failOnSeverity: "high" });
  const second = buildSlitherFindings(stdout, { workspacePath: WORKSPACE, failOnSeverity: "high" });
  assert.deepEqual(
    first.map(f => f.id),
    second.map(f => f.id),
  );
});

test("tolerates progress noise before the JSON object", () => {
  const stdout = `Compiling...\nINFO:Detectors:\n${slitherReport([
    detector({ check: "arbitrary-send-eth", impact: "High" }),
  ])}\n`;
  const findings = buildSlitherFindings(stdout, { workspacePath: WORKSPACE, failOnSeverity: "high" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "security:slither:arbitrary-send-eth:contracts/Vault.sol:42");
});

test("unparseable stdout is an infra error, not a finding", () => {
  assert.throws(
    () => buildSlitherFindings("Traceback: solc not found", { workspacePath: WORKSPACE, failOnSeverity: "high" }),
    ContractSecurityInfraError,
  );
});

test("success:false with no detectors is an infra error", () => {
  const stdout = JSON.stringify({ success: false, error: "compilation failed", results: {} });
  assert.throws(
    () => buildSlitherFindings(stdout, { workspacePath: WORKSPACE, failOnSeverity: "high" }),
    ContractSecurityInfraError,
  );
});

test("validateContractSecurity is a no-op when disabled or absent", async () => {
  assert.deepEqual(await validateContractSecurity(WORKSPACE, undefined), { findings: [] });
  assert.deepEqual(
    await validateContractSecurity(WORKSPACE, { enabled: false, scanners: ["slither"], failOnSeverity: "high" }),
    { findings: [] },
  );
});

async function writeSecurityRecipe(contractSecurityYaml) {
  const root = await makeTestTempDir("contract-security-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# f\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  const spec = `name: sec\nbaseline:\n  commands:\n    - name: install\n      command: "true"\nvalidators:\n${contractSecurityYaml}`;
  const specPath = path.join(root, ".harness", "spec.yaml");
  await writeFile(specPath, spec);
  return specPath;
}

test("loader parses an enabled contractSecurity block with defaults", async () => {
  const specPath = await writeSecurityRecipe(
    `  contractSecurity:\n    enabled: true\n    contractsDir: packages/foundry\n`,
  );
  const { spec } = await loadTemplateSpec(specPath);
  const cfg = spec.validators.contractSecurity;
  assert.ok(cfg);
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.scanners, ["slither"]);
  assert.equal(cfg.failOnSeverity, "high");
  assert.ok(cfg.contractsDir.endsWith(path.join("packages", "foundry")));
});

test("loader treats enabled:false as no validator", async () => {
  const specPath = await writeSecurityRecipe(`  contractSecurity:\n    enabled: false\n`);
  const { spec } = await loadTemplateSpec(specPath);
  assert.equal(spec.validators.contractSecurity, undefined);
});

test("loader rejects an invalid failOnSeverity", async () => {
  const specPath = await writeSecurityRecipe(
    `  contractSecurity:\n    enabled: true\n    failOnSeverity: catastrophic\n`,
  );
  await assert.rejects(loadTemplateSpec(specPath), /failOnSeverity/);
});
