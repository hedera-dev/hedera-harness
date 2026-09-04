import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { parseValidatorVerdict } = await import(
  pathToFileURL(path.resolve("dist/validatorVerdictParser.js")).href
);

/** Shape that aborted the x402-message-board canary: fenced verdict, then `{` `}` in notes. */
const CANARY_RESULT_TEXT = `All eight assertions verified end-to-end.

\`\`\`json
{
  "passed": true,
  "summary": "All 8 assertions verified. Facilitator health is {\\"status\\":\\"ok\\",\\"canSettle\\":true}.",
  "issues": []
}
\`\`\`

**Verification detail:** raw topic payload contains only \`enc: {alg: aes-256-gcm, iv, tag, ciphertext}\`.
`;

function streamJsonStdout(resultText) {
  return [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", subtype: "success", result: resultText }),
    "",
  ].join("\n");
}

test("parses a bare verdict object", () => {
  const verdict = parseValidatorVerdict(
    JSON.stringify({ passed: false, summary: "E1 failed", issues: [] }),
  );
  assert.equal(verdict?.passed, false);
  assert.equal(verdict?.summary, "E1 failed");
});

test("parses a stream-json result that wraps the verdict in a json fence plus trailing braces", () => {
  const verdict = parseValidatorVerdict(streamJsonStdout(CANARY_RESULT_TEXT));
  assert.ok(verdict, "expected a verdict from the fenced block");
  assert.equal(verdict.passed, true);
  assert.match(verdict.summary, /All 8 assertions/);
  assert.deepEqual(verdict.issues, []);
});

test("parses an unfenced verdict followed by prose that also contains braces", () => {
  const stdout = `Verdict:
{"passed":true,"summary":"ok","issues":[]}
Later: enc: {alg: aes-256-gcm, iv}
`;
  const verdict = parseValidatorVerdict(stdout);
  assert.equal(verdict?.passed, true);
  assert.equal(verdict?.summary, "ok");
});

test("still extracts issues from a failing fenced verdict", () => {
  const stdout = streamJsonStdout(`Here is the grade:

\`\`\`json
{
  "passed": false,
  "summary": "E1 failed",
  "issues": [
    {
      "id": "E1",
      "assertion": "E1",
      "severity": "critical",
      "message": "board did not render",
      "route": "/board"
    }
  ]
}
\`\`\`

Note: payload was {alg: none}.
`);
  const verdict = parseValidatorVerdict(stdout);
  assert.equal(verdict?.passed, false);
  assert.equal(verdict?.issues.length, 1);
  assert.equal(verdict?.issues[0].id, "E1");
  assert.equal(verdict?.issues[0].route, "/board");
});

test("returns null when stdout has no verdict", () => {
  assert.equal(parseValidatorVerdict('{"type":"result","result":"no json here"}\n'), null);
});
