import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// x402 v1 and v2 are not wire-compatible, and the difference is invisible at
// runtime: a v2 resource server reads `PAYMENT-SIGNATURE` and simply does not
// look at `X-PAYMENT`, so a client sending the v1 header gets no error — the
// request is just treated as unpaid. A PRD that names the v1 header while
// specifying v2 packages sends the agent down that path deliberately.
//
// These tests keep the shipped PRDs internally consistent about which version
// they are describing.

const PRD_DIR = path.resolve("docs/prds");

/** v2 wire names, and the v1 names that silently do nothing against a v2 server. */
const V1_ONLY_HEADERS = ["X-PAYMENT", "X-PAYMENT-RESPONSE"];
const V2_PACKAGE_MARKERS = ["@x402/hedera", "@x402/core", "@x402/express", "ExactHederaScheme"];

async function prdFiles() {
  const entries = await readdir(PRD_DIR);
  return entries.filter((f) => f.endsWith(".md") && f !== "README.md");
}

/** Strip fenced code blocks, so an intentional v1 example is not a false positive. */
function withoutCodeFences(text) {
  return text.replace(/```[\s\S]*?```/g, "");
}

test("a PRD that specifies x402 v2 packages does not tell the agent to send v1 headers", async () => {
  for (const file of await prdFiles()) {
    const raw = await readFile(path.join(PRD_DIR, file), "utf8");
    const specifiesV2 = V2_PACKAGE_MARKERS.some((m) => raw.includes(m));
    if (!specifiesV2) continue;

    const prose = withoutCodeFences(raw);
    for (const header of V1_ONLY_HEADERS) {
      // Mentioning the v1 name to contrast it with v2 is fine and useful;
      // instructing the agent to *send* it is not.
      const instructing = new RegExp(
        String.raw`(?:with|send|sends|sending|using|set|sets|retry\s+\S+\s+with|header)\s+(?:the\s+)?\x60?${header}\x60?`,
        "i",
      );
      const match = prose.match(instructing);
      assert.equal(
        match,
        null,
        `docs/prds/${file} specifies x402 v2 packages but instructs the agent to use the v1 header ${header}` +
          (match ? ` — found: "${match[0].trim()}"` : "") +
          `. v2 sends PAYMENT-SIGNATURE; a v2 server never reads ${header}, and the failure is silent.`,
      );
    }
  }
});

test("a PRD naming the v1 header at all also explains that v2 differs", async () => {
  for (const file of await prdFiles()) {
    const raw = await readFile(path.join(PRD_DIR, file), "utf8");
    if (!V1_ONLY_HEADERS.some((h) => raw.includes(h))) continue;

    assert.ok(
      raw.includes("PAYMENT-SIGNATURE"),
      `docs/prds/${file} mentions a v1 payment header without mentioning the v2 name ` +
        `PAYMENT-SIGNATURE. Readers cannot tell which protocol version is meant.`,
    );
  }
});
