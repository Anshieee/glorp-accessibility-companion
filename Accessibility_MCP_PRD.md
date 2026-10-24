# Hosted Demo Scope Addendum (supersedes P0 delivery constraint)

Version: 1.1
Date: 24 October 2026
Audience: everyone building, hosting, and demoing the Accessibility Companion hackathon demo
Status: PLANNING / PRE-BUILD — the application is not implemented yet

## Purpose

This addendum is prepended to the original PRD, which remains intact below. It **supersedes the original P0 delivery constraint** — local stdio MCP, localhost-only scans, the strict 180-minute ceiling, and disk-only persistence. It records the decisions settled in the planning session (Q1–Q20) for the hosted hackathon demo and states which original invariants still apply.

**User decision:** build the as-soon-as-possible **demoable** hosted demo, explicitly **not production**. Security/hardening work below is *planned* and must be tested before any public deploy; nothing here claims these controls exist yet.

## What is superseded (original PRD §0, §8, §20)

| Original delivery constraint | Superseded by |
| --- | --- |
| Local stdio MCP server | Remote Streamable HTTP MCP server (`/mcp`), one engine shared with the HTTP API |
| Full-page localhost scans only | Public allowlisted targets: our deployed flawed fixture + selected Indian government domains (read-only detection) |
| Strict 180-minute delivery ceiling | Hackathon demo timeline; no artificial time cap is claimed |
| Disk-only local run store | Private GCS normalized runs with a 24-hour app-enforced TTL (GCS lifecycle deletion is eventual, best-effort) |
| "OpenCode on Arch Linux / other MCP hosts" host framing | Hosted demo reachable by web visitors; OpenCode remains the demo host agent |

## Invariants retained unchanged from the original PRD

- **Engine:** Playwright Chromium + `@axe-core/playwright`; eight rule IDs mapped to six categories.
- **Normalization:** bounded normalized findings; conservative gate (`pass` / `fail` / `review_required` / `not_evaluated`); immutable opaque run IDs; `details_truncated` with omitted counts.
- **Gate / truthfulness:** tool error, empty target, missing browser, or inconclusive result never becomes a pass; a pass applies only to the selected checks, rendered state, and recorded conditions; incomplete results never upgrade to pass.
- **Capability reporting:** every run reports scope, coverage, engine versions, ruleset fingerprint, and limitations. No certification or full-WCAG conformance claim.
- **Repair ownership:** the coding agent edits source; the server exposes no application-write/shell tool. Unsafe shortcuts (§6.2) remain forbidden.
- **24-hour report TTL** and the privacy caveats in Q14 below.

## Settled decisions (planning session)

**Q1. Delivery mode** — Hosted **anonymous** demo API plus remote MCP. No login, no tenant auth. **Not production.**

**Q2. Timing priority** — User chose **as soon as possible demoable**, not production-hardening. Ship a working demo first; harden before any public launch.

**Q3. Scan targets (allowlist only)** — The public demo may scan **only** configured allowlisted targets: (a) our own deployed **editable flawed registration fixture** (primary demo; source-repaired at the same URL), and (b) **selected Indian government domains** for real read-only detection. No arbitrary remote, local, or private targets.

**Q4. Shared engine** — One TypeScript/Node shared scanning/normalization/comparison core serves both the HTTP API and the remote MCP server. Stateless service; state lives in GCS runs.

**Q5. Remote MCP** — Streamable HTTP MCP at `/mcp`, built on the official MCP SDK (one consistent generation). Tools: `audit_page(url)` and `verify_fixes(url, baseline_id)`.

**Q6. HTTP API** — `POST /api/v1/audits` `{ "url": ... }`; `POST /api/v1/verifications` `{ "url": ..., "baseline_id": ... }`; `GET /api/v1/runs/:run_id`; `GET /api/v1/config`; `GET /healthz`.

**Q7. Detection & guidance** — Playwright Chromium + axe; eight rules / six categories; deterministic rule guidance; source edits by the host agent only. Government read-only detection shows only observed findings — never assumed failures, and never source repair.

**Q8. Frontend** — React + TypeScript + Vite web app, static, served same-origin. Landing page + minimal usable demo screen (URL input → progress → findings → verification). **No dashboard.**

**Q9. Region** — Mumbai `asia-south1` approved by user. No hosting/deployment yet.

**Q10. Storage** — Private GCS for normalized run objects, 24-hour app-enforced expiration; GCS lifecycle deletion is eventual/best-effort. Dedicated, narrowly scoped service account / bucket only.

**Q11. Configuration env (backend)** — `ACCESSIBILITY_ALLOWED_ORIGINS`, `ACCESSIBILITY_ALLOWED_HOSTS`, `ACCESSIBILITY_PUBLIC_BASE_URL`, `ACCESSIBILITY_REPORT_BUCKET` (final name confirmed by backend), `ACCESSIBILITY_REPORT_DIR`, `ACCESSIBILITY_ALLOW_LOCAL` (`true` only for developer tests — **never on Cloud Run**).

**Q12. Local mode** — localhost is unreachable from the cloud; local development uses an explicit test-only local mode. The intended public demo base is the developer-hosted preview URL. Never invent a public base URL.

**Q13. Security controls (planned; must be tested before public deploy)** — Redirect allowlist, private/reserved-address + metadata block, pinned public IP proxy. Do not claim a sandbox isolation guarantee.

**Q14. Privacy caveats** — Reports are anonymous and accessed via unguessable **opaque report IDs** — anyone holding the ID can retrieve the report (capability). API enforces 24-hour expiration; storage cleanup may be asynchronous. No credentials collected. No report-listing dashboard. DOM snippets are untrusted, best-effort redacted, and may reach the host model.

**Q15. Published evidence** — No invented public base URL, real findings, metrics, or production claims. Use placeholders until measured.

**Q16. Proof of the loop (required)** — Real SDK-client + HTTP + OpenCode calls are required. The fixture source-repair → **same-URL redeploy** → readiness → `verify_fixes` → behavior-check loop is the core story. Switching URLs is not repair evidence.

