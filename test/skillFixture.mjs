import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A tiny hedera-skills-shaped git repo: one product skill plus an authoring
 * skill that must not be vendored. Tests point HARNESS_SKILLS_REPO here so
 * session runs stay offline.
 */
export async function writeProductSkillsRepo(root, { includeProduct = true, includeAuthoring = true } = {}) {
  if (includeProduct) {
    const demoDir = path.join(root, "plugins", "native-services-js", "skills", "demo");
    await mkdir(path.join(demoDir, "references"), { recursive: true });
    await writeFile(
      path.join(demoDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill.\n---\n# Demo\n",
    );
    await writeFile(path.join(demoDir, "references", "api.md"), "# api\n");
  }

  if (includeAuthoring) {
    const authoring = path.join(root, "plugins", "hedera-harness", "skills", "create-harness-spec");
    await mkdir(authoring, { recursive: true });
    await writeFile(
      path.join(authoring, "SKILL.md"),
      "---\nname: create-harness-spec\ndescription: Authoring only.\n---\n# Author\n",
    );
  } else if (!includeProduct) {
    await mkdir(path.join(root, "plugins"), { recursive: true });
  }

  await run("git", ["init", "-q", "-b", "master", "."], { cwd: root });
  await run("git", ["config", "user.email", "fixture@local"], { cwd: root });
  await run("git", ["config", "user.name", "Fixture"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run(
    "git",
    ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--no-gpg-sign", "-m", "skills"],
    { cwd: root },
  );
  return root;
}
