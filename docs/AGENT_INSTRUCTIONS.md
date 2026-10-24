# Agent Instructions — Accessibility Companion (hosted demo)

These instructions tell the coding agent (OpenCode, using its existing model) how to behave when improving a page scanned by the Accessibility Companion hosted demo. They implement the host coding-agent workflow in the PRD (§15) and the required repair policy (§6), adapted to the **hosted demo** delivery model.

This is a hosted, anonymous, **not-production** hackathon demo. The instructions in this file are for the **coding agent repairing source**. They are the authority for the repair loop; they do not control the server.

---

## 1. What you may work on

- **Our own deployed registration fixture** (allowlisted): you may edit its **source** and redeploy it at the **same URL**. This is the only target you repair.
- **Selected Indian government domains** (allowlisted): these are scanned **read-only** for real detection. **You must NOT edit, patch, or modify government source or pages.** Never imply a government site was repaired.
- No arbitrary remote, local, or private targets. Never scan a URL that is not on the allowlist.

## 2. The loop (do each step)

1. Read the supported accessibility rules (see §4) before creating or editing UI.
2. When the page is deployed, run `audit_page(url)` on the target URL. Retain the returned `run_id` as your baseline.
3. Inspect each finding's selectors/snippets in the actual source using normal repository tools.
4. Repair violations while preserving user intent, handlers, navigation, validation, and layout behavior.
5. Run the relevant existing behavior checks (fields usable, submit still executes, links keep destinations, required content visible).
6. **Redeploy the same URL** and wait for rollout/readiness — do not skip or fake this wait.
7. Run `verify_fixes(url, baseline_id)` on the **same URL**. Report remaining / newly detected / no-longer-detected honestly.
8. If failures remain, make another targeted repair and rescan.
9. After the final relevant edit, record the latest scan ID, tested URL, selected coverage, and outstanding review items in your final response.

Switching to another URL is **not** repair evidence. Verifying a corrected page at a different URL proves nothing about your fix.

## 3. Repair batch limit

You may attempt **at most three repair batches**. After three batches, stop, report the blocker and the review requirement, and surface unresolved findings. Never hide a finding or weaken the rules to manufacture a pass.

## 4. Unsafe shortcuts — forbidden

- Deleting offending controls or text solely to make findings disappear.
- Hiding content, setting `aria-hidden` on necessary UI, suppressing findings, or disabling rules to obtain a clear result.
- Adding generic accessible names such as "button", "link", or "image".
- Applying arbitrary language codes or treating valid syntax as proof of correct language.
- Replacing all image alternatives with empty strings.
- Changing destinations, button types, handlers, validation, submission, or layout behavior without justification.
- Claiming a scan proves keyboard access, screen-reader usability, or complete WCAG conformance.

## 5. Ambiguity handling

When intent is ambiguous, inspect nearby text, existing locale files, component usage, or project requirements. If ambiguity remains material, **ask the developer** and leave the finding/review item unresolved. Do not guess a fix that changes meaning.

## 6. Fixes the rule registry expects (summary)

| Category | axe rule IDs | What a justified fix looks like |
| --- | --- | --- |
| Text contrast | `color-contrast` | Correct color/token adjustment from rendered foreground/background evidence; preserve visual hierarchy. Gradients/images/ambiguous backgrounds may require review. |
| Image alternatives | `image-alt` | Meaningful, context-dependent alternative. Empty alternative only for confirmed decorative images. Never use filenames or generic words. |
| Form labels | `label`, `select-name` | Visible label correctly associated with the control; another appropriate accessible-name mechanism only when context warrants. Placeholders alone are insufficient. Preserve IDs, validation, and submission. |
| Link names | `link-name` | Accessible name describing the destination/purpose; preserve the destination. No generic text. |
| Button names | `button-name` | Meaningful name describing the action; prefer visible text. Preserve action and form behavior. |
| Document language | `html-has-lang`, `html-lang-valid` | Valid language declared from actual page content/project locale. Do not hard-code English without evidence. |

## 7. Pass wording (use this exact claim)

When the verification reports a pass (`gate = "pass"`), you may state:

> "No violations detected by the selected automated checks on the tested page state. Other accessibility requirements and semantic correctness may still need manual review."

Use this wording verbatim. Do not claim full WCAG conformance, certification, or completeness. A pass applies only to the selected checks, the tested page state, and the recorded scan conditions.

## 8. Honest reporting

- Do not claim commands were run that were not run, findings you did not observe, or deployed URLs that do not exist.
- The tool gate (`pass` / `fail` / `review_required` / `not_evaluated`) is authoritative. Never override a `fail` or `review_required` because the design "looks acceptable".
- Feature the runtime tests and any measured numbers only when they are real; otherwise mark them as placeholders.
- Never leak credentials or secrets. Reports are anonymous and keyed by opaque IDs; anyone holding the ID can read the report, so do not echo report IDs into public surfaces.
