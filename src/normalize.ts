/**
 * Normalizer (engine worker).
 *
 * Converts raw axe rule/node results into bounded, product-level findings and
 * review items (PRD §10), computes per-node evidence keys used by the
 * comparator, and redacts untrusted application HTML best-effort.
 *
 * All page-derived text/HTML is UNTRUSTED content: it is evidence, never
 * instructions, and is truncated/redacted before it leaves the engine.
 */
import { createHash } from "node:crypto";
import {
  stableFindingKey,
  type EvidenceStatus,
  type Finding,
  type Gate,
  type Impact,
  type ReviewItem,
} from "./contracts.js";
import { AppError } from "./errors.js";
import { getRuleDefinition, TARGET_PATH_ALGO } from "./rules.js";

export const MAX_SNIPPET_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Target normalization + stable ids
// ---------------------------------------------------------------------------

/**
 * Engine target paths may be NESTED arrays (shadow DOM selectors in axe), not
 * just flat strings. Structural identity is preserved (normalized structure),
 * while the externally visible `targets` list stays a flat string array
 * (each remaining part in order). Flat single-level paths keep EXACTLY the
 * previous identity scheme, so common single-element finding ids are unchanged;
 * anything nested gets a structure-preserving identity token under a separate
 * algorithm tag so it can never alias a flat id.
 */
export type TargetPart = string | TargetPart[];

/** Normalize an engine target recursively: keep structure, trim parts. */
export function normalizeTargetStructure(raw: unknown): TargetPart[] {
  const walk = (value: unknown): TargetPart[] => {
    if (!Array.isArray(value)) return [];
    const out: TargetPart[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        const t = item.trim().replace(/\s+/g, " ");
        if (t.length > 0) out.push(t);
      } else if (Array.isArray(item)) {
        const nested = walk(item);
        if (nested.length > 0) out.push(nested);
      }
      // Other scalar types (numbers, etc.) are dropped deterministically.
    }
    return out;
  };
  return walk(raw);
}

/** True when any part of the structure is itself a nested list. */
export function hasNestedTargets(structure: TargetPart[]): boolean {
  return structure.some((p) => Array.isArray(p));
}

/** Flat display form of a normalized structure (each string part in order). */
export function flattenTargetDisplay(structure: TargetPart[]): string[] {
  const out: string[] = [];
  const walk = (parts: TargetPart[]): void => {
    for (const p of parts) {
      if (typeof p === "string") out.push(p);
      else walk(p);
    }
  };
  walk(structure);
  return out;
}

/** Legacy flat-path normalizer (trim + collapse whitespace per part). */
export function normalizeTargetPath(targets: readonly string[]): string[] {
  return targets.map((part) => part.trim().replace(/\s+/g, " ")).filter((part) => part.length > 0);
}

/**
 * Stable finding id: SHA-256 over the shared contracts key
 * (rule + normalized target path). Flat targets keep the exact previous
 * identity (`ruleId::a|b`); nested targets are encoded morphologically
 * (JSON-serialized structure) under the TARGET_PATH_ALGO tag so they remain
 * unique against every flat id. Deterministic for unchanged elements.
 */
export function findingIdFor(ruleId: string, rawTarget: unknown): string {
  const structure = normalizeTargetStructure(rawTarget);
  if (hasNestedTargets(structure)) {
    const token = `nested\x02${TARGET_PATH_ALGO}\x02${JSON.stringify(structure)}`;
    return createHash("sha256").update(stableFindingKey(ruleId, [token])).digest("hex");
  }
  const flat = structure as string[];
  return createHash("sha256").update(stableFindingKey(ruleId, flat)).digest("hex");
}

// ---------------------------------------------------------------------------
// Snippet redaction (best-effort, untrusted input by definition)
// ---------------------------------------------------------------------------

const SENSITIVE_ATTR =
  /(?:^|[-_])(token|secret|password|passwd|pwd|apikey|api_key|api-key|auth|authorization|session|sess|csrf|xsrf|jwt|bearer|key|credential|credentials|sig|signature|otp|pin)(?:$|[-_])/i;

/** Attribute values that commonly carry application-submitted data. */
const VALUE_LIKE_ATTRS = new Set(["value", "data-value"]);

