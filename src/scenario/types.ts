import type { ChainValidationOperatorConfig } from "../types.js";

export interface ScenarioActorSpec {
  fundHbar: number;
}

export type ScenarioStep =
  | {
      id: string;
      actor: string;
      transferHbar: { to: string; hbar: number };
    }
  | {
      id: string;
      actor: string;
      tokenCreate: { name: string; symbol: string; decimals?: number; initialSupply?: number };
    }
  | {
      id: string;
      actor: string;
      tokenAssociate: { token: string };
    }
  | {
      id: string;
      actor: string;
      tokenAirdrop: { token: string; to: string; amount: number };
    }
  | {
      id: string;
      actor: string;
      tokenClaim: { token: string };
    }
  | {
      id: string;
      actor: string;
      topicCreate: Record<string, never>;
    }
  | {
      id: string;
      actor: string;
      topicSubmit: { topic: string; message: string };
    };

export type ScenarioAssertion =
  | { accountHbar: { actor: string; min: number } }
  | { tokenBalance: { actor: string; token: string; min: number } }
  | { topicMessage: { topic: string; contains: string } };

export interface ScenarioPlan {
  actors: Record<string, ScenarioActorSpec>;
  steps: ScenarioStep[];
  assertions: ScenarioAssertion[];
}

export interface ScenarioConfig {
  enabled: boolean;
  network: "testnet";
  operator?: ChainValidationOperatorConfig;
  /** Absolute path after load, when the plan lives in a separate file. */
  filePath?: string;
  plan: ScenarioPlan;
  sweepBack: boolean;
}

export interface ScenarioActor {
  name: string;
  accountId: string;
  privateKeyHex: string;
  evmAddress: string;
}

export interface ScenarioBindings {
  [id: string]: {
    accountId?: string;
    tokenId?: string;
    topicId?: string;
    transactionId?: string;
  };
}

export interface ScenarioStepResult {
  id: string;
  kind: string;
  actor: string;
  transactionId?: string;
  tokenId?: string;
  topicId?: string;
  durationMs: number;
  error?: string;
}

export interface ScenarioAssertionResult {
  kind: string;
  passed: boolean;
  detail: string;
}

export interface ScenarioRunResult {
  passed: boolean;
  infrastructureFailure?: boolean;
  infrastructureFailureReason?: string;
  steps: ScenarioStepResult[];
  assertions: ScenarioAssertionResult[];
  bindings: ScenarioBindings;
  durationMs: number;
}
