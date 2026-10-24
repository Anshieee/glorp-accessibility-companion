# Accessibility Companion — frontend (`web/`)

Hosted hackathon demo frontend for **Accessibility Companion** (React + TypeScript +
Vite). This is a *hosted demo, not production*: no login, no payment, no
tracking, no fabricated scores.

> Quickly for friends/frontend builders: this is the demo console and the pieces
> your landing page team will later replace. Everything here is self-contained
> in `web/` and does not touch `server/`, root config, or any other worker's code.

## Stack

- React 19 + TypeScript 7 (strict) + Vite 8
- No UI framework, no CSS-in-JS, no router — one self-contained demo console
- System-font editorial style (warm paper, navy ink, accessible teal controls)
- All findings rendered as text — no `dangerouslySetInnerHTML`

## Run it

```bash
cd web
npm install
npm run dev          # dev server on http://localhost:5173
npm run build        # tsc -b && vite build → dist/
npm run preview      # serve the production build (dist/)
npm run typecheck    # type-check only
```

Production assets are emitted to **`web/dist/`**.

## API base URL

By default the frontend calls the **same origin** as the page. To point it at a
deployed backend (a public URL only — never secrets):

```bash
cp .env.example .env.local
# VITE_API_BASE_URL=https://<DEPLOYED_BASE_URL>
```

`vite.config.ts` also proxies backend routes (`/api`, `/fixtures`, `/mcp`,
`/healthz`) to `http://localhost:8080` during dev (override with
`VITE_DEV_PROXY`).

## What it talks to (PROPOSED contract)

| Method & path | Body | Returns |
| --- | --- | --- |
| `GET /api/v1/config` | — | `{ allowed_origins, allowed_hosts, public_base_url?, targets?, rule_ids?, limitations? }` |
| `POST /api/v1/audits` | `{ url }` | `ScanRun` directly |
| `POST /api/v1/verifications` | `{ url, baseline_id }` | `VerificationResult` |
| `GET /api/v1/runs/:run_id` | — | stored run (expires 24h) |

Errors come as `{ execution: "failed", error: { code, message, recoverable, next_action } }`
and may be HTTP 4xx/5xx. The frontend aborts requests after 55s (backend targets
~45s). See `src/api/client.ts` for the full typed surface.

## Intentional behavior

- **Drop-down presets** come from the server's `targets` (fallback: our
  `/fixtures/registration.html` fixture + `https://www.india.gov.in`). The **URL
  field is editable**, but the app never implies arbitrary URLs are accepted —
  the backend enforces the allowlist and rejects unlisted hosts
  (`TARGET_NOT_ALLOWED`).
- **Baseline**: after an audit, the returned `run_id` is kept as the baseline.
  The "Verify against baseline" button is enabled only when a baseline exists
  **and** the target URL is the same as the baseline's (fragment stripped).
  "Reset baseline" clears it so you can start a fresh cycle.
- **Gates**: `pass | fail | review_required | not_evaluated` — shown as a badge,
  never a percentage.
- **Honest deltas**: verification shows remaining / newly detected / no-longer-
  detected / uncertain. "No longer detected" is never labelled "fixed".
- **Spinner only** while a scan is pending — no fake progress percentages.
- **No certification claims**: only the exact PRD clearance text for a pass, and
  a warning that this covers 8 rules on one page state (main document only).

## Files

```
web/
  .env.example            # VITE_API_BASE_URL placeholder only
  index.html
  vite.config.ts          # base "./", /api + /healthz dev proxy
  src/
    main.tsx / App.tsx
    api/client.ts         # typed client, 55s timeout, error normalization
    lib/presets.ts        # fallback config, labels, clearance copy
    components/
      DemoConsole.tsx     # the demo console (scan + baseline + verify)
      FindingsList.tsx    # findings + review items + counts
      EvidencePanel.tsx   # engine versions, scan id, warnings/limitations
      DeltaPanel.tsx      # verification comparison (honest deltas)
      McpSetup.tsx        # copyable remote MCP config (OpenCode v2)
      ApiDocs.tsx         # curl quickstart + in-page contract
      primitives.tsx      # Spinner, GateBadge, ErrorBanner, CodeBlockWithCopy
```

## Security / privacy notes baked into the UI

- Scan snippets are untrusted and best-effort redacted; they may be sent to the
  host coding model — the UI says so.
- Reports are anonymous, reachable by unguessable IDs, and expire after 24h —
  the UI says so.
- `rel="noopener noreferrer"` on all external links; help links are http/https only.

## Known notes

- `npm audit` is clean (0 vulnerabilities) on the current dependency set
  (Vite 8 uses Rolldown; no esbuild in the tree).
- The landing page is out of scope here; the handoff describes it separately.
  This console is designed to be lifted into that page.

## Tests

The minimal gate is a clean production build: `npm run build` (runs
`tsc -b` + `vite build`). Backend/server, frontend-root build, and deploy
integration are owned by the backend/DevOps workers.