function redactAttrValue(value: string): string | null {
  if (value.trim() === "") return null;
  if (/^data:/.test(value)) return "data:[redacted]";
  if (/^https?:\/\//.test(value) && /(?:eyj[\w-]{8,}|token|key|sig=)/i.test(value)) return "[redacted-url]";
  if (/^[\w-]*\.[\w-]*\.[\w-]*$/.test(value) && value.length > 24) return "[redacted-token]";
  if (/^(?:[A-Za-z0-9+/]{24,}={0,2})$/.test(value)) return "[redacted-base64]";
  return null;
}

/**
 * Best-effort redaction of obvious secrets and form values inside an engine
 * HTML snippet. Not a guarantee: snippets can still contain application
 * content. Bounded to MAX_SNIPPET_CHARS after redaction.
 */
export function redactHtmlSnippet(html: unknown, limit: number = MAX_SNIPPET_CHARS): string {
  if (typeof html !== "string") return "";
  let out = html;
  // Strip inner text of textarea contents (form data often mirrors there).
  out = out.replace(/(<textarea\b[^>]*>)([\s\S]*?)(<\/textarea>)/gi, "$1$3");
  // Redact attribute values.
  out = out.replace(
    /([A-Za-z_:][-A-Za-z0-9_:.]*)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g,
    (full, name: string, eq: string, dq?: string, sq?: string, bare?: string) => {
      const value = dq ?? sq ?? bare ?? "";
      if (name.toLowerCase() === "value" || VALUE_LIKE_ATTRS.has(name.toLowerCase()) || SENSITIVE_ATTR.test(name)) {
        const hardened = redactAttrValue(value);
        if (hardened !== null) return `${name}${eq}"${hardened}"`;
        return `${name}${eq}""`;
      }
      const hardened = redactAttrValue(value);
      return hardened !== null ? `${name}${eq}"${hardened}"` : full;
    },
  );
  // Redact crypto-shaped runs in text.
  out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}/g, "[redacted-token]");
  // Collapse whitespace and cap length deterministically.
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > limit) out = `${out.slice(0, Math.max(0, limit - 3))}...`;
  return out;
}

// ---------------------------------------------------------------------------
// Raw engine types (kept structural; axe version differences tolerated)
// ---------------------------------------------------------------------------

export interface RawCheckResult {
  id?: unknown;
  message?: unknown;
  impact?: unknown;
  data?: unknown;
}

export interface RawNodeResult {
  html?: unknown;
  impact?: unknown;
  target?: unknown;
  failureSummary?: unknown;
  description?: unknown;
  any?: unknown;
  all?: unknown;
  none?: unknown;
}

export interface RawResult {
  id?: unknown;
  impact?: unknown;
  tags?: unknown;
  description?: unknown;
  help?: unknown;
  helpUrl?: unknown;
  nodes?: unknown;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

function asNodeList(v: unknown): RawNodeResult[] {
  return Array.isArray(v) ? (v.filter((n): n is RawNodeResult => n !== null && typeof n === "object") as RawNodeResult[]) : [];
}

function asImpact(v: unknown): Impact {
  return v === "minor" || v === "moderate" || v === "serious" || v === "critical" ? v : null;
}

function extractFailureSummary(node: RawNodeResult): string | null {
  const fs = asString(node.failureSummary);
  if (fs) return fs;
  // Fall back to the first check message; never merge unrelated node checks.
  const groups = [node.none, node.any, node.all];
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    for (const check of g as RawCheckResult[]) {
      const m = asString(check?.message);
      if (m) return m;
    }
  }
  return null;
}

/** WCAG-focused tags only (e.g. wcag2a, wcag2aa, best-practice is dropped). */
export function wcagTags(tags: string[]): string[] {
  return tags.filter((t) => /^wcag/i.test(t));
}

// ---------------------------------------------------------------------------
// Outcome normalization
// ---------------------------------------------------------------------------

export interface NormalizedOutcome {
  /** One finding per violation rule/node instance, full (unbounded view). */
  findings: Finding[];
  /** One review item per incomplete rule/node instance, full. */
  reviewItems: ReviewItem[];
  /** Evidence per stable id: pass/fail/incomplete for this run. */
  evidence: Record<string, EvidenceStatus>;
  /** Rules that produced at least one evaluated node outcome. */
  evaluatedRuleIds: string[];
  /** Required rules reported inapplicable (no relevant elements). */
  inapplicableRuleIds: string[];
  /** Required rules with at least one incomplete outcome (rule or node). */
  incompleteRuleIds: string[];
  counts: {
    violationRuleCount: number;
    violationNodeCount: number;
    incompleteNodeCount: number;
    /** Incomplete rules that had NO node evidence (rule-level review only). */
    incompleteRuleCount: number;
  };
  /** Findings that produced the same stable id (identity ambiguity; never silently dropped). */
  duplicateFindingIdCount: number;
  /** Rule ids for which engine help/description came through (meta evidence). */
  ruleMeta: Map<string, { help: string; helpUrl: string; tags: string[]; description: string; category: string }>;
}