**Q17. Agent instruction limits** — The coding agent may attempt at most **three repair batches**; must inspect ambiguities; must not delete content or weaken rules; full-pass wording matches the PRD verbatim.

**Q18. OpenCode MCP config** — Use the current `mcp.servers` schema: `type: "remote"`, `url: "<BASE>/mcp"`, `oauth: false` (not older direct `mcp` entries). This addendum does not edit the actual opencode config.

**Q19. Repository ownership** — Backend source owns the root package; frontend owns `web/`; DevOps owns deployment docs. Document only commands that actually exist; mark unverified scaffolding as such.

**Q20. Stand-up posture** — Runtime tests/docs carry clear placeholders. Pending facts (real base URL, findings, dependency versions) are listed for replacement once integration is verified.

---

# Accessibility Companion MCP Product Requirements Document

Version: 1.0  
Decision date: 24 October 2026  
Audience: OpenCode orchestrator and implementation agents  
Delivery constraint: 180 minutes, including installation, debugging, verification and demo preparation  
Product format: local MCP server for an existing coding agent  
Initial host: OpenCode on Arch Linux; other MCP hosts are subsequent compatibility targets  
Problem statement: PS-32 Website Accessibility Audit Assistant, Tech Yuva Buildathon

## 0. Read this first

Build a working developer tool. The primary deliverable is a local MCP server that scans a running development page for six common categories of accessibility problems, returns structured evidence and repair guidance, and rescans after the developer's coding agent changes the source.

The server performs deterministic checking using an established accessibility engine. The host coding agent supplies reasoning and edits the repository through its existing tools. The product requires no separate LLM account, API key, database, cloud infrastructure or browser MCP server.

Read the entire P0 contract before implementation. Begin work after a short preflight; do not spend the build window producing another elaborate plan. Preserve existing repository instructions and unrelated work. Make routine implementation decisions autonomously. Ask only about blockers that cannot be resolved from the repository or environment.

This is the authoritative MVP specification. Earlier discussion about dashboards, task journeys, keyboard replay, agency handover workspaces and autonomous fixes is superseded by this narrower developer-tool scope. The prior optional selector-scope argument is deferred: P0 scans full pages, including document-level language checks.

Mandatory principles:

- A tool error, missing browser, failed navigation, empty scan or inconclusive result must never become a pass.
- A passing result applies only to the selected checks, rendered page state and recorded scan conditions.
- The MCP server does not write application source files. OpenCode makes repairs.
- MCP tool availability is not enforcement. Agent instructions establish the default loop; optional host hooks or CI can enforce it later.
- Preserve application behavior and meaningful content when repairing accessibility.
- A repair suggestion is not evidence of a repair. Run the checker again.
- Build the two-tool loop before adding features.
- Do not introduce a dashboard, cloud service, new LLM orchestration framework or generalized browser agent.

## 1. Product definition and positioning

### 1.1 Product promise

A lightweight, local accessibility companion for coding agents that checks generated interfaces for common accessibility problems, returns actionable evidence, and verifies repairs before the agent finishes its task.

During generation means after meaningful UI edit batches and before final completion. It does not mean inspecting every output token, intercepting editor writes or guaranteeing continuous conformance.

### 1.2 Initial differentiation hypothesis

Combine simple local onboarding, a small documented check set, compact agent-readable findings, context-aware repair instructions and a trustworthy rescan loop. Reuse the developer's existing coding model rather than operating a separate AI remediation service.

This is a positioning hypothesis, not a claim of exclusive technology. Deque already offers an accessibility MCP server with analysis and remediation [S2]. Do not market the project as the first accessibility MCP, universally better than existing scanners, or capable of complete certification.

### 1.3 Primary user and buyer hypothesis

Primary user: a frontend developer using OpenCode to generate or modify web UI. Secondary user: a QA engineer or small agency technical lead reviewing that work. Potential buyer: an agency or small development team that repeatedly ships client interfaces without a dedicated accessibility specialist.

Beneficiaries: people who encounter barriers using those interfaces, including users of screen readers, magnification and alternative input methods. Beneficiaries and paying customers are different roles.

The immediate job: identify common errors while the relevant code is still in the agent's context, make targeted repairs and provide evidence of the result. Willingness to pay and long-term differentiation remain unvalidated.

## 2. Problem evidence and interpretation

WebAIM's February 2026 automated study of one million popular homepages reported detectable WCAG failures on 95.9% of pages and an average of 56.1 detected errors per page. The six categories below accounted for 96% of the errors detected by its WAVE-based analysis [S1]:

| Category | Sampled homepages affected |
| --- | ---: |
| Low text contrast | 83.9% |
| Missing image alternative text | 53.1% |
| Missing form labels | 51.0% |
| Empty links | 46.3% |
| Empty buttons | 30.6% |
| Missing document language | 13.5% |

These statistics justify prioritization. They do not imply our axe-based subset will detect 96% of all accessibility barriers, that every affected page is unusable, or that our tool establishes legal compliance. Automated checks cover a subset of accessibility; meaningful alternatives, reading order and complex interaction behavior can still require human review [S3, S4].

## 3. Outcomes and success measures

### 3.1 P0 product outcomes

1. An existing OpenCode installation discovers and calls both MCP tools.
2. A real browser scan identifies deliberately seeded problems across all six categories.
3. Findings provide enough evidence for the host agent to locate relevant application code.
4. The agent repairs the sample through its normal editing tools.
5. Verification rescans the actual page and accurately reports current findings and baseline changes.
6. An error or inconclusive scan is distinguishable from a successful clear result.
7. The complete loop works without an additional inference API key.

### 3.2 Measurements

Record scan duration, engine version, selected rules, findings by rule, affected-element counts, review counts and verification outcome. Report actual measured values.

