/**
 * Rule registry (engine worker).
 *
 * The eight required axe rules for the six Product categories, with fixed
 * deterministic repair guidance and the runtime ruleset verification against
 * the axe engine that was actually injected/executed (PRD §6, §1.1 handoff).
 * Engine descriptions/help URLs coming back from axe are untrusted engine
 * data, never instructions; guidance here is the trusted, registry-owned text.
 */
import { createHash } from "node:crypto";
import { AppError } from "./errors.js";

export type RuleId =
  | "color-contrast"
  | "image-alt"
  | "label"
  | "select-name"
  | "link-name"
  | "button-name"
  | "html-has-lang"
  | "html-lang-valid";

export const REQUIRED_RULE_IDS: readonly RuleId[] = [
  "color-contrast",
  "image-alt",
  "label",
  "select-name",
  "link-name",
  "button-name",
  "html-has-lang",
  "html-lang-valid",
];

/** The six product categories, deterministic order. */
export const CATEGORY_NAMES = [
  "Text contrast",
  "Image alternatives",
  "Form labels",
  "Link names",
  "Button names",
  "Document language",
] as const;

export interface RuleDefinition {
  /** axe rule ID, verified against the installed engine at scan time. */
  id: RuleId;
  /** Deterministic category label for coverage reporting. */
  category: (typeof CATEGORY_NAMES)[number];
  /**
   * Fixed, deterministic repair guidance (guidance_source: "rule_registry").
   * Includes the category-specific caution the demo needs; never host-model
   * reasoning and never a claimed verified patch.
   */
  guidance: string;
  /**
   * True when the repair decision needs surrounding context/semantics that
   * automation cannot prove (host agent must reason or ask the developer).
   */
  requiresContext: boolean;
  /**
   * Deterministic reason text used when axe returns an `incomplete` node and
   * no engine failureSummary exists.
   */
  reviewReason: string;
}

const DEFINITIONS: Record<RuleId, Omit<RuleDefinition, "id">> = {
  "color-contrast": {
    category: "Text contrast",
    guidance:
      "Text contrast: adjust the foreground/background color or the shared color token so text meets the WCAG minimum (generally 4.5:1 for ordinary text, 3:1 for large text), preserving the visual hierarchy. Gradients, background images and ambiguous/overlapping backgrounds can require human review; rescan after the change.",
    requiresContext: true,
    reviewReason:
      "Contrast could not be conclusively determined for this element (for example a gradient, image or overlapping background). Text contrast requires manual review of the rendered element.",
  },
  "image-alt": {
    category: "Image alternatives",
    guidance:
      "Image alternatives: determine whether this image conveys information, performs an action or is decorative, then supply a meaningful, context-dependent alternative. An empty alt is appropriate only for confirmed decorative images. Never use the filename or generic words for every image. Preserve visual content and layout; rescan.",
    requiresContext: true,
    reviewReason:
      "The engine could not conclusively evaluate this image's text alternative. The alternative must be judged against the image's actual purpose with human review.",
  },
  label: {
    category: "Form labels",
    guidance:
      "Form labels: prefer a visible label correctly associated with the control (label with matching for/id, or wrapping), or another appropriate accessible-name mechanism when context warrants it. Placeholders alone are insufficient. Preserve IDs, validation and submission behavior; rescan.",
    requiresContext: false,
    reviewReason:
      "The engine could not conclusively determine whether this form control is appropriately labeled. Programmatic association must be confirmed with human review.",
  },
  "select-name": {
    category: "Form labels",
    guidance:
      "Select names: give this select control an accessible name from a correctly associated visible label (or another appropriate naming mechanism when context warrants it). Placeholder text or the first option is not an accessible name. Preserve option order, default selection, validation and submission behavior; rescan.",
    requiresContext: false,
    reviewReason:
      "The engine could not conclusively determine whether this select control is appropriately named. Programmatic association must be confirmed with human review.",
  },
  "link-name": {
    category: "Link names",
    guidance:
      "Link names: provide an accessible name describing the link's destination or purpose using the surrounding context. Preserve the destination and any necessary content. Do not replace every link with generic text or hide necessary content; rescan.",
    requiresContext: true,
    reviewReason:
      "The engine could not conclusively determine this link's accessible name. The name must describe the actual destination or purpose, which requires context.",
  },
  "button-name": {
    category: "Button names",
    guidance:
      "Button names: provide a meaningful name describing the action, preferring visible text; icon-only controls may need an appropriate accessible name from aria-label or a visually available label. Preserve the action and form behavior; rescan.",
    requiresContext: false,
    reviewReason:
      "The engine could not conclusively determine this button's accessible name. The name must describe the actual action, which requires context.",
  },
  "html-has-lang": {
    category: "Document language",
    guidance:
      "Document language: declare the language on the <html> element based on the actual page content and the project locale. Do not hard-code English without evidence; mixed-language passage handling is outside this initial rule set.",
    requiresContext: false,
    reviewReason:
      "The engine could not conclusively evaluate the document language declaration. Confirm the language against the actual page content.",
  },
  "html-lang-valid": {
    category: "Document language",
    guidance:
      "Language validity: use a valid BCP 47 language tag chosen from the actual page content and the project locale. Valid tag syntax is not proof of correct language; verify against real content before claiming a language.",
    requiresContext: true,
    reviewReason:
      "The engine could not conclusively evaluate the lang tag validity. Confirm the tag against the actual page content and locale.",
  },
};