/**
 * Account a list of engine results (violations/passes/incomplete/inapplicable)
 * into normalized structures. Untrusted in, structurally validated out.
 */
function accountResults(list: RawResult[]): { ruleIds: string[]; byRule: Map<string, RawResult> } {
  const ruleIds: string[] = [];
  const byRule = new Map<string, RawResult>();
  for (const r of list) {
    const id = asString(r.id);
    if (!id) continue;
    ruleIds.push(id);
    if (!byRule.has(id)) byRule.set(id, r);
  }
  return { ruleIds, byRule };
}

export function normalizeAxeResults(
  axe: {
    violations?: unknown;
    passes?: unknown;
    incomplete?: unknown;
    inapplicable?: unknown;
  },
): NormalizedOutcome {
  const violations = accountResults(Array.isArray(axe.violations) ? (axe.violations as RawResult[]) : []);
  const passes = accountResults(Array.isArray(axe.passes) ? (axe.passes as RawResult[]) : []);
  const incomplete = accountResults(Array.isArray(axe.incomplete) ? (axe.incomplete as RawResult[]) : []);
  const inapplicable = accountResults(Array.isArray(axe.inapplicable) ? (axe.inapplicable as RawResult[]) : []);

  const findings: Finding[] = [];
  const reviewItems: ReviewItem[] = [];
  const evidence: Record<string, EvidenceStatus> = {};
  const evaluatedRuleIds = new Set<string>();
  const incompleteRuleIds = new Set<string>();
  const ruleMeta = new Map<string, { help: string; helpUrl: string; tags: string[]; description: string; category: string }>();

  const recordMeta = (id: string, r: RawResult): void => {
    if (ruleMeta.has(id)) return;
    const def = getRuleDefinition(id);
    ruleMeta.set(id, {
      help: asString(r.help) ?? "",
      helpUrl: asString(r.helpUrl) ?? "",
      tags: (def ? wcagTags(asStringArray(r.tags)) : asStringArray(r.tags)).filter(Boolean),
      description: asString(r.description) ?? "",
      category: def?.category ?? "Other",
    });
  };

  // Violations -> findings (fail evidence).
  let violationNodeCount = 0;
  for (const id of violations.ruleIds) {
    const r = violations.byRule.get(id)!;
    const def = getRuleDefinition(id);
    recordMeta(id, r);
    evaluatedRuleIds.add(id);
    for (const node of asNodeList(r.nodes)) {
      violationNodeCount += 1;
      const structure = normalizeTargetStructure(node.target);
      if (structure.length === 0) {
        // A violation with no usable target identity cannot create a stable
        // finding id; treat as engine accounting failure, never a silent drop.
        throw new AppError(
          "RULESET_UNSUPPORTED",
          `The engine produced a violation for rule "${id}" without a usable target path; results cannot be identified.`,
          "Update, pin or replace the axe-core engine version, then restart the service.",
          true,
        );
      }
      const fid = findingIdFor(id, node.target);
      findings.push({
        id: fid,
        rule_id: id,
        impact: asImpact(node.impact ?? r.impact),
        description: asString(node.description) ?? asString(r.description) ?? `${id} accessibility check failed for this element.`,
        help: asString(r.help) ?? (def ? `Fix ${def.category.toLowerCase()} problem` : `Fix ${id} problem`),
        help_url: asString(r.helpUrl) ?? "",
        wcag_tags: wcagTags(asStringArray(r.tags)),
        targets: flattenTargetDisplay(structure),
        html: redactHtmlSnippet(node.html),
        failure_summary: extractFailureSummary(node),
        guidance: def?.guidance ?? `Repair the ${id} problem using an accessibility reference, preserving application behavior; rescan.`,
        guidance_source: "rule_registry",
        requires_context: def?.requiresContext ?? true,
      });
      evidence[fid] = "fail";
    }
  }
  // A violation rule reported WITHOUT any node evidence is an engine
  // accounting failure: accounting a violation as "no problem" would turn an
  // unexplained rule into a pass.
  if (violations.ruleIds.length > 0 && violationNodeCount === 0) {
    throw new AppError(
      "RULESET_UNSUPPORTED",
      `The engine reported violations with no node evidence for: ${violations.ruleIds.join(", ")}. Results could not be evaluated.`,
      "Update, pin or replace the axe-core engine version, then restart the service.",
      true,
    );
  }

  // Incomplete -> review items (incomplete evidence).
  let incompleteNodeCount = 0;
  let incompleteRuleCount = 0;
  for (const id of incomplete.ruleIds) {
    const r = incomplete.byRule.get(id)!;
    const def = getRuleDefinition(id);
    recordMeta(id, r);
    evaluatedRuleIds.add(id);
    incompleteRuleIds.add(id);
    let nodeCount = 0;
    for (const node of asNodeList(r.nodes)) {
      nodeCount += 1;
      incompleteNodeCount += 1;
      const structure = normalizeTargetStructure(node.target);
      const iid = findingIdFor(id, node.target);
      reviewItems.push({
        rule_id: id,
        targets: flattenTargetDisplay(structure),
        reason: extractFailureSummary(node) ?? def?.reviewReason ?? "Engine returned an incomplete result; human review required.",
        html: node.html == null ? null : redactHtmlSnippet(node.html),
      });
      if (evidence[iid] === undefined) evidence[iid] = "incomplete";
      else delete evidence[iid]; // a fail on the same target dominates an incomplete
    }
    if (nodeCount === 0) {
      // Rule reported incomplete WITHOUT node evidence: it still counts as an
      // incomplete OUTCOME (review), never a pass, via a rule-level review item.
      incompleteRuleCount += 1;
      reviewItems.push({
        rule_id: id,
        targets: [],
        reason:
          def?.reviewReason ??
          `The engine reported rule "${id}" as incomplete without node-level detail; human review is required and no conclusion was computable for it.`,
        html: null,
      });
    }
  }
  // recompute: a target that is BOTH violation and incomplete keeps "fail".
  for (const id of violations.ruleIds) {
    const r = violations.byRule.get(id)!;
    for (const node of asNodeList(r.nodes)) {
      evidence[findingIdFor(id, node.target)] = "fail";
    }
  }

  // Passes -> pass evidence for stable nodes (used by the comparator to prove
  // that a specific baseline finding is now fixed *at the same target*).
  for (const id of passes.ruleIds) {
    const r = passes.byRule.get(id)!;
    evaluatedRuleIds.add(id);
    for (const node of asNodeList(r.nodes)) {
      const pid = findingIdFor(id, node.target);
      if (evidence[pid] === undefined) evidence[pid] = "pass";
    }
  }

  // Stable-id identity ambiguity (e.g. engine double-reporting the same
  // rule/target): never silently assume the duplicate has no meaning.
  let duplicateFindingIdCount = 0;
  {
    const seen = new Map<string, string>();
    for (const f of findings) {
      const existing = seen.get(f.id);
      if (existing !== undefined) {
        duplicateFindingIdCount += 1;
        continue;
      }
      seen.set(f.id, f.rule_id);
    }
  }

  const inapplicableRuleIds = inapplicable.ruleIds.slice();

  return {
    findings,
    reviewItems,
    evidence,
    evaluatedRuleIds: [...evaluatedRuleIds].sort(),
    inapplicableRuleIds: [...inapplicableRuleIds].sort(),
    incompleteRuleIds: [...incompleteRuleIds].sort(),
    counts: {
      violationRuleCount: violations.ruleIds.length,
      violationNodeCount,
      incompleteNodeCount,
      incompleteRuleCount,
    },
    duplicateFindingIdCount,
    ruleMeta,
  };
}

