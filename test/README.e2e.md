# E2E integration test — Accessibility Companion (REAL browser + HTTP + remote MCP)

`test/e2e.test.ts` is the end-to-end proof for the approved hosted scope
(`Accessibility_MCP_PRD.md` addendum + `HACKATHON_TEAM_HANDOFF.md`). Everything is real —
no mocks, no scan-by-hand.

**Status: implemented and run — 15/15 passing against a healthy engine build** (the suite
was successfully executed end-to-end on 2026-10-24 ~14:18 IST, vitest 5.0.5). A later root
build delivered at 14:18:40 IST (engine-side edits to `src/scanner.ts` @14:13 and
`src/network.ts` @14:17) regressed real-browser scanning: every audit/verification now ends in
`SCAN_FAILED` ("page.evaluate: Target page, context or browser has been closed") — reported to
the orchestrator; details under "Known external blocker" below. Nothing in this suite was
weakened or masked because of it.

## Measured evidence (real runs, 2026-10-24)

- **Suite green proof run** (`npx vitest run test/e2e.test.ts`, 14:18:01 IST): **15 passed |
  0 failed**, wall time 4.10 s. On that same build (built 13:56 IST) earlier paced runs also
  measured real scans.
- **Measured scan durations** (real Chromium + axe 4.14.0 / Playwright 1.64.1, warm engine,
  ≈0.5–1.1 s per scan; console lines `[ac-e2e] scan <label> duration_ms=…` and an
  `afterAll` `[ac-e2e] scan-timing …` summary):
  - `http-audit` (HTTP `/api/v1/audits`, flawed fixture) **1006 ms**
  - `mcp-audit(baseline)` **529 ms**
  - `mcp-verify-*.fresh-scan` **512–1051 ms** across partial / new-issue / corrected states
- **Paced run under the shipped per-request scan budget** (env limiter at defaults, 14:11 IST):
  12 passed / 3 failed where the 3 fail-sides surfaced mid-budget `RATE_LIMITED`; the suite
  honors the documented `RATE_LIMITED` ("Wait 59 s and retry") with honest client pacing —
  measured pacing wait 61 s, then success. Note discovered while budget-tuning: the limiter
  counts **every** POST `/mcp` (initialize, tools/list, validation-error probing) against the
  same 12-per-window per-IP budget, not only real scans; the e2e child therefore runs with
  `ACCESSIBILITY_RATE_LIMIT_PER_IP=100` / `ACCESSIBILITY_RATE_LIMIT_GLOBAL=100` (limiter armed,
  budget generous) and the pacing helpers remain as a safety net.
- **Full-root aggregate same session** (`npm test`, vitest 5, one worker, no file
  parallelism): available in the requested aggregate reports; totals measured at
  189 tests / 180 passed / 9 failed (13:56 build; 9 engine-era mismatch fixes — all
  TEST-side, since applied, incl. the MCP `{run: …}` scan unwrap and rate-budget pacing) and
  then **224 tests / 215 passed / 9 failed** on the 14:18:40 build, where **all 9 remaining
  failures are the engine scan regression** (5 in this e2e file, 4 in `test/scanner.test.ts` —
  both engine code paths, not fixture/test issues).

## Known external blocker (engine-side, NOT a test issue)

After the engine worker's 14:13–14:18 changes (rebuilt dist at 14:18:40), **every real scan
fails** with an uncaught `Error: page.evaluate: Target page, context or browser has been
closed` inside `AxeBuilder.analyze` → surfaced as HTTP 500 `SCAN_FAILED`
("Unexpected server error while processing the request."). Reproduced identically via:
- this e2e suite (spawned `node dist/server.js`), and
- engine-owned `test/scanner.test.ts` (first four real-scan tests, deterministic), while
  scans that legitimately fail before axe-run (404, blocked redirect, SCAN_TIMEOUT, SCAN_BUSY)
  still behave as specified.

Controls ruled out with minimal reproducers (outside vitest, then in-vitest): NOT the browser
executable (both bundled Playwright Chromium and `/usr/bin/chromium` 154 behave the same), NOT
vitest worker pool/isolation settings (`forks`/`threads`, `--no-isolate` all identical), NOT
  resources/RAM limits (/dev/shm 7.7 G free, /tmp fine, 4.4 G RAM available), and a minimal in-vitest
