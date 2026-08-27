import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "./fsUtils.js";

/**
 * Prompt text lives in `prompts/*.md`, not in TypeScript.
 *
 * Prompt wording is the main quality lever in a harness, and it is the thing
 * most often changed. Behind a compile step it is effectively the maintainers'
 * to tune; as files it is anyone's — and a project can override a single prompt
 * without forking the harness.
 *
 * The template syntax is a deliberate mustache subset: variables and boolean
 * sections. Anything needing a loop or a conditional over data is rendered to a
 * string in TypeScript and passed in, which keeps this file small and keeps
 * prompt logic reviewable next to the code that produces the data.
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

/** Where a project may drop its own copy of a prompt. */
export const PROJECT_PROMPTS_DIR = ".harness/prompts";

/** Templates shipped with the package. */
export function bundledPromptsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");
}

export function projectPromptPath(projectRoot: string, name: PromptTemplateName): string {
  return path.join(projectRoot, ...PROJECT_PROMPTS_DIR.split("/"), `${name}.md`);
}

/**
 * Resolve a prompt, preferring a project override.
 *
 * Overrides are whole-file: a project that customises `repair-broad` keeps the
 * bundled versions of everything else, so an override does not silently freeze
 * the rest of the prompt set at the version it was copied from.
 */
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

/**
 * Collapse the blank runs that dropped sections leave behind, so a prompt does
 * not gain three blank lines because a tier is disabled.
 */
function tidy(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
