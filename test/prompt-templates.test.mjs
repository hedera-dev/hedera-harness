import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const {
  renderTemplate,
  renderPrompt,
  resolvePromptTemplatePath,
  bundledPromptsDir,
  PROMPT_TEMPLATE_NAMES,
} = await import(pathToFileURL(path.resolve("dist/promptTemplates.js")).href);
const prompts = await import(pathToFileURL(path.resolve("dist/promptBuilder.js")).href);

test("every declared template ships with the package", async () => {
  const shipped = new Set(await readdir(bundledPromptsDir()));
  for (const name of PROMPT_TEMPLATE_NAMES) {
    assert.ok(shipped.has(`${name}.md`), `prompts/${name}.md should exist`);
  }
});

test("renderTemplate substitutes variables", () => {
  assert.equal(renderTemplate("Attempt: {{n}} at {{url}}", { n: "3", url: "x" }), "Attempt: 3 at x");
});

test("renderTemplate drops unknown and empty variables", () => {
  assert.equal(renderTemplate("a{{missing}}b", {}), "ab");
  assert.equal(renderTemplate("a{{blank}}b", { blank: "" }), "ab");
});

test("sections render only when the flag is set", () => {
  const template = "start\n{{#on}}\nincluded\n{{/on}}\nend";
  assert.match(renderTemplate(template, { on: true }), /start\nincluded\nend/);
  assert.equal(renderTemplate(template, { on: false }), "start\nend");
});

test("inverted sections render only when the flag is unset", () => {
  const template = "{{^off}}\nfallback\n{{/off}}";
  assert.equal(renderTemplate(template, { off: false }), "fallback");
  assert.equal(renderTemplate(template, { off: true }), "");
});

test("a non-empty string counts as truthy for a section", () => {
  assert.equal(renderTemplate("{{#s}}yes{{/s}}", { s: "value" }), "yes");
  assert.equal(renderTemplate("{{#s}}yes{{/s}}", { s: "   " }), "");
});

test("nested sections resolve", () => {
  const template = "{{#outer}}O{{#inner}}I{{/inner}}{{/outer}}";
  assert.equal(renderTemplate(template, { outer: true, inner: true }), "OI");
  assert.equal(renderTemplate(template, { outer: true, inner: false }), "O");
  assert.equal(renderTemplate(template, { outer: false, inner: true }), "");
});

test("a dropped section does not leave a run of blank lines", () => {
  const template = "one\n\n{{#off}}\ndropped\n{{/off}}\n\ntwo";
  const rendered = renderTemplate(template, { off: false });
  assert.doesNotMatch(rendered, /\n{3,}/, "should not contain three consecutive newlines");
  assert.equal(rendered, "one\n\ntwo");
});