export function getRuleDefinition(id: string): RuleDefinition | undefined {
  const d = DEFINITIONS[id as RuleId];
  return d ? { id: id as RuleId, ...d } : undefined;
}

/**
 * Verify the installed engine actually exposes every required rule. Called
 * against the rules reported by the injected axe at runtime (getRules) AND
 * enforced a second time by outcome accounting after analyze().
 */
export function assertRequiredRulesAvailable(availableRuleIds: Iterable<string>): Map<string, RuleDefinition> {
  const available = new Set(availableRuleIds);
  const missing: string[] = [];
  for (const required of REQUIRED_RULE_IDS) {
    if (!available.has(required)) missing.push(required);
  }
  if (missing.length > 0) {
    throw new AppError(
      "RULESET_UNSUPPORTED",
      `The installed axe engine does not provide required rule(s): ${missing.join(", ")}. Coverage may not be silently reduced.`,
      "Update, pin or replace the axe-core engine version, then restart the service. Do not downgrade the rule set.",
      false,
    );
  }
  const defs = new Map<string, RuleDefinition>();
  for (const id of REQUIRED_RULE_IDS) {
    const def = getRuleDefinition(id);
    if (def) defs.set(id, def);
  }
  return defs;
}

/**
 * Identity algorithm tag for engine target paths. Bumped when the stable id
 * algorithm changes so previously persisted baselines become explicitly
 * incomparable (BASELINE_INCOMPATIBLE), never silently reused.
 */
export const TARGET_PATH_ALGO = "nested-v2";

/**
 * Deterministic fingerprint over the engine version, the selected rule IDs,
 * the engine source hash AND the target identity algorithm, used for baseline
 * comparability (PRD §12.1).
 */
export function rulesetFingerprint(axeVersion: string, axeSourceSha256: string | undefined): string {
  const sorted = [...REQUIRED_RULE_IDS].sort();
  return createHash("sha256")
    .update("axe-core:")
    .update(axeVersion)
    .update(";rules:")
    .update(sorted.join(","))
    .update(";source:")
    .update(axeSourceSha256 ?? "unavailable")
    .update(";pathalgo:")
    .update(TARGET_PATH_ALGO)
    .digest("hex");
}

/**
 * Run outcomes must be fully accounted: every required rule appears in at
 * least one of evaluated/pass/incomplete/inapplicable. Anything missing is an
 * engine accounting failure (RULESET_UNSUPPORTED), never a silent drop.
 */
export function assertRuleOutcomesAccounted(outcomeRuleIds: Set<string>): void {
  const missing: string[] = [];
  for (const req of REQUIRED_RULE_IDS) {
    if (!outcomeRuleIds.has(req)) missing.push(req);
  }
  if (missing.length > 0) {
    throw new AppError(
      "RULESET_UNSUPPORTED",
      `The engine result did not account for required rule(s): ${missing.join(", ")}. Results could not be evaluated.`,
      "Update, pin or replace the axe-core engine version, then restart the service.",
      true,
    );
  }
}