Engineering targets, subject to measurement: one healthy local fixture scan normally completes within 15 seconds on a warm browser; an individual invocation is bounded to 45 seconds; one browser process and one scan at a time. These are implementation targets, not published performance claims.

The demo's success metric is an evidenced repair loop, not a fabricated accessibility percentage, estimated lost revenue or claim of universal usability.

## 4. Scope and priority

| Priority | Required scope |
| --- | --- |
| P0 | Local stdio MCP server; two tools; full-page localhost scans; six issue categories; evidence normalization; repair guidance; immutable local scan records; baseline comparison; OpenCode config example; host instruction snippet; flawed/corrected fixture; meaningful automated checks; runnable demo documentation |
| P1 only after P0 passes | Small CLI wrapper using the same engine; richer Markdown report; a second viewport; optional local source revision metadata; screenshots |
| Deferred | File watching, automatic edit interception, mandatory host hooks, CI setup, public remote MCP, arbitrary remote website scanning, custom authentication flows, session import, scoped scans, multi-route crawling, dashboards, issue trackers, repository-wide source mapping, automatic patch application, keyboard journey testing, screen-reader emulation, mobile apps |

No feature may be silently substituted with a mock to claim P0 completion. If time is exhausted, document unfinished functionality and preserve the working path.

## 5. Functional requirements

| ID | Requirement | Evidence required |
| --- | --- | --- |
| FR-01 | Expose exactly audit_page and verify_fixes through local stdio MCP | Real client discovery and calls |
| FR-02 | Scan a rendered, supported local page using Playwright and axe | Results derived from engine output |
| FR-03 | Restrict checks to the configured P0 rule set | Rule list and engine version in each run |
| FR-04 | Return node-level findings, review items and concise repair guidance | Validated response contract |
| FR-05 | Save each completed scan under a unique run identifier | Run can be loaded by verification after server restart |
| FR-06 | Verify against a saved baseline using comparable conditions | Fresh scan plus explicit comparison |
| FR-07 | Distinguish errors, findings, clear results and review requirements | Negative tests |
| FR-08 | Preserve engine incomplete results | Review items surfaced; no unconditional pass |
| FR-09 | Bound duration and browser resources | Timeout and cleanup checks |
| FR-10 | Supply tested OpenCode configuration and generation-loop instructions | Actual connected-host demo |
| FR-11 | Keep application source modification in the coding agent | Server exposes no application write or shell tool |
| FR-12 | Report supported scope and limitations in every run | Machine-readable coverage plus human-readable summary |

## 6. Supported checks and repair policy

Six product categories map to eight initial technical rule identifiers. Verify these identifiers against the installed axe version at startup. If a required rule is unavailable, fail with RULESET_UNSUPPORTED rather than silently reducing coverage.

| Category | axe rule IDs | Required repair guidance and limits |
| --- | --- | --- |
| Text contrast | color-contrast | Use rendered foreground/background evidence and engine threshold information. Suggest an appropriate color/token adjustment; rescan. Preserve visual hierarchy. Gradients, images and ambiguous backgrounds can require review. |
| Image alternatives | image-alt | Determine whether the image conveys information, performs an action or is decorative. Use meaningful context-dependent alternatives; an empty alternative is appropriate only for confirmed decorative images. Never replace every missing alternative with a filename or generic word. |
| Form labels | label; select-name | Prefer a visible label correctly associated with the control; use another appropriate accessible-name mechanism when context warrants it. Placeholders alone are insufficient repair guidance. Preserve IDs, validation and submission behavior. |
| Link names | link-name | Provide an accessible name describing the destination or purpose using available context. Preserve the destination. Do not replace every link with generic text or hide necessary content. |
| Button names | button-name | Provide a meaningful name describing the action. Prefer visible text; icon-only controls may need an appropriate accessible name. Preserve action and form behavior. |
| Document language | html-has-lang; html-lang-valid | Declare a valid language based on actual page content and project locale. Do not hard-code English without evidence. Mixed-language passage handling is outside this initial set. |

Adding select-name and html-lang-valid closes small adjacent gaps while retaining six bounded categories. Do not describe this as exhaustive form or language accessibility coverage.

### 6.1 Relevant standards information

Attach WCAG tags and authoritative help URLs from the actual installed engine output rather than maintaining a guessed success-criterion mapping. Text contrast generally requires 4.5:1 for ordinary text and 3:1 for large text, subject to WCAG exceptions [S5]. Delegate measurement and applicability to the engine.

### 6.2 Unsafe shortcuts the host instruction must forbid

- Deleting offending controls or text solely to make findings disappear.
- Hiding content, setting aria-hidden on necessary UI, suppressing findings or disabling rules to obtain a clear result.
- Adding generic accessible names such as button, link or image.
- Applying arbitrary language codes or treating valid syntax as proof of correct language.
- Replacing all image alternatives with empty strings.
- Changing destinations, button types, handlers, validation, submission or layout behavior without justification.
- Claiming a scan proves keyboard access, screen-reader usability or complete WCAG conformance.

When intent is ambiguous, the coding agent should inspect nearby text, existing locale files, component usage or project requirements. If ambiguity remains material, ask the developer and leave the finding/review item unresolved.

## 7. Architecture and implementation defaults

Use one small TypeScript/Node package. Choose the installed supported Node runtime and a compatible official MCP SDK generation. Current official documentation contains distinct SDK generations; do not combine imports from one generation with examples from another [S7]. Pin the working dependencies in the lockfile and record versions.

Dependencies should be limited to the official MCP server SDK, a compatible validation library if required, Playwright, @axe-core/playwright, TypeScript/build tooling and a small test runner. Reuse installed tools where suitable. Do not add a web framework or database.

Modules:

| Module | Responsibility |
| --- | --- |
| MCP transport adapter | Register tools, validate input and serialize results |
| Scan engine | Browser context, navigation, readiness, axe invocation and result collection |
| Rule registry | Required IDs and fixed deterministic repair guidance |
| Normalizer | Convert rule/node results to bounded product findings |
| Run store | Safe immutable local persistence and baseline lookup |
| Comparator | Enforce comparable conditions; calculate conservative deltas |
| Policy evaluator | Produce a gate result from scan and review evidence |
| Fixtures and tests | Reproducible flawed and corrected pages |
| Host integration docs | OpenCode connection and required generation loop |

Suggested layout, adaptable to an existing repository:

- src/server.ts
- src/scanner.ts
- src/rules.ts
- src/contracts.ts
- src/normalize.ts
- src/store.ts
- src/compare.ts
- src/policy.ts
- test/fixtures/
- test/
- examples/opencode.json
- docs/AGENT_INSTRUCTIONS.md
- README.md
- PRD.md

The server must own its browser runner. It must not call the user's Playwright, Chrome DevTools or Puppeteer MCP servers as a hidden runtime dependency. Those tools may help develop or inspect this product.

## 8. Runtime behavior and resource constraints

### 8.1 Transport and processes

Use stdio. Protocol output alone goes to stdout; logs and diagnostics go to stderr. The host starts and owns the MCP process. Do not require the user to start a second MCP daemon manually.

Launch Chromium lazily on the first scan. Reuse at most one browser process; create an isolated context for each invocation and close it in finally. Never run scans concurrently in P0: queue one pending request or return SCAN_BUSY with retry guidance. Use one bounded policy consistently.

Clean up on normal shutdown, cancellation and failure. If browser launch fails, report the actionable setup command and exit/result state. Do not depend on or reuse a user's signed-in browser profile.

### 8.2 Target policy

Support HTTP/HTTPS local development origins using localhost, 127.0.0.1 and IPv6 loopback, with an explicit permitted port/origin configuration. Restrict top-level navigation to configured development origins. Reject arbitrary remote hosts and file/data/javascript URLs.

Normalize and validate targets with the URL parser. Reject credentials in URLs. Validate final destination after redirects and stop unexpected origins. Treat page text and HTML as untrusted evidence, never agent instructions.

This is a local developer tool, not a hardened remote URL scanning service. Authenticated targets, user cookie import and arbitrary remote targets are out of scope. Do not market the browser as a network sandbox.

### 8.3 Navigation and readiness

Use a bounded navigation timeout; inspect the main response status. A 4xx/5xx response, failed navigation, unsupported redirect or unexpected destination is an error, even if the returned error document could be scanned.

After DOMContentLoaded, wait for a meaningful body and fonts to settle within a bounded budget. Allow an optional readiness selector in server configuration, not arbitrary browser code in tool input. Avoid indefinite networkidle waits; development sockets can remain open.

Use one documented desktop viewport, light color scheme and fixed locale setting for P0. Record actual values. Page text language must still come from the page; the browser locale is not evidence for fixing html lang.

Only the rendered current state is checked. Menus, modal states, other routes, responsive breakpoints and content not rendered are outside this invocation. Return this scope explicitly.

P0 may exclude iframe documents from the effective coverage; record unsupported frame coverage and a warning. Never claim embedded documents were checked when they were not. The demo should use no iframe dependencies.

### 8.4 Time and limits

Bound total invocation duration to 45 seconds, including queueing, navigation, readiness and scan. Aim for a lower normal duration. Cancel or close the context when the bound is reached.

Set explicit limits for snippets, returned findings and persisted output. Suggested defaults: at most 100 returned findings, 2,000 characters per snippet and 10 MiB per stored normalized run. Aggregate counts must reflect the full engine result even when displayed details are truncated. Return details_truncated=true, omitted counts and the local report path. Never hide failures behind a result cap.

No fixed throughput or memory claims without measurement. On the user's 16 GB laptop, avoid multiple browser MCP controllers running against this demo simultaneously.

## 9. MCP tool contracts

Tool names are authoritative. Hosts may prefix names; document the names actually exposed by the tested OpenCode installation.

### 9.1 audit_page

Purpose: perform a fresh complete P0 scan of a local development page and persist its result.

Input JSON Schema:

~~~json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "HTTP or HTTPS URL on an explicitly permitted local development origin."
    }
  },
  "required": ["url"],
  "additionalProperties": false
}
~~~

Return the normalized ScanRun on success. A scan containing violations is a successful tool execution with gate=fail; it is not an MCP execution error.

### 9.2 verify_fixes

Purpose: load an existing baseline, perform a fresh scan of the same target under matching conditions, and compare the evidence.

Input JSON Schema:

~~~json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "The same target URL used for the saved baseline."
    },
    "baseline_id": {
      "type": "string",
      "description": "Opaque run ID returned by a previous successful audit_page call."
    }
  },
  "required": ["url", "baseline_id"],
  "additionalProperties": false
}
~~~

Load baselines only by validated opaque ID from the configured run directory. Never interpret baseline_id as a filesystem path. Return VerificationResult or a structured error. No baseline replacement or silent reset.

### 9.3 MCP envelopes

Return structured content conforming to the advertised output schema where supported by the chosen SDK/client. Include a compact equivalent text summary for host readability and compatibility. Both representations must agree.

Use isError=true for operational failures. Include error code, safe explanation and recovery advice. Expected accessibility failures remain normal tool results with explicit gate status.

Tool descriptions should tell the coding agent when to invoke each tool, how to use the baseline and how to interpret incomplete results. Keep descriptions compact to avoid wasting host context.

## 10. Normalized data contract

The following types define semantics. Implementation may use equivalent validated schemas; do not omit important fields or change gate meaning.

~~~typescript
type Gate = "pass" | "fail" | "review_required" | "not_evaluated";
type Impact = "minor" | "moderate" | "serious" | "critical" | null;

type Finding = {
  id: string;
  rule_id: string;
  impact: Impact;
  description: string;
  help: string;
  help_url: string;
  wcag_tags: string[];
  targets: string[];
  html: string;
  failure_summary: string | null;
  guidance: string;
  guidance_source: "rule_registry";
  requires_context: boolean;
};