test("a project override wins over the bundled prompt", async () => {
  const root = await makeTestTempDir("prompt-override-");
  await mkdir(path.join(root, ".harness", "prompts"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prompts", "repair-broad.md"), "CUSTOM {{attempt}}");

  const resolved = await resolvePromptTemplatePath(root, "repair-broad");
  assert.equal(resolved.overridden, true);
  assert.equal(await renderPrompt(root, "repair-broad", { attempt: "7" }), "CUSTOM 7");

  // Overriding one prompt must not detach the others from the package.
  const other = await resolvePromptTemplatePath(root, "generator");
  assert.equal(other.overridden, false);
});

test("a missing override falls back to the bundled prompt", async () => {
  const root = await makeTestTempDir("prompt-fallback-");
  const resolved = await resolvePromptTemplatePath(root, "generator");
  assert.equal(resolved.overridden, false);
  assert.match(resolved.path, /prompts[/\\]generator\.md$/);
});

test("an unreadable override explains how to recover", async () => {
  const root = await makeTestTempDir("prompt-broken-");
  // A directory where a file is expected: readable path, unreadable content.
  await mkdir(path.join(root, ".harness", "prompts", "generator.md"), { recursive: true });

  await assert.rejects(
    () => renderPrompt(root, "generator", {}),
    /Remove the override under \.harness\/prompts/,
  );
});

test("the generator prompt renders with the PRD and honours the skills section", async () => {
  const root = await makeTestTempDir("prompt-generator-");
  const prdPath = path.join(root, "prd.md");
  await writeFile(prdPath, "Add a tip jar panel.\n");

  const spec = {
    name: "demo",
    projectRoot: root,
    prdPaths: [prdPath],
    requiredFiles: ["packages/nextjs/app/page.tsx"],
    forbiddenFiles: [],
    validators: {},
    generator: { provider: "command", command: "agent" },
    maxAttempts: 1,
    logging: { jsonlPath: "x", notesPath: "y" },
    constraints: { forbiddenCommands: ["npm install"] },
  };

  const withoutSkills = await prompts.buildSessionPrompt(spec, 1, []);
  assert.match(withoutSkills, /Add a tip jar panel/);
  assert.match(withoutSkills, /scaffold-hbar and Hedera best practices/);
  assert.match(withoutSkills, /Forbidden commands: npm install/);
  assert.match(withoutSkills, /packages\/nextjs\/app\/page\.tsx/);

  const withSkills = await prompts.buildSessionPrompt(spec, 1, [
    { name: "quality-gates", relativePath: ".harness/runtime/skills/quality-gates/SKILL.md", description: "Gate rules." },
  ]);
  assert.match(withSkills, /quality-gates/);
  assert.doesNotMatch(withSkills, /scaffold-hbar and Hedera best practices/);
});

test("repair scope selects the matching template", async () => {
  const root = await makeTestTempDir("prompt-repair-");
  const spec = {
    name: "demo",
    projectRoot: root,
    prdPaths: [path.join(root, "prd.md")],
    requiredFiles: [],
    forbiddenFiles: [],
    validators: {},
    generator: { provider: "command", command: "agent" },
    maxAttempts: 1,
    logging: { jsonlPath: "x", notesPath: "y" },
  };

  const semantic = await prompts.buildRepairPrompt(
    spec,
    [{ id: "eval:E1", category: "eval", message: "E1 failed" }],
    2,
  );
  assert.match(semantic, /Repair scope: \*\*eval-scoped\*\*/);

  const runtime = await prompts.buildRepairPrompt(
    spec,
    [{ id: "command:build", category: "commands", message: "build failed" }],
    2,
  );
  assert.match(runtime, /Repair scope: \*\*runtime\*\*/);

  const broad = await prompts.buildRepairPrompt(
    spec,
    [{ id: "required-file:x", category: "files", message: "missing" }],
    2,
  );
  assert.match(broad, /Repair scope: \*\*broad\*\*/);
});

test("the validator prompt includes signer material only when a signer exists", async () => {
  const root = await makeTestTempDir("prompt-validator-");
  const spec = {
    name: "demo",
    projectRoot: root,
    prdPaths: [],
    requiredFiles: [],
    forbiddenFiles: [],
    validators: {},
    generator: { provider: "command", command: "agent" },
    maxAttempts: 1,
    logging: { jsonlPath: "x", notesPath: "y" },
  };

  const without = await prompts.buildValidatorPrompt(spec, "{}", "http://localhost:3000");
  assert.doesNotMatch(without, /Test Signer/);
  assert.match(without, /do NOT complete on-chain transactions/);

  const withSigner = await prompts.buildValidatorPrompt(spec, "{}", "http://localhost:3000", {
    accountId: "0.0.1234",
    privateKeyHex: "0xdeadbeef",
    evmAddress: "0xabc",
    network: "testnet",
  });
  assert.match(withSigner, /Test Signer/);
  assert.match(withSigner, /0\.0\.1234/);
  assert.match(withSigner, /mirrornode\.hedera\.com/);
});
