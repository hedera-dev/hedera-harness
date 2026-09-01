import { AGENT_PRESETS } from "./specDefaults.js";
import { envDisableModelEscalation, envModel, envRepairModel } from "./env.js";
import type { CommandAgentConfig, TemplateSpec } from "./types.js";

export interface ModelChoice {
  model: string;
  reason: "first-attempt" | "repair" | "escalated";
}

/**
 * First attempt uses the strong model. Repairs use the cheaper one unless the
 * previous repair fixed nothing — then escalate rather than cheap-repeat a failure.
 */
export function selectModel(input: {
  spec: TemplateSpec;
  isFirstAttemptOfCycle: boolean;
  previousFixedCount: number;
  hasRepaired: boolean;
}): ModelChoice {
  const preset = AGENT_PRESETS[input.spec.agent];
  const strong = envModel() ?? preset.defaultModel;
  const cheap = envRepairModel() ?? preset.repairModel;

  if (input.isFirstAttemptOfCycle) {
    return { model: strong, reason: "first-attempt" };
  }

  if (envDisableModelEscalation()) {
    return { model: strong, reason: "first-attempt" };
  }

  if (input.hasRepaired && input.previousFixedCount === 0) {
    return { model: strong, reason: "escalated" };
  }

  return { model: cheap, reason: "repair" };
}

/** Set `modelFlag` to `model` when the flag is already in `args`; leave `generator:` blocks that omit it alone. */
export function withModel(
  config: CommandAgentConfig,
  modelFlag: string,
  model: string,
): CommandAgentConfig {
  const args = [...(config.args ?? [])];
  const flagIndex = args.indexOf(modelFlag);

  if (flagIndex === -1) {
    return config;
  }

  if (flagIndex === args.length - 1) {
    args.push(model);
  } else {
    args[flagIndex + 1] = model;
  }

  return { ...config, args };
}