/**
 * Restrictive gate decision, shared by the engine and unit tests.
 *
 * Order (most restrictive first):
 *  1. any violation node            -> "fail"
 *  2. any incomplete outcome (node- OR rule-level review item) -> "review_required"
 *  3. duplicate stable ids          -> "review_required" (identity ambiguity;
 *     never silently assume the scan clean)
 *  4. blocked remote assets         -> "review_required" (rendering may be
 *     incomplete, so a clean automated check is not a proven clean page)
 *  5. unknown engine version        -> "not_evaluated" (no successful pass
 *     without engine provenance; the results still exist but cannot be a
 *     verified pass)
 *  6. fonts/styles unsettled        -> "review_required" (rendered-color
 *     checks may be measured against incomplete styling; never a hard pass)
 *  7. otherwise                     -> "pass"
 */
export function computeOutcomeGate(
  outcome: NormalizedOutcome,
  options: { engineVersionKnown: boolean; remoteAssetsBlocked: number; fontsUnsettled: boolean },
): Gate {
  if (outcome.counts.violationNodeCount > 0) return "fail";
  if (outcome.reviewItems.length > 0) return "review_required";
  if (outcome.duplicateFindingIdCount > 0) return "review_required";
  if (options.remoteAssetsBlocked > 0) return "review_required";
  if (!options.engineVersionKnown) return "not_evaluated";
  if (options.fontsUnsettled) return "review_required";
  return "pass";
}
