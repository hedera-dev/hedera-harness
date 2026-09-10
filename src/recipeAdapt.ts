import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fsUtils.js";
import {
  resolvePackageInstallTool,
  type PackageInstallTool,
} from "./optionalDeps.js";
import { defaultForbiddenCommands } from "./specDefaults.js";

export interface AdaptedRecipeCommands {
  tool: PackageInstallTool;
  install: string;
  build: string;
  lint?: string;
}

export function scriptRunner(tool: PackageInstallTool, script: string): string {
  if (tool === "yarn") return `yarn ${script}`;
  if (tool === "pnpm") return `pnpm ${script}`;
  return `npm run ${script}`;
}

export function pickAdaptedRecipeCommands(
  tool: PackageInstallTool,
  scripts: Record<string, unknown>,
): AdaptedRecipeCommands {
  const names = Object.fromEntries(
    Object.entries(scripts).filter(([, value]) => typeof value === "string"),
  ) as Record<string, string>;

  const install =
    tool === "yarn" ? "yarn install" : tool === "pnpm" ? "pnpm install" : "npm install";

  let build: string;
  if (names["next:build"]) {
    build = scriptRunner(tool, "next:build");
  } else if (names.build) {
    build = scriptRunner(tool, "build");
  } else if (names.typecheck) {
    build = scriptRunner(tool, "typecheck");
  } else if (names.test) {
    build = scriptRunner(tool, "test");
  } else if (tool === "yarn") {
    build = "yarn next:build";
  } else {
    build = scriptRunner(tool, "build");
  }

  return {
    tool,
    install,
    build,
    ...(names.lint ? { lint: scriptRunner(tool, "lint") } : {}),
  };
}

export function harnessRunNextStep(
  tool: PackageInstallTool,
  packageJsonUpdated: boolean,
): string {
  if (!packageJsonUpdated) return "hedera-harness run";
  if (tool === "yarn") return "yarn harness:run";
  if (tool === "pnpm") return "pnpm harness:run";
  return "npm run harness:run";
}

export async function adaptProvisionedRecipe(targetDir: string): Promise<AdaptedRecipeCommands> {
  const tool = await resolvePackageInstallTool({ projectRoot: targetDir });
  const scripts = await readPackageScripts(targetDir);
  const adapted = pickAdaptedRecipeCommands(tool, scripts);

  const specPath = path.join(targetDir, ".harness", "spec.yaml");
  if (await pathExists(specPath)) {
    const spec = await readFile(specPath, "utf8");
    await writeFile(specPath, rewriteSkeletonBaseline(spec, adapted), "utf8");
  }

  const commandsPath = path.join(targetDir, ".harness", "validators", "yarn.json");
  if (await pathExists(commandsPath)) {
    await writeFile(
      commandsPath,
      `${JSON.stringify(buildCommandValidator(adapted), null, 2)}\n`,
      "utf8",
    );
  }

  const prdPath = path.join(targetDir, ".harness", "prd.md");
  if (adapted.tool !== "yarn" && (await pathExists(prdPath))) {
    const prd = await readFile(prdPath, "utf8");
    await writeFile(prdPath, rewriteAdoptedPrd(prd, adapted), "utf8");
  }

  return adapted;
}

export function rewriteSkeletonBaseline(
  spec: string,
  adapted: AdaptedRecipeCommands,
): string {
  return spec
    .replace(/^(\s+command: )yarn install$/m, `$1${adapted.install}`)
    .replace(/^(\s+command: )yarn next:build$/m, `$1${adapted.build}`);
}

function buildCommandValidator(adapted: AdaptedRecipeCommands): {
  name: string;
  description: string;
  requiresNoSecrets: boolean;
  forbiddenCommands: string[];
  commands: Array<{ name: string; command: string; timeoutMs: number; purpose: string }>;
} {
  const commands = [
    {
      name: "install",
      command: adapted.install,
      timeoutMs: 300000,
      purpose: "Install workspace dependencies.",
    },
    ...(adapted.lint
      ? [
          {
            name: "lint",
            command: adapted.lint,
            timeoutMs: 180000,
            purpose: "Lint the project.",
          },
        ]
      : []),
    {
      name: "build",
      command: adapted.build,
      timeoutMs: 300000,
      purpose: "Production build or typecheck.",
    },
  ];

  return {
    name: `my-feature-${adapted.tool}`,
    description: `${adapted.tool} commands for the project-centric harness recipe. Keep install named "install" for fingerprint skip across attempts.`,
    requiresNoSecrets: true,
    forbiddenCommands: defaultForbiddenCommands(adapted.tool),
    commands,
  };
}

function rewriteAdoptedPrd(prd: string, adapted: AdaptedRecipeCommands): string {
  const manager = adapted.tool;
  return prd
    .replace("Scaffold-HBAR project", "project")
    .replace("Scaffold-HBAR app with `hedera-harness run`", "existing app with `hedera-harness run`")
    .replace(
      "- Do not switch the package manager away from Yarn",
      `- Do not switch the package manager away from ${manager}`,
    )
    .replace(
      "2. `yarn lint` and `yarn next:build` still pass (baseline + target validators)",
      `2. \`${adapted.build}\` still passes (baseline + target validators)`,
    );
}

async function readPackageScripts(targetDir: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(targetDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: unknown };
    if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
      return pkg.scripts as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}
