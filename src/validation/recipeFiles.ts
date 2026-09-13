import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

/** The recipe files a stage reads, keyed the way the recipe refers to them. */
export type RecipeFileKind = "static" | "commands" | "playwright" | "eval";

export type LoadedRecipeFile<T> =
  | { config: T; problem?: undefined }
  | { config?: undefined; problem: string };

/**
 * Read and shape-check a recipe file exactly the way its stage consumes it.
 *
 * One definition serves preflight (doctor and run, before anything is spent)
 * and the stages themselves (a file the generator edited mid-run), so the two
 * cannot drift. `problem` is one line naming what is wrong. Nothing stricter
 * than the readers need: an array root is tolerated because every property
 * read on it is undefined, which the stages treat as an empty config.
 */
export async function loadRecipeFile<T>(
  kind: RecipeFileKind,
  filePath: string,
): Promise<LoadedRecipeFile<T>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return { problem: `cannot read: ${describe(error)}` };
  }

  const format = kind === "playwright" ? "YAML" : "JSON";
  let parsed: unknown;
  try {
    parsed = kind === "playwright" ? parseYaml(raw) : JSON.parse(raw);
  } catch (error) {
    return { problem: `${format}: ${describe(error)}` };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { problem: `expected a ${format} object` };
  }

  const problem = describeShape(kind, parsed as Record<string, unknown>);
  return problem ? { problem } : { config: parsed as T };
}

type Entry = Record<string, unknown>;

function describeShape(kind: RecipeFileKind, record: Entry): string | undefined {
  switch (kind) {
    case "static":
      return (
        entries(record, "jsonAssertions", entry => missing(entry, ["file", "path"])) ??
        entries(
          record,
          "textAssertions",
          (entry, label) => missing(entry, ["file"]) ?? stringList(entry, "contains", label, true),
        ) ??
        object(record, "fileAssertions", files =>
          stringList(files, "required", "fileAssertions") ?? stringList(files, "forbidden", "fileAssertions"),
        ) ??
        object(record, "secretScan", scan =>
          stringList(scan, "failOnFiles", "secretScan") ??
          entries(
            scan,
            "patterns",
            (entry, label) => missing(entry, ["name", "pattern"]) ?? stringList(entry, "allowIn", label),
          ),
        )
      );
    case "commands":
      return entries(record, "commands", entry => missing(entry, ["name", "command"]));
    case "playwright": {
      const server = record.server;
      if (!server || typeof server !== "object" || Array.isArray(server)) return "server must be an object";
      const serverProblem = missing(server as Entry, ["command", "url"]);
      if (serverProblem) return `server ${serverProblem}`;
      return (
        entries(record, "routes", entry => missing(entry, ["name", "path"]), true) ??
        object(record, "forbidden", forbidden => stringList(forbidden, "visibleText", "forbidden"))
      );
    }
    case "eval":
      return entries(record, "assertions", entry => missing(entry, ["id"]));
  }
}

type EntryCheck = (entry: Entry, label: string) => string | undefined;

/** `parent[key]`, when present, must be an array of objects each passing `check`. */
function entries(parent: Entry, key: string, check: EntryCheck, required = false): string | undefined {
  const list = parent[key];
  if (list === undefined || (Array.isArray(list) && list.length === 0)) {
    return required ? `${key} must list at least one entry` : undefined;
  }
  if (!Array.isArray(list)) return `${key} must be an array`;
  for (const [index, entry] of list.entries()) {
    const label = `${key}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `${label} must be an object`;
    const problem = check(entry as Entry, label);
    if (problem) return problem.startsWith(label) ? problem : `${label} ${problem}`;
  }
  return undefined;
}

/** `parent[key]`, when present, must be an object passing `check`. */
function object(parent: Entry, key: string, check: (value: Entry) => string | undefined): string | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${key} must be an object`;
  return check(value as Entry);
}

/** The named keys must be non-empty strings; reports the first ones that are not. */
function missing(entry: Entry, keys: string[]): string | undefined {
  const absent = keys.filter(key => typeof entry[key] !== "string" || !(entry[key] as string).trim());
  return absent.length > 0 ? `is missing ${absent.join(", ")}` : undefined;
}

/** `parent[key]`, when present (or always, when required), must be an array of strings. */
function stringList(parent: Entry, key: string, prefix: string, required = false): string | undefined {
  const value = parent[key];
  const label = `${prefix}.${key}`;
  if (value === undefined) return required ? `${label} must be an array of strings` : undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    return `${label} must be an array of strings`;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
