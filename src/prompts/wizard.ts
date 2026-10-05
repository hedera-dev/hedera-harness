/** What the wizard asks for, and the file it asks for it in. */
export const COMMANDS_FILE = "commands.json";

export function commandsBrief(target: string): string {
  return [
    "Read this project well enough to say how it installs, builds, tests and serves.",
    "",
    "Script names are frequently misleading: a root package.json may have no",
    "build/test/dev script at all while the real ones are namespaced per workspace,",
    "and a workspace may define `start` as a dev server while `serve` runs the",
    "production build. Read what each script actually does rather than matching on",
    "its name.",
    "",
    "- prefer a command runnable from the repo root; set cwd only when necessary",
    "- build must produce a production build; serve must start a dev server that",
    "  keeps running and serves the app locally",
    "- test is null only if the project genuinely has no way to run tests",
    "",
    `Write the answer to ${target}, as JSON and nothing else — no prose around`,
    "it, no markdown fence:",
    "",
    "    {",
    '      "install": { "run": "yarn install" },',
    '      "build":   { "run": "yarn next:build" },',
    '      "test":    { "run": "yarn test" },',
    '      "serve":   { "run": "yarn dev", "cwd": "packages/nextjs" },',
    '      "notes": { "install": "…", "build": "…", "test": "…", "serve": "…" }',
    "    }",
    "",
    "`cwd` is optional and relative to the repo root; omit it to run at the root.",
    "`test` may be null. Each note is one short sentence saying why that command",
    "and not the obvious-looking one — they are written into harness.yaml as",
    "comments, for whoever reads it later wondering the same thing.",
  ].join("\n");
}

/**
 * The questioner's brief. It asks rather than assumes, because the thing that
 * makes a spec checkable is the detail the user has not thought to give yet.
 */
export function grillBrief(specPath: string, interactive: boolean): string {
  const shared = [
    "You are drafting the first spec for this project. Read enough of it to know",
    "its routes, where components and hooks live, and the conventions someone",
    "adding a feature would follow.",
    "",
    `The spec goes to ${specPath}. It is read by a coding agent that implements`,
    "whatever it says, and by a second agent that checks the running app against it",
    "without being allowed to see the code. So:",
    "",
    "- describe what a user sees and how the app behaves, in terms concrete to",
    "  *this* project — name the real directories, routes and conventions you found",
    "- state anything observable in terms a person could check in a browser,",
    "  since that is how it will be judged",
    "- say what is out of scope",
    "",
  ];

  if (!interactive) {
    return [
      ...shared,
      "There is nobody to ask, so write a skeleton: headings and prompts showing",
      "what to describe, with placeholders that are obvious and unmistakably",
      `unfilled. Write it to ${specPath} and nothing else.`,
    ].join("\n");
  }

  return [
    ...shared,
    "First, interview the person. Ask **one question at a time** and wait for the",
    "answer — never a list. Start with what they are building, then follow the",
    "answer: which element shows it, what appears while it is loading, what should",
    "happen when it fails, what is deliberately out of scope. Ask about what they",
    "have not said rather than confirming what they have.",
    "",
    "Your whole reply is the question. No preamble, no summary of what you have",
    "gathered — they can see it.",
    "",
    `When you have enough to write something checkable, stop asking and write`,
    `${specPath}, marking every place you had to guess with an obvious placeholder.`,
    "Write that file and nothing else.",
  ].join("\n");
}