Chromium+axe scan with engine-parity launch flags **passes** (7 violations on the flawed
fixture). The regression sits in the engine's post-navigation path (route-guard / init-script /
egress-proxy / injected axeSource interplay) and needs the engine worker's fix. Exact stderr
stack (server-spawn context), 2026-10-24 14:25 IST:

```
[http] unexpected error on POST /api/v1/audits: Error: page.evaluate: Target page, context or browser has been closed
  Please check out https://github.com/dequelabs/axe-core-npm/blob/develop/packages/playwright/error-handling.md
    at AxeBuilder.analyze (node_modules/@axe-core/playwright/dist/index.mjs:219:13)
    at async AccessibilityScanEngine.withBudget (dist/scanner.js:172:21)
    at async AccessibilityScanEngine.runScan (dist/scanner.js:624:28)
    at async AccessibilityScanEngine.scan (dist/scanner.js:291:20)
```

## Isolated fixture ownership (important)

- **e2e worker owns**: `test/e2e.test.ts`, `test/README.e2e.md`, and `test/e2e-fixtures/*`
  (`registration.html`, `registration-corrected.html`, `chart.png`,
  `repair-evidence.unit.mjs`).
- **Engine worker owns**: `test/fixtures/*`. For the record: `test/fixtures/registration.html`,
  `registration-corrected.html`, `chart.png` were first written by the e2e worker at
  ~13:15–13:21 before the ownership boundary was clarified; the suite no longer reads
  `test/fixtures/*` at all. The engine may restore/rewrite/delete those three files as needed —
  no further conflict is expected since the e2e suite reads **only** `test/e2e-fixtures/*`.

## How it is real

- **Real app server**: spawns `node dist/server.js` (repo root cwd) on a **dynamic localhost
  port** (the backend default port 8080 is never used here) with local-development-only env:
  `K_SERVICE` explicitly unset, `ACCESSIBILITY_ALLOW_LOCAL='true'`,
  `ACCESSIBILITY_ALLOWED_ORIGINS` = exact local fixture origin + exact server origin,
  `ACCESSIBILITY_REPORT_DIR` under a fresh `fs.mkdtemp('/tmp/opencode/ac-e2e-')`.
- **Real remote MCP**: the official `@modelcontextprotocol/sdk` `Client` +
  `StreamableHTTPClientTransport` over real HTTP to `<host>/mcp`. Discovery must return
  **exactly two tools** (`audit_page`, `verify_fixes`) with correct input schemas.
- **Real browser scan**: the app's engine scans a locally served, **mutable registration.html
  file** served by the test's own HTTP fixture server, always at the **same URL
  `/registration.html`** across on-disk source replacements (including the copy-in of the
  corrected reference — a same-file source replacement, never a URL switch).
- **Browser executable**: `ACCESSIBILITY_BROWSER_EXECUTABLE` = `process.env.BROWSER` or
  `/usr/bin/chromium` (dev-only; never on Cloud Run).

## Gate truthfulness (user-Q3 semantics, asserted)

From the corrected-reference verification:

- `remaining_ids` and `newly_detected_ids` must be empty.
- Every baseline finding id must appear in `no_longer_detected_ids ∪ uncertain_baseline_ids`.
- A **full `gate=pass` (and the verbatim PRD full-pass wording) is asserted ONLY when
  `uncertain_baseline_ids` is empty** — the corrected fixture preserves all stable element IDs
  and selector structure precisely so matching is certain.
- If any baseline id is `uncertain`, the verification gate **must be `review_required` — never
  `pass`** — and the completion claim must not use the full-pass wording. Likewise, if the
  fresh scan itself reports incomplete results (current-run gate `review_required`), the
  verification gate stays `review_required`; an engine-incomplete result can never upgrade to
  a pass (asserted in `test/e2e.test.ts`).
- On the certain-pass branch the suite additionally asserts **located pass-evidence notes**
  covering each `no_longer_detected` id (positive engine evidence, not silent disappearance).

The partial-repair and new-issue tests likewise require `gate=fail` (remaining findings
reported honestly; new unlabelled input detected as `newly_detected` targeting
`#new-extra-field`). No exact node-count assertions anywhere — honest accounting only:
six categories / eight rule IDs (`color-contrast`, `image-alt`, `label`, `select-name`,
`link-name`, `button-name`, `html-has-lang`, `html-lang-valid`) each accounted as violating,
evaluated, incomplete or inapplicable.