type ReviewItem = {
  rule_id: string;
  targets: string[];
  reason: string;
  html: string | null;
};

type ScanRun = {
  schema_version: "1.0";
  run_id: string;
  execution: "completed";
  started_at: string;
  completed_at: string;
  duration_ms: number;
  requested_url: string;
  final_url: string;
  page_title: string;
  conditions: {
    viewport: { width: number; height: number };
    color_scheme: "light";
    browser_locale: string;
    readiness_selector: string | null;
    scope: "full_page";
  };
  engine: {
    axe_version: string;
    playwright_version: string;
    rule_ids: string[];
    ruleset_fingerprint: string;
  };
  coverage: {
    categories: string[];
    evaluated_rule_ids: string[];
    inapplicable_rule_ids: string[];
    incomplete_rule_ids: string[];
    current_rendered_state_only: true;
    frame_coverage: "main_document_only";
  };
  counts: {
    violation_rule_count: number;
    violation_node_count: number;
    incomplete_node_count: number;
    returned_finding_count: number;
    omitted_finding_count: number;
  };
  findings: Finding[];
  review_items: ReviewItem[];
  gate: Gate;
  details_truncated: boolean;
  report_path: string;
  warnings: string[];
  limitations: string[];
};
~~~

If frame handling includes more than the main document, amend the coverage enum accurately before shipping; do not leave a contradictory constant.

A finding represents one rule/node instance, not an entire rule with all nodes hidden in a single count. Preserve multi-part target paths without pretending every part is a standalone CSS selector. Maintain raw engine target structure internally if necessary.

Guidance is fixed deterministic rule guidance, explicitly distinguished from host-model suggestions. The server does not pretend it generated a semantically verified patch.

Run IDs are immutable opaque identifiers. Timestamps are UTC ISO 8601. No custom accessibility score is required.

## 11. Gate semantics and truthful coverage

Evaluate in this order:

1. Operational failure: return an error result, with no successful ScanRun or pass gate.
2. An unusable/empty target or no meaningful evaluation: gate=not_evaluated.
3. Any selected-rule violation: gate=fail, regardless of also having review items.
4. No violations but any engine incomplete results or unresolved required review: gate=review_required.
5. Successful meaningful evaluation, no selected-rule violations and no required review: gate=pass.

An inapplicable image or button rule is normal when the page contains no relevant elements. A meaningful page with no images can pass selected checks; it cannot be described as having had its images verified. Document-level checks should still be evaluated. All expected rule outcomes must be accounted for as evaluated, incomplete or inapplicable; unexpected missing outcomes cause not_evaluated or a ruleset error.

For pass, the exact human-readable claim is:

"No violations detected by the selected automated checks on the tested page state. Other accessibility requirements and semantic correctness may still need manual review."

If details are truncated, calculate the gate from all findings, not just those returned to the host. Retain incomplete results. Do not upgrade review_required to pass because the agent says the design looks acceptable.

A pass is historical evidence at completed_at. Subsequent code changes require another scan. P0 has no automatic file-watcher freshness guarantee. The agent must call verification after the final UI edit and reference that run ID in its completion message.

## 12. Baseline comparison and repair verification

### 12.1 Comparable conditions

Require identical canonical target URL, configured scope, viewport, color scheme, browser locale, readiness policy, rule IDs, ruleset fingerprint and relevant engine version. Strip URL fragments for this single-state P0 contract; preserve query parameters. Do not silently compare unrelated routes or environments.

Reject incompatible baselines with BASELINE_INCOMPATIBLE and explain the differing conditions. A user must intentionally create a new baseline after an engine/rule change.

### 12.2 Conservative delta semantics

Use a stable fingerprint over rule ID and normalized engine target path for unchanged elements. Assign stable IDs to demo elements so fixture comparisons are reproducible. This is practical matching, not guaranteed source/component identity.

Return:

- remaining: matching findings detected again.
- newly_detected: current findings with no matching prior fingerprint.
- no_longer_detected: baseline findings absent from the fresh scan.
- uncertain: comparisons affected by missing/replaced targets or ambiguous matching.

Do not label every absent finding fixed. An element can disappear because it was removed, hidden, renamed or moved. Where an old target can still be located and the relevant current engine result supports a pass, record additional evidence. Otherwise say no_longer_detected and identify the limitation.

For P0, the essential proof is the fresh current-page scan plus honest deltas. Generic source-level repair proof, visual preservation and application behavior require host tests/human review. Do not expand into a source-map system.

### 12.3 VerificationResult

~~~typescript
type VerificationResult = {
  schema_version: "1.0";
  baseline_id: string;
  current_run: ScanRun;
  comparison: {
    comparable: true;
    remaining_ids: string[];
    newly_detected_ids: string[];
    no_longer_detected_ids: string[];
    uncertain_baseline_ids: string[];
    notes: string[];
  };
  gate: Gate;
  completion_claim: string;
};
~~~

The verification gate must be at least as restrictive as current_run.gate. Uncertain disappearance of a baseline issue requiring behavior confirmation yields review_required if the scan would otherwise pass. A newly detected selected-rule violation yields fail. Historical delta counts never override current findings.

## 13. Error contract

~~~json
{
  "execution": "failed",
  "error": {
    "code": "TARGET_UNREACHABLE",
    "message": "The configured development page could not be loaded.",
    "recoverable": true,
    "next_action": "Start the application and retry the same URL."
  }
}
~~~

Required error cases:

| Code | Trigger |
| --- | --- |
| INVALID_ARGUMENT | Bad URL, invalid baseline ID, extra unsupported input or invalid schema |
| TARGET_NOT_ALLOWED | Unsupported host/scheme/origin, embedded credentials or unexpected redirect |
| TARGET_UNREACHABLE | Connection refusal, navigation failure or main response error |
| TARGET_NOT_READY | Readiness condition cannot be met |
| BROWSER_UNAVAILABLE | Browser binary/dependency unavailable |
| SCAN_TIMEOUT | Invocation exceeded its bound |
| SCAN_BUSY | Concurrency bound exceeded, if rejecting rather than queueing |
| SCAN_FAILED | Engine/browser failed unexpectedly |
| RULESET_UNSUPPORTED | Required rule unavailable or cannot be accounted for |
| BASELINE_NOT_FOUND | No valid saved run exists for the ID |
| BASELINE_INCOMPATIBLE | Conditions differ or baseline is not valid for comparison |
| REPORT_WRITE_FAILED | Required persistence failed; no recoverable baseline was produced |

Redact sensitive incidental details from error messages. Never output fabricated baseline IDs after a persistence error. A failed scan cannot be selected as a baseline.

## 14. Persistence and evidence handling

Use a configured local report directory, defaulting to a clearly documented project-local .accessibility-mcp/runs directory under a resolved absolute project path. Do not assume the MCP launch working directory matches the application repository.

Persist normalized JSON, including enough full findings for inspection, with atomic writes and immutable IDs. Keep reports out of Git by default. If optional Markdown reports are added, generate them from the same saved JSON.

For the demo, the local JSON run file is sufficient evidence; no database is needed. Baseline loading must work after server restart.

Avoid collecting form values, cookies, authorization headers, storage snapshots or full browsing profiles. Store necessary HTML evidence only; redact input values and obvious token-bearing attributes. Warn that DOM snippets can still contain application content and that the host agent may send tool results to its configured cloud model. Do not claim that local execution means nothing ever leaves the computer.

Write artifacts only under the configured report directory. No recursive repository scanning, arbitrary filesystem read API or terminal execution API belongs in this server.

## 15. Host coding-agent workflow

Supply a concise instruction snippet for a project's existing agent instructions. Do not replace an existing AGENTS.md wholesale or modify the user's global OpenCode configuration without an explicit reason. Merge project-local configuration carefully.

Required host behavior:

1. Read the supported accessibility rules before creating UI.
2. Start or locate the relevant local development server.
3. After a meaningful UI edit batch, call audit_page on the relevant route and retain run_id.
4. Inspect the returned selectors/snippets in the actual source using normal repository tools.
5. Repair violations while preserving user intent, handlers, navigation, validation and layout behavior.
6. Run relevant existing behavior checks.
7. Call verify_fixes after the edits against the retained baseline.
8. If failures remain, make another targeted repair and rescan. Limit automatic repair attempts to three batches.
9. If progress stalls or intent is ambiguous, report the blocker and review requirement. Never hide the finding or weaken the rules.
10. After the final relevant edit, record the latest scan ID, tested URL, selected coverage and outstanding review items in the final response.

The server should not enforce this by demanding an external inference key or initiating its own agent loop. OpenCode's existing model performs the reasoning.

## 16. OpenCode connection example

Provide a generated example using the actual absolute built entrypoint and report directory after implementation. The following is a template; replace the angle-bracket values before use:

~~~json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "accessibility-companion": {
      "type": "local",
      "command": ["node", "<absolute-project-path>/dist/server.js"],
      "enabled": true,
      "environment": {
        "ACCESSIBILITY_REPORT_DIR": "<absolute-project-path>/.accessibility-mcp/runs",
        "ACCESSIBILITY_ALLOWED_ORIGINS": "http://127.0.0.1:4173,http://localhost:4173"
      }
    }
  }
}
~~~

OpenCode documents local servers under mcp with type=local, a command array and optional environment [S6]. Check the user's installed version before applying configuration. Use that version's schema. Do not reuse ZCode or Claude configuration shapes.

Do not rely on shell expansion of tilde inside a command array. Use absolute paths. Do not print secrets while inspecting configuration. Preserve existing model/provider settings, MCP entries, agent permissions and backups.

The host may prefix tool names. Observe actual discovery and document real invocation names. Adding a configuration file alone does not prove tool connectivity.

## 17. Demo fixture and acceptance evidence

Use a small, locally served registration page with fixed element IDs and no external service dependencies. HTML or a lightweight existing frontend is sufficient. A full React application is unnecessary unless already scaffolded.

Seed at least one real example of each issue category:

- A low-contrast paragraph on a plain solid background.
- An informative image without its required alternative.
- A form input without a programmatic label.
- An icon link without an accessible name.
- An icon button without an accessible name.
- A missing document language declaration.

Include a select control to exercise select-name if time allows. An invalid language declaration should separately exercise html-lang-valid. Serve a local image asset with stable dimensions; ensure fixtures actually render so the scanner can inspect them.

Keep fixture alternatives semantically clear. Supply source context describing the icon actions, image purpose and page locale so the agent can make justified repairs. Provide expected rule IDs and engine-derived assertions, not guessed exact findings counts that may vary by version.

Maintain a flawed fixture and a known-corrected reference. The public demo must show the coding agent modifying the flawed fixture's source and verifying the same URL. Merely switching the URL to a prepared corrected page is a scanner test, not proof of the agent repair loop.

Application behavior checks: fields remain usable, submit action still executes, links retain their destinations and required content remains visible. These checks complement the selected automated rules.

## 18. Acceptance criteria

P0 is complete only when all applicable criteria have evidence:

| ID | Acceptance criterion |
| --- | --- |
| AC-01 | A real MCP client initializes the server and lists exactly the two intended tools |
| AC-02 | OpenCode calls audit_page and receives a genuine engine-derived result |
| AC-03 | The flawed fixture produces findings spanning all six categories |
| AC-04 | Corrected fixture passes selected checks with accurate coverage language |
| AC-05 | A fresh verification call detects remaining problems after a partial repair |
| AC-06 | Introducing a new selected-rule issue yields newly_detected and gate=fail |
| AC-07 | Unknown/incompatible baselines produce explicit errors, never a pass |
| AC-08 | Missing page, stopped server, browser failure and timeout have useful errors |
| AC-09 | Engine incomplete results yield review items and prevent unconditional pass |
| AC-10 | A subsequent edit requires a fresh run; final agent response cites that run |
| AC-11 | Run records remain loadable after restarting the MCP server |
| AC-12 | Unexpected target origins and path-like baseline IDs are rejected |
| AC-13 | Actual source edits repair the same demo URL; behavior checks still pass |
| AC-14 | Documentation distinguishes selected-check clearance from full accessibility |
| AC-15 | Runtime scans require no other MCP server or additional inference key |
| AC-16 | stdout remains protocol-clean and browser contexts are cleaned up |

