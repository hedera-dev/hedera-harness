import { type Check, worded } from "../checks.js";
import type { Hedera, Unanswered } from "../evaluate.js";

/** What the evaluator writes, in its own workspace, and the harness reads back. */
export const VERDICT_FILE = "verdict.json";

export function brief(
  appUrl: string,
  chain: Hedera,
  checks: Check[],
  minutes: number,
): string {
  return [
    "You are checking whether a running web application does what its spec says.",
    "",
    `The app is running at ${appUrl}.`,
    `It is built on Hedera ${chain.network}; the public mirror node is ${chain.mirrorNode}.`,
    ...(chain.signer === null
      ? [
          "",
          "You have no wallet. Anything needing a signature cannot be completed, and",
          "saying so is a finding — do not go looking for one.",
        ]
      : [
          "",
          `You have a funded ${chain.network} account to sign with:`,
          `  account   ${chain.signer.id}`,
          `  key       ${chain.signer.key}`,
          "",
          "Import it into the app rather than letting the app generate its own wallet,",
          "which would have no funds. How depends on the app: a burner wallet usually",
          "reads its key from browser storage — scaffolded Hedera apps use the",
          "localStorage entry `burnerWallet.pk` — and some apps offer an import field.",
          "Set it before connecting. If the app only supports a browser extension there",
          "is no way in, and that is a finding rather than something to work around.",
        ]),
    "",
    "Judge the app with what it has. Do not acquire funds, sign up for services, or",
    "obtain credentials — if the app cannot do something, that is what you report.",
    "",
    "Read spec.md, which is the only file here. Decide what a user should be able",
    "to do if the spec were satisfied, then try it against the running app:",
    "",
    "- drive the browser with `playwright-cli` through Bash (see the playwright-cli skill)",
    "- check any on-chain effect by reading the mirror node over HTTP; it is public,",
    "  and you have no keys and need none. Read it **before** the action that should",
    "  change it and again after — a change is only visible against a value you wrote",
    "  down beforehand, and both readings belong in your evidence",
    "- save a screenshot, page snapshot or saved response into `evidence/` **as you go**,",
    "  so every finding can be checked afterwards",
    "",
    ...(checks.length === 0
      ? []
      : [
          "This checklist was read out of the spec before the app existed, so nothing",
          "about the app could have shaped it. Account for every item. For chain items:",
          "read the path from the mirror node **before you touch the app** and again",
          "afterwards — the first reading is what the second is measured against. For",
          "page items: check them in the browser you have open.",
          "",
          ...checks.map((check) => worded(check)),
          "",
          "Every item needs one `verified` entry: its id, what you read",
          "(before, for chain items, and after), whether it held, and the URL or",
          "evidence file that shows it. An item that did not hold normally means the",
          "run fails; if the item misread the spec, say how in `note` and judge the",
          "spec itself.",
          "",
        ]),
    "You cannot see the source code and should not try; judge only observable behaviour.",
    "",
    "**You get one turn and nothing will resume you.** Never start a command in the",
    "background and end your turn waiting to be notified — no notification can arrive,",
    "and a turn that ends without a verdict throws the whole evaluation away. If you",
    "need to wait, wait in the foreground: a blocking command costs nothing while it",
    `runs, and you have ${minutes} minutes for the entire check.`,
    "",
    `When you are done, write your verdict to ${VERDICT_FILE} in this directory, as`,
    "JSON and nothing else — no prose around it, no markdown fence:",
    "",
    "    {",
    '      "pass": false,',
    '      "failures": [',
    '        { "what": "what a user cannot do, in their terms",',
    '          "where": "a bare locator: /send, or #result",',
    '          "evidence": ["shot.png", "https://testnet.mirrornode.hedera.com/..."] }',
    "      ],",
    '      "verified": [',
    '        { "id": "<the checklist id, copied exactly>",',
    '          "before": "100", "after": "102.5", "holds": true,',
    '          "evidence": ["https://testnet.mirrornode.hedera.com/..."],',
    '          "note": "only when it did not hold but the run still passes" }',
    "      ]",
    "    }",
    "",
    "Pass only if every requirement in the spec is met. `where` is a bare locator and",
    "nothing else — no sentences; the explanation belongs in `what`. Every entry in",
    "`evidence` is a filename you saved in evidence/ or a mirror node URL, nothing else.",
    "`before` is for chain items only. Writing that file is how you answer; nothing",
    "else counts as answering.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Exported for tests: the three-way branch decides how thorough the retry is. */
export function nudge(outcome: { reason: string; why: Unanswered }): string {
  const opening = [
    `Your turn ended without a usable verdict: ${outcome.reason}`,
    "",
    "Nothing resumed you automatically — this message is the harness intervening,",
    "and it is the last turn you get. Do not start anything in the background and",
    "do not wait to be notified: wait in the foreground, with commands that block.",
    "",
  ];
  const closing = {
    "cut-off": [
      "You were stopped before you were done, not because you were wrong. Finish",
      "the checks you had not reached — the spec is still in spec.md and your",
      `evidence is still in evidence/ — and only then write ${VERDICT_FILE}.`,
      "Do not pass a requirement you have not actually checked.",
    ],
    unreported: [
      `You did the work and ended without reporting it. Write ${VERDICT_FILE} now`,
      `with what`,
      "you found. Check anything you are unsure of first.",
    ],
    unevidenced: [
      "Your verdict cited evidence the harness cannot find. Save the files you",
      "meant to cite into evidence/, or cite only files that are there, and call",
      `write ${VERDICT_FILE} again. A finding nobody can check is not a finding.`,
      "",
      "Report the same findings. You are fixing how they are evidenced, not",
      "whether they stand — the app has not changed since you looked at it.",
    ],
    incomplete: [
      "Your verdict left checklist items unaccounted for. Read the ones you",
      "skipped — the checklist is in the brief, and your browser and session are",
      `still live — then write ${VERDICT_FILE} again. This is the reading you have not`,
      "done, not a re-reading: your other findings stand unless what you read",
      "now contradicts them.",
    ],
  }[outcome.why];
  return [...opening, ...closing].join("\n");
}