## Agent source repair evidence (mechanical, not a host claim)

`test/e2e-fixtures/repair-evidence.unit.mjs` is a standalone unit-style script (pure fs, no
server/browser/network, exit-1 on any failure) that replays the same on-disk repair chain on a
disposable copy of the fixture and emits a JSON evidence record with per-stage SHA-256 hashes,
asserting **the same file path** is edited throughout, stable IDs are preserved, and the
corrected reference carries every repair marker (lang, labels, aria-labels, valid contrast).
The e2e suite additionally asserts the on-disk readback (`sha256` before/after, stable IDs,
markers) as **actual source-repair evidence** — it does NOT claim a host/OpenCode
demonstration; that live host run is a separate step.

## What each test proves (15 tests, Vitest 5 `describe(name, { concurrent: false })`, 120 s per-test bound)

1. `/healthz` readiness of the spawned child (graceful ≤30 s child-local poll only).
2. HTTP `POST /api/v1/audits` flawed fixture → ScanRun envelope, `gate=fail`, report under
   `ACCESSIBILITY_REPORT_DIR`.
3. An allowlisted-origin target whose socket refuses connections → strict operational error
   envelope with `TARGET_UNREACHABLE` and **no pass**. (Observed backend mapping: genuine
   connection refusal returns HTTP **502** + the PRD error codes; policy/validation refusals
   stay 4xx. The test accepts the 5xx operational band for this case only.)
4. Remote non-allowlisted target (`*.invalid`, never resolvable) → 4xx `TARGET_NOT_ALLOWED`,
   no pass; no external request possible from this test.
5. Strict inputs: unknown field, non-string url, missing url, path-traversal baseline id →
   4xx `INVALID_ARGUMENT`.
6. MCP lists exactly two tools with correct JSON schemas.
7. MCP `audit_page` → real engine-derived ScanRun `gate=fail`; run retained as baseline.
8. Same-URL partial repair (img alt attribute only) → remaining + no_longer_detected, no new
   findings, `gate=fail`, verification gate ≥ current-run gate.
9. Same-URL new issue (one extra unlabelled input) → `newly_detected` + `gate=fail`.
10. Same-URL corrected reference copied over the SAME file → on-disk repair evidence asserts,
    then `verify_fixes`: gate is pass **only if** every baseline id is certain AND the fresh
    scan itself is complete (current-run gate `pass`, uncertain ids zero); any uncertainty or
    an incomplete fresh scan honestly downgrades to `review_required` (never pass, never fail).
    On the certain-pass branch the verbatim PRD wording is asserted, plus located pass-evidence
    notes covering each `no_longer_detected` id.
11. Baseline error categories: UUID-shaped unknown id → `BASELINE_NOT_FOUND`; non-UUID opaque
    id → `INVALID_ARGUMENT` (both `isError=true`, no gate on the error envelope).

13. Remote disallowed target over MCP → `isError=true`, allowlist refusal code, no pass.
14. Application behavior preserved by the repair: same form action/submission path, same field
    ids/names/autcomplete/options, link destination retained, no disabled controls.
15. No stdout/stderr diagnostic leaks (fixture DOM, findings, report dumps).


13. Remote disallowed target over MCP → `isError=true`, allowlist refusal code, no pass.
14. No stdout/stderr diagnostic leaks (fixture DOM, findings, report dumps).

## How to run (only once the orchestrator hands the completed build)

```bash
npm install && npm run build   # backend worker's deliverables: deps + dist/server.js
node test/e2e-fixtures/repair-evidence.unit.mjs   # mechanical repair evidence (no scans)
npx vitest run test/e2e.test.ts                   # full e2e (real browser scans)
```

Optional override: `BROWSER=<path>` replaces `/usr/bin/chromium`.

## Boundaries

- Network discipline: **no external, no government, no GCP/cloud requests**; all targets are
  127.0.0.1 plus a never-resolving `.invalid` hostname. (This test env is unrelated to the
  AWS-agent context rules in the user's AGENTS.md — nothing here touches cloud services.)
- Cleanup: MCP client closed, app child killed and waited for (SIGTERM→SIGKILL), fixture
  server closed, all temp dirs removed in `afterAll`.
- This suite is **not** the observed real OpenCode remote-host run.