If real OpenCode access is unavailable during implementation, prove transport with an actual SDK client and mark AC-02 as unverified. Do not claim connected-host success from an inspector-only test.

## 19. Verification strategy

Use a compact meaningful test set rather than broad implementation-mirroring tests.

Unit/contract checks:

- Gate matrix: findings, review-only, clear meaningful scan, empty/non-evaluated scan and operational error.
- Comparator: unchanged issue, repaired stable target, new issue, disappeared target and incompatible conditions.
- Target/baseline validation: unsupported origins, redirect, bad URL, malformed ID and traversal attempt.
- Serialization: normalized schemas, count consistency and truncated-output gates.

Browser integration checks:

- Real flawed fixture exposes expected category rules.
- Real corrected fixture has no selected violations.
- Partial repair remains failed; a new problem is detected.
- Bad route/response and stopped local server cannot pass.
- Browser context closes after success and failure.

Use synthetic normalized engine output only for deterministic cases that are difficult to force in a browser, such as a specific incomplete-result gate. Clearly distinguish those unit tests from real browser evidence.

Protocol check: spawn the built server through a real MCP client, initialize, list tools, call both and shut down. Avoid relying solely on direct function tests.

End-to-end demo: OpenCode performs a real repair batch against the sample. Save concise evidence of tool calls, source diff, final scan and behavior checks. Do not save unrelated personal browser screenshots.

## 20. Delivery plan with a strict 180 minute ceiling

| Elapsed time | Owner and deliverable | Exit condition |
| --- | --- | --- |
| 0-15 min | Orchestrator preflight; select compatible SDK, confirm browser and scaffold | Minimal MCP tool call and real fixture scan each work |
| 15-50 min | Engine worker builds scan/rules/normalization; integration worker builds contracts/server/store | audit_page returns and persists real findings |
| 50-85 min | Integrate; implement baseline comparison and verify_fixes | Two-tool loop operates on partial/corrected fixtures |
| 85-115 min | Connect actual OpenCode; create instruction snippet; perform repair loop | Agent changes source and obtains a fresh result |
| 115-145 min | Tester/reviewer checks gates, errors, comparison and behavior | Important failures fixed; no misleading pass |
| 145-165 min | Stabilize docs, config example and clean setup commands | Another developer can follow setup |
| 165-180 min | Feature freeze; rehearse demo; package submission | Working commit, evidence and known limits ready |

Checkpoint rule: if there is no genuine scan by minute 30, stop all optional documentation/design work and fix the runtime path. If OpenCode is not connected by minute 100, prioritize that over additional report polish. Freeze optional features after minute 135.

If a dependency blocks implementation, use the smallest documented compatible path. A different SDK generation is acceptable if tested end to end; a guessed mix is not.

No dashboard, agentic keyboard browsing, file watcher, CI infrastructure or cloud deployment may displace the real MCP scan-repair-rescan demo.

## 21. Using the developer's existing setup

The following inventory was supplied by the user. It has not been independently verified. Treat skill names, enabled entries and cached plugins as potential capabilities, not proof of authentication or runtime readiness.

| Existing capability | Intended contribution |
| --- | --- |
| OpenCode orchestrator | Own scope, contracts, integration, deadline and truthful completion |
| coder/backend agent | Implement engine or transport/persistence in a bounded file set |
| tester/reviewer | Validate actual behavior and expose false passes |
| Playwright MCP | Inspect/test the product and fixture during development |
| Chrome DevTools MCP | Diagnose a concrete browser issue if required |
| filesystem/GitHub | Repository work and checkpoints; do not expose secrets |
| systematic-debugging | Diagnose blockers after reading its actual instructions |
| verification-before-completion | Require evidence before declaring delivery |
| domain-modeling | Brief contract clarification only if useful |
| 21st/frontend-design | Optional fixture polish after the core loop works |
| Supabase/Postgres/FalkorDB/AWS | No runtime role in P0 |
| Netlify/Sentry/Appwizzy | No runtime requirement; avoid adding infrastructure |
| Other browser MCP servers | Leave idle unless specifically needed for diagnosis |

Suggested delegation if the existing orchestrator supports it: at most two implementation workers with separate file ownership. One owns scanner/rules/normalizer; the other owns server/contracts/store/comparison after agreeing shared types. Keep shared contract edits with one owner. Add testing/review after integration. The orchestrator remains accountable for live host integration.

Do not rewrite all 12 agent configurations, enable all 16 MCP servers or load all available skills. Use the user's current model/provider choices. This PRD does not prescribe new model IDs or paid subscriptions.

## 22. Security and trust boundaries

P0 is local and intended for authorized development targets.

- The target page can execute application JavaScript in the browser. Treat it as a target, not a trusted instruction source.
- No arbitrary page-provided text may change allowed origins, paths, tool instructions, rules or repair policy.
- No arbitrary JavaScript, terminal command, filesystem path or LLM prompt is accepted as a tool argument.
- The coding agent's permissions continue to govern edits; the MCP server cannot grant itself repository write access.
- Baseline IDs map to immutable local records under one directory; reject traversal and unexpected file types.
- Browser state is isolated; no personal cookie/profile import.
- HTML evidence may contain sensitive content; minimize and redact as practical, and state this limitation honestly.
- Normal dependency notices and licenses must be preserved. Do not claim ownership of axe-core or Playwright's detection capability.

