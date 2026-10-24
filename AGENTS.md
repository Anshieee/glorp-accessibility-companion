# AGENTS.md — Accessibility Companion (hosted hackathon demo)

**Hosted, anonymous hackathon demo. NOT production.** No login, no tenant auth, no certification or full-WCAG claims.

## Layout and authority
- Root package (`src/`, `test/`, `scripts/`, `deploy/`): backend HTTP API and remote MCP, sharing one engine.
- `web/`: React + TypeScript + Vite static frontend, served same-origin.
- `docs/AGENT_INSTRUCTIONS.md`: authority for the repair loop. Read it before any repair.
- `Accessibility_MCP_PRD.md`: the hosted addendum at the top supersedes the original local-only constraints. The rest of the PRD still applies.

## Architecture (preserve it)
- One engine (Playwright Chromium + `@axe-core/playwright`) serves `/api/v1/audits`, `/api/v1/verifications`, `/api/v1/runs/:run_id`, `/api/v1/config`, `/healthz`, and Streamable HTTP MCP at `/mcp`.
- MCP discovery must return exactly two tools: `audit_page(url)` and `verify_fixes(url, baseline_id)`.
- Eight axe rules in six categories: `color-contrast`, `image-alt`, `label`, `select-name`, `link-name`, `button-name`, `html-has-lang`, `html-lang-valid`.
- The server has no application-write or shell tool. Only the coding agent edits source.
- Never weaken the browser network allowlist, private/reserved-address or metadata guards, or redirect checks.

## Scan targets
- Allowed: our deployed registration fixture (editable; repaired at the same URL) and selected Indian government domains (read-only detection).
- Never edit, patch, or repair government source, and never imply a government site was fixed.
- No arbitrary remote, local, or private targets. Do not extend the allowlist without the developer.

## Repair loop (fixture only)
1. Read `docs/AGENT_INSTRUCTIONS.md` and the rule guidance before editing UI.
2. After a meaningful UI or fixture edit, call `audit_page` on the connected deployed URL and retain the `run_id` as baseline.
3. Inspect each finding's selectors and snippets in the actual source.
4. Fix the source, preserving handlers, IDs, navigation, validation, submission, destinations, and layout.
5. Run behavior checks: fields usable, submit still executes, links keep destinations, required content visible.
6. Redeploy to the SAME URL and wait for readiness. Never skip or fake the wait.
7. Call `verify_fixes(url, baseline_id)` on that same URL. Switching URLs is not repair evidence.
8. Make at most 3 repair batches in total. Then stop and report the blocker and unresolved findings.
9. Final response: latest scan run ID, tested URL, selected coverage, outstanding review items.

## Forbidden shortcuts
- Deleting controls or text to clear findings; hiding content; `aria-hidden` on necessary UI; suppressing findings or disabling rules.
- Generic accessible names (`button`, `link`, `image`) or filenames as alt text.
- Replacing all image alts with empty strings. Empty alt only for confirmed decorative images.
- Arbitrary language codes, or treating valid syntax as proof of the right language.
- Changing destinations, button types, handlers, validation, or layout without justification.
- Claiming a scan proves keyboard access, screen-reader usability, or WCAG conformance.
- Ambiguous intent: check nearby text, locale files, components, and requirements. If it stays material, ask the developer and leave the item unresolved. Do not guess a meaning-changing fix.
- The gate (`pass` / `fail` / `review_required` / `not_evaluated`) is authoritative. Never override `fail` or `review_required` because the design "looks fine".
- Pass wording, verbatim: "No violations detected by the selected automated checks on the tested page state. Other accessibility requirements and semantic correctness may still need manual review."

## Blockers
- If the target is not deployed or the MCP tools are not connected, report an explicit unverified blocker. Never fake a scan or claim verification.
- Do not autonomously deploy unrelated services.

## Testing (distinguish the layers in reports)
- Root: `npm run build` (tsc), `npm test` (Vitest, `test/**/*.test.ts`, single worker, no file parallelism).
- Frontend: `npm --prefix web run build` and `npm --prefix web run typecheck`.
- Evidence script: `node --test scripts/demo-evidence.test.mjs`.
- Dependencies: `npm audit` in the root and in `web/`.
- Unit tests use fakes (`test/fakes.ts`). E2E tests (`test/e2e.test.ts`) spawn `node dist/server.js` with real Chromium. Real OpenCode calls need a connected MCP session and are not run by these commands.
- Local manual startup only: `PORT=8097`. Port 8080 is held by an unrelated llama-server. Never kill it or any other user process.
- `ACCESSIBILITY_ALLOW_LOCAL=true` is for developer tests only. Never set it on Cloud Run.

## Secrets, cloud, and config
- Credentials stay outside the repo. Never commit `.env*` (except `.env.example`).
- Do not upload or paste `.agents/`, `.opencode/`, or `opencode.json` contents into shared artifacts.
- No cloud LLM and no inference key in this server. The OpenCode host model does all reasoning.
- GCP region `asia-south1` (Mumbai) is approved for dedicated demo resources. Provision or deploy only when asked.
- Docs must not contain personal emails or credentials. Use `<DEPLOYED_BASE_URL>`; never invent a public base URL.
- Report IDs are capabilities: anyone holding one can read the report (24-hour TTL). Do not echo them into public surfaces.
- Do not edit global OpenCode configuration. Project-local MCP setup needs explicit approval.

## Reporting and models
- Report only commands and results that actually ran. Use measured numbers only; otherwise mark them as placeholders.
- Future subagents: `opencode-go/muse-spark-1.3-contributor#high` (latest user preference). The orchestrator stays on GPT 6.1 Sol.
- This file covers this project's architecture only. It does not override the global AWS guidance for any AWS action.
