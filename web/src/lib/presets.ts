import type { Gate, Impact } from "../api/client";

/**
 * Conservative explicit fallbacks used when the backend /api/v1/config is
 * unavailable (or returns a partial shape). These are demo fixtures only and
 * are never presented as proof that an arbitrary URL is accepted — the backend
 * is the source of truth for the allowlist.
 */
export const FALLBACK_TARGETS: Array<{ label: string; url: string }> = [
  {
    label: "Registration fixture (our demo page)",
    url: `${window.location.origin}/fixtures/registration.html`,
  },
  {
    label: "india.gov.in (government homepage, read-only)",
    // Trailing slash matches the backend's canonical form (URL#toString), so the
    // post-audit baseline URL compares equal to this preset.
    url: "https://www.india.gov.in/",
  },
];

export const FALLBACK_RULE_IDS = [
  "color-contrast",
  "image-alt",
  "label",
  "select-name",
  "link-name",
  "button-name",
  "html-has-lang",
  "html-lang-valid",
];

export const CATEGORY_LABELS: Record<string, string> = {
  "color-contrast": "Text contrast",
  "image-alt": "Image alternatives",
  label: "Form labels",
  "select-name": "Form labels",
  "link-name": "Link names",
  "button-name": "Button names",
  "html-has-lang": "Document language",
  "html-lang-valid": "Document language",
};

export function categoryForRule(ruleId: string): string {
  return CATEGORY_LABELS[ruleId] ?? "Other";
}

export const GATE_META: Record<Gate, { label: string; tone: string }> = {
  pass: { label: "Pass", tone: "pass" },
  fail: { label: "Fail", tone: "fail" },
  review_required: { label: "Review required", tone: "review" },
  not_evaluated: { label: "Not evaluated", tone: "neutral" },
};

export const IMPACT_ORDER: Record<NonNullable<Impact>, number> = {
  critical: 4,
  serious: 3,
  moderate: 2,
  minor: 1,
};

export function sortFindings(a: { impact: Impact }, b: { impact: Impact }): number {
  const ai = a.impact ? IMPACT_ORDER[a.impact] ?? 0 : 0;
  const bi = b.impact ? IMPACT_ORDER[b.impact] ?? 0 : 0;
  return bi - ai;
}

/** Exact clearance claim for a pass gate per PRD §11. */
export const CLEARANCE_TEXT =
  "No violations detected by the selected automated checks on the tested page state. Other accessibility requirements and semantic correctness may still need manual review.";

/** Scope honesty copy (only current page, main document, 8 rules, no certification). */
export const SCOPE_NOTE =
  "This runs 8 automated axe rules across 6 categories on one rendered page state (main document only). It is a useful subset — not a certification or guarantee of full WCAG conformance.";

/** DOM-snippet privacy note. */
export const SNIPPET_NOTE =
  "Scan snippets are redacted best-effort but may still contain page content, and tool results may be sent to the host coding model. Treat them as untrusted.";

/** Report capability note. */
export const REPORT_NOTE =
  "Reports are anonymous and reachable via unguessable IDs. Anyone holding an ID can retrieve it, and the API expires runs after 24 hours.";