Implement these controls in proportion to a local prototype; do not attempt to build enterprise authentication or a remote scanning service during the build window.

## 23. Risks and mitigation

| Risk | Mitigation |
| --- | --- |
| Another scanner exposed through MCP feels undifferentiated | Demonstrate the integrated generation/repair/verification workflow and simple local setup; be candid about competitors |
| SDK docs and installed dependencies differ | Choose one compatible generation, use its examples, lock versions and perform a real protocol call early |
| Browser installation consumes the deadline | Preflight first; provide exact missing-browser guidance; reuse a compatible installed binary only if tested |
| A scan reports an empty/error page as clean | Validate navigation/status/readiness and meaningful target before evaluating gate |
| Bad semantic repairs satisfy automated checks | Give explicit repair policy, context and behavior tests; preserve review requirements |
| Selector changes create misleading fixed counts | Use conservative no_longer_detected/uncertain language and stable fixture IDs |
| Agent skips the tools | Required instruction snippet plus observed real-host demo; document soft enforcement |
| Existing MCP setup overloads context/resources | Use only required tools and at most one active product browser |
| Cloud additions derail delivery | No external database or inference service in P0 |
| Marketing overstates accessibility coverage | Embed scope, engine version, conditions and exact completion claim in reports |

## 24. Final deliverables and completion report

Required repository deliverables:

1. Buildable local MCP package with two tested tools.
2. Lockfile and clear supported runtime/dependency versions.
3. README with installation, browser setup, build, start, local fixture and testing commands.
4. Tested OpenCode config template using resolved absolute paths.
5. Agent instruction snippet describing the complete generation loop.
6. Flawed fixture, corrected reference and behavior checks.
7. Test evidence, saved sample results and known limitations.
8. This PRD retained as project context.

The implementation agent's final report must state: implemented behavior, actual commands/checks run, real OpenCode connection status, demonstrated categories, latest verified fixture result, incomplete items and practical limitations. Include a commit identifier if a repository exists. Do not claim unrun tests, unsupported compliance, production readiness or a novel detection engine.

The demo can run entirely locally. A hosted site and public package publication are not required to demonstrate the core product. Do not publish externally unless separately requested.

## 25. Demonstration script

Target duration: approximately three minutes.

1. Explain that the developer is using their existing coding agent and model.
2. Show the flawed local registration page and its source.
3. Ask OpenCode to improve the page while following the supplied accessibility instructions.
4. Observe audit_page return real findings across the supported categories.
5. Show the host agent make targeted source edits.
6. Observe verify_fixes rescan the same URL and report remaining/new/no-longer-detected findings honestly.
7. Confirm the registration behavior still works.
8. Show the final scan conditions, selected coverage and any manual-review limitations.
9. State the actual product value: accessibility feedback and repair verification during normal AI-assisted development.

Use measured results. If some issues remain, show that the tool reports them instead of hiding them. No prepared URL switch may be passed off as a repair.

## 26. Future work after the buildathon

Evaluate with developers before expanding: installation success, time to understand findings, successful repair rate, review quality and whether people rerun the tool after changes.

Potential extensions, subject to evidence: opt-in host hooks, CI exit codes, repository source mapping, contrast-token suggestions, additional page states, multi-route baselines, keyboard checks, component-level grouping, broader rules, portable MCP-host integration and team reporting.

Customer discovery should establish whether the product offers enough convenience over existing tools to drive repeat usage. No revenue projection or market-share assumption is part of this MVP.

## 27. Sources and implementation references

References checked on 24 October 2026. Product contracts and priorities above are project decisions. Third-party capabilities, package APIs and host configuration must be verified against the versions actually installed.

- S0. User-supplied Tech Yuva Buildathon Problem Statements Final, PS-32: check a sample webpage against selected accessibility rules, provide issue evidence and practical remediation suggestions.
- S1. WebAIM Million 2026, methodology and common error categories: https://webaim.org/projects/million/
- S2. Deque Axe MCP server, existing analysis/remediation and client integration: https://docs.deque.com/devtools-server/4.0.0/en/axe-mcp-server/
- S3. W3C, selecting evaluation tools and automation limits: https://www.w3.org/WAI/test-evaluate/tools/selecting/
- S4. Playwright, accessibility testing with axe and testing limitations: https://playwright.dev/docs/accessibility-testing
- S5. W3C, understanding minimum contrast: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- S6. OpenCode, local MCP configuration: https://docs.opencode.ai/docs/mcp-servers/
- S7. Official MCP TypeScript SDK documentation, choose the generation matching installed dependencies: https://ts.sdk.modelcontextprotocol.io/v2/ and https://ts.sdk.modelcontextprotocol.io/
- S8. MCP tools, invocation and structured results: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- S9. axe-core API reference, rule selection and result structures: https://github.com/dequelabs/axe-core/blob/develop/doc/API.md
- S10. axe rule descriptions, verify against the installed engine version: https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md

## 28. OpenCode kickoff instruction

Read this PRD completely and implement its P0 scope in this repository within a strict 180-minute budget. Start by inspecting existing instructions, files, runtime, browser availability and the installed OpenCode version. Spend no more than 10 minutes planning. Establish a real MCP tool call and genuine fixture scan early. Use compatible official SDK examples, Playwright and axe; lock working dependency versions.

Use the current model/provider setup. Delegate at most two implementation workers if useful, with separate file ownership and one owner for shared contracts. Keep runtime checking independent of other MCP servers. Implement audit_page and verify_fixes, trustworthy gates, local baselines, deterministic guidance, a realistic fixture, OpenCode integration instructions and meaningful verification. Keep code edits in the host agent. Preserve application behavior and report ambiguity.

Do not build a dashboard, cloud backend, additional LLM service, generalized repair agent or hidden mock. Do not weaken accessibility rules to pass. Test with a real MCP client and actual OpenCode if accessible. Show a source repair and rescan of the same page. Before declaring completion, run the required checks and report precise evidence, unfinished work and selected-check limitations.

