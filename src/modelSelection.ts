import { AGENT_PRESETS } from "./specDefaults.js";
import { envDisableModelEscalation, envModel, envRepairModel } from "./env.js";
import type { CommandAgentConfig, TemplateSpec } from "./types.js";

export interface ModelChoice {
  model: string;
  reason: "first-attempt" | "repair" | "escalated";
}

/**
 * Pick the model for an attempt.
 *
 * Repairs are usually small, well-described edits driven by concrete findings, so
 * they run on the cheaper model. The exception is a repair that follows an attempt
 * which fixed nothing: paying less to repeat a failure is not a saving, so the
 * loop escalates back to the stronger model instead of burning the remaining
 * budget the same way.
 */
export function selectModel(input: {
  spec: TemplateSpec;
  isFirstAttemptOfCycle: boolean;
  /** Findings closed by the previous attempt. Zero means no progress was made. */
  previousFixedCount: number;
  /** True once at least one repair attempt has run this cycle. */
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

/**
 * Return a config with the model flag set to `model`.
 *
 * Replaces the existing value when the flag is already present so a preset's
 * default is overridden rather than duplicated; appends otherwise. Explicit
 * `generator:` blocks that never mention the flag are left alone — someone who
 * hand-wrote an invocation owns it.
 */
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
