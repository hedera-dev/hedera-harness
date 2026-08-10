#!/usr/bin/env node
/**
 * Deterministic generator for run e2e smoke.
 * MOCK_HARNESS_MODE=fail|pass (default pass)
 * Last argv is the prompt (unused); workspace comes from MOCK_HARNESS_WORKSPACE or cwd.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const mode = (process.env.MOCK_HARNESS_MODE || "pass").toLowerCase();
const workspace = process.env.MOCK_HARNESS_WORKSPACE || process.cwd();
const headerPath = path.join(workspace, "packages/nextjs/components/Header.tsx");
const learnPath = path.join(workspace, "packages/nextjs/app/learn/page.tsx");

async function ensureLearnNav() {
  let header = await readFile(headerPath, "utf8");
  if (header.includes('href: "/learn"')) return;
  if (!header.includes('href: "/admin"')) {
    throw new Error("Header.tsx missing Admin link; cannot inject Learn nav");
  }
  header = header.replace(
    `  {
    label: "Admin",
    href: "/admin",
    icon: <Cog6ToothIcon className="h-4 w-4" />,
  },`,
    `  {
    label: "Learn",
    href: "/learn",
    icon: <ChatBubbleLeftIcon className="h-4 w-4" />,
  },
  {
    label: "Admin",
    href: "/admin",
    icon: <Cog6ToothIcon className="h-4 w-4" />,
  },`,
  );
  await writeFile(headerPath, header, "utf8");
}

async function writeLearnPage(full) {
  await mkdir(path.dirname(learnPath), { recursive: true });
  if (full) {
    await writeFile(
      learnPath,
      `"use client";

export default function LearnPage() {
  return (
    <main className="max-w-3xl mx-auto px-4 py-10 prose">
      <h1>How this demo uses Hedera</h1>
      <section>
        <h2>Consensus Service (HCS)</h2>
        <p>The Proof Wall stores timestamped messages on an HCS topic.</p>
      </section>
      <section>
        <h2>Token Service (HTS)</h2>
        <p>Participants can receive an HTS badge/token after submitting proofs.</p>
      </section>
    </main>
  );
}
`,
      "utf8",
    );
  } else {
    await writeFile(
      learnPath,
      `"use client";

export default function LearnPage() {
  return <main className="p-8">Learn page stub (incomplete for smoke fail mode)</main>;
}
`,
      "utf8",
    );
  }
}

await ensureLearnNav();
await writeLearnPage(mode !== "fail");
console.log(`mock-agent: mode=${mode} workspace=${workspace}`);
process.exit(0);
