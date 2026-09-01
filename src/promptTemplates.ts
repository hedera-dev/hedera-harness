import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "./fsUtils.js";

/**
 * Prompt text lives in `prompts/*.md`. Syntax is a mustache subset (variables
 * and boolean sections). Loops / data conditionals are rendered in TypeScript
 * and passed in, so prompt logic stays next to the code that produces the data.
 */
export type TemplateVars = Record<string, string | boolean | undefined>;

export const PROMPT_TEMPLATE_NAMES = [
  "generator",
  "generator-continue",
  "repair-preamble",
  "repair-eval",
  "repair-runtime",
  "repair-broad",
  "validator",
] as const;

export type PromptTemplateName = (typeof PROMPT_TEMPLATE_NAMES)[number];

export const PROJECT_PROMPTS_DIR = ".harness/prompts";

export function bundledPromptsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");
}

export function projectPromptPath(projectRoot: string, name: PromptTemplateName): string {
  return path.join(projectRoot, ...PROJECT_PROMPTS_DIR.split("/"), `${name}.md`);
}

/** Prefer a project override (whole-file; other bundled prompts stay current). */
export async function resolvePromptTemplatePath(
  projectRoot: string,
  name: PromptTemplateName,
): Promise<{ path: string; overridden: boolean }> {
  const override = projectPromptPath(projectRoot, name);
  if (await pathExists(override)) {
    return { path: override, overridden: true };
  }
  return { path: path.join(bundledPromptsDir(), `${name}.md`), overridden: false };
}

export async function renderPrompt(
  projectRoot: string,
  name: PromptTemplateName,
  vars: TemplateVars,
): Promise<string> {
  const resolved = await resolvePromptTemplatePath(projectRoot, name);
  let template: string;
  try {
    template = await readFile(resolved.path, "utf8");
  } catch (error) {
    throw new Error(
      [
        `Could not read prompt template ${JSON.stringify(name)} at ${resolved.path}.`,
        resolved.overridden
          ? `Remove the override under ${PROJECT_PROMPTS_DIR}/ to fall back to the bundled prompt.`
          : "The harness package looks incomplete — reinstall it.",
        error instanceof Error ? error.message : String(error),
      ].join(" "),
    );
  }
  return renderTemplate(template, vars);
}

const SECTION_ONLY_LINE = /^[ \t]*(\{\{[#^/][A-Za-z0-9_]+\}\})[ \t]*\r?\n/gm;
/** Innermost section first, so nesting resolves by repeated application. */
const INNERMOST_SECTION = /\{\{([#^])([A-Za-z0-9_]+)\}\}((?:(?!\{\{[#^/])[\s\S])*?)\{\{\/\2\}\}/;
const VARIABLE = /\{\{([A-Za-z0-9_]+)\}\}/g;

export function renderTemplate(template: string, vars: TemplateVars): string {
  // A section tag alone on a line should not leave a blank line behind.
  let output = template.replace(SECTION_ONLY_LINE, "$1");

  for (let guard = 0; guard < 100; guard += 1) {
    const match = INNERMOST_SECTION.exec(output);
    if (!match) break;
    const [whole, kind, name, body] = match;
    const truthy = isTruthy(vars[name]);
    const keep = kind === "#" ? truthy : !truthy;
    output = output.replace(whole, keep ? body : "");
  }

  output = output.replace(VARIABLE, (_whole, name: string) => {
    const value = vars[name];
    if (value === undefined || value === false) return "";
    if (value === true) return "";
    return value;
  });

  return tidy(output);
}

function isTruthy(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  return typeof value === "string" && value.trim().length > 0;
}

function tidy(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
