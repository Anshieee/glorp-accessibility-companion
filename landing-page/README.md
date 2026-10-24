# Glorp — Accessibility Companion landing page (static export)

Hosted hackathon demo frontend. **Same-origin static bundle** served by the existing
Express backend — no new Next.js server process.

- Framework: Next.js `15.5.28` + React `19.3.1` (exact pins in `package.json`, locked in `package-lock.json`).
- Build output: `landing-page/out/` via `output: 'export'` in `next.config.ts` (`images.unoptimized`).
- Runtime API base: same-origin by default. Optional public override:
  `NEXT_PUBLIC_GLORP_API_URL` (public base URL only, **never secrets**).

## Integration (existing Express backend)

The backend (root `src/server.ts`) already serves `web/dist` at `/`. To serve THIS
landing page instead, the backend/devops integrator points the static directory at
`landing-page/out/` and keeps the same routes:

| Method & path | Body | Purpose |
| --- | --- | --- |
| `POST /api/v1/audits` | `{ "url" }` only | Real scan (no simulation) |
| `POST /api/v1/verifications` | `{ "url", "baseline_id" }` only | Same-URL verification vs preserved baseline |
| `GET /api/v1/config` | — | Allowlisted targets, rules, limitations, MCP info |
| `GET /api/v1/runs/:run_id` | — | Stored run (capability ID, 24h TTL) |
| `POST /mcp` | MCP JSON-RPC | Tools: `audit_page(url)`, `verify_fixes(url, baseline_id)` (stateless) |
| `GET /healthz` | — | Liveness |

Frontend contract:

- `auditPage(url)` → `POST /api/v1/audits { url }`, validates `schema_version: "1.0"`,
  `execution: "completed"`, gate, findings, and review items. Malformed responses are
  rejected, never rendered as guessed findings.
- `verifyFixes(url, baseline_id)` → `POST /api/v1/verifications { url, baseline_id }`
  with the SAME canonical URL as the baseline. The baseline `run_id` is preserved
  across verifications; the fresh `current_run` never replaces it. The authoritative
  gate is the **verification gate**, not the fresh scan gate. Review items never turn
  the gate green on their own.
- URL handling (client mirrors server): absolute http(s) only, embedded credentials
  refused early, fragment stripped, query preserved, missing scheme defaults to `https://`.
  Non-allowlisted hosts are rejected by the server and surfaced as
  `[TARGET_NOT_ALLOWED] …` errors — no localhost claims in the hosted UI.
- Errors are typed `ApiError { code, message, next_action }` from the server body
  `{ execution: "failed", error: { code, message, next_action } }`. Requests abort
  after 55s (`SCAN_TIMEOUT`). There is NO mock fallback, NO simulated latency, and
  NO fabricated run IDs anywhere in runtime code.
- `src/lib/mockData.ts` is an **unused, clearly labeled offline shape fixture**.
  Nothing imports it at runtime. Never present it as scan output.
- Optional server extras (`ai_insight`, `suggested_code_diff`) render ONLY when
  factually present in the backend response. The hosted engine does not provide
  them; absence is normal. No AI-generated patches are implied.
- DOM snippets render as **text only** (never `dangerouslySetInnerHTML`).
- Help links render only for safe `http(s)` URLs with `rel="noopener noreferrer"`.

## What the UI shows (honest copy)

- Hero toggle: AI question vs. selected-checks scope note (8 rules, 6 categories).
  No unsourced “95% of all websites” global claim.
- Presets come from live `GET /api/v1/config` targets (own fixture + `https://www.india.gov.in/`
  read-only). On config failure the UI shows a real error plus the conservative built-in
  fixture + gov targets — never fake `acme-studio` / `creative-ai` / `localhost` examples.
- Pending state is a single truthful indicator: “Scanning the rendered page…” (`role="status"`,
  `aria-live="polite"`). No staged DOM/AXE progress claims.
- Verification panel states the verification gate as authoritative and notes that
  switching URLs is not repair evidence.
- Pass wording (verbatim when `gate === "pass"`):
  “No violations detected by the selected automated checks on the tested page state.
  Other accessibility requirements and semantic correctness may still need manual review.”
- Footer: “Hosted hackathon demo — not production • Automated subset only, not full WCAG”.
- Collapsible “API & MCP connection details” documents same-origin `/mcp` (OpenCode V2
  `mcpServers` schema), actual REST routes, and a copyable command. No auth, no new keys.
- Government domains: read-only detection only. Repairs happen in our own fixture
  source via the coding agent (OpenCode), redeployed at the SAME URL — this web UI
  does not auto-patch code.

## Fonts, CSP, and motion (what the server must allow)

- Fonts: **no remote fetches** at build or runtime. Local `public/fonts/Advercase-Font-Demo-Italic.otf`
  (user-supplied; keep its license file alongside it if redistribution requires it) +
  system stacks (`system-ui…` for sans, `ui-monospace…` for mono). No Google Fonts
  `<link>`/CSS `@import`, no `next/font` network call.
- WebGL background: respects `prefers-reduced-motion` (still frame, no loop), pauses
  when the tab is hidden or the canvas leaves the viewport, falls back to a static
  2D gradient if WebGL/shader compilation fails (never throws), DPR capped at 1.5,
  `powerPreference: "low-power"`.
- `output: 'export'` prunes all server code; the bundle needs no Node runtime.
  The static export includes Next's small inline bootstrap scripts/styles, so the
  Express CSP for the landing route must allow:
  - `script-src 'self' 'unsafe-inline'` (Next static inline bootstrap only; app code has no `eval`)
  - `style-src 'self' 'unsafe-inline'` (Next + Tailwind inline styles)
  - Everything else stays strict: `default-src 'self'`, `img-src 'self' data:`,
    `connect-src 'self'`, `font-src 'self'`, `object-src 'none'`,
    `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
  - No `unsafe-eval`, no remote font/script/style hosts.

## Local dev & tests

```bash
npm install            # canonical lockfile: package-lock.json (pnpm-lock.yaml preserved for reference)
npm run typecheck      # tsc --noEmit
npm run build          # Next static export → landing-page/out/ (experimental.cpus: 1)
npm audit              # review; measured 2026-10-24: 5 findings (1 high, 4 moderate),
                       # all build-time-only in the PostCSS chain (nested postcss 8.4.31 inside
                       # next@15.5.28; postcss-nested/selector-parser inside tailwindcss 3.4).
                       # Fixes require breaking upgrades (Next 16 / Tailwind v4) — not taken.
                       # None of these ship: out/ is static HTML/CSS/JS with no Node runtime.
```

- `NEXT_PUBLIC_GLORP_API_URL` (optional, `.env.local` only): public backend base URL.
  Same-origin when unset. Example: `NEXT_PUBLIC_GLORP_API_URL=https://<DEPLOYED_BASE_URL>`.
- No screenshots/browser workers are spawned by these commands. Build uses a single
  worker (`experimental.cpus: 1`) to stay within laptop memory limits.

## Handoff

Output path: `landing-page/out/` (created by `npm run build`).
Source files for deployment: everything under `landing-page/` **except**
`node_modules/`, `.next/`, and `out/` (build artifact, regenerated by the command above).
Tell the deploy integrator when `npm run typecheck`, `npm run build`, and `npm audit`
have passed so `out/` can be wired into the existing Express static serving.
