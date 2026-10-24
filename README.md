# Accessibility Companion

Hosted hackathon demo for an **accessibility companion**: it scans a rendered page with Playwright Chromium + `@axe-core/playwright`, returns structured evidence and repair guidance, and the coding agent repairs **source** and verifies the **same URL** after redeploy.

**Status: IMPLEMENTED LOCALLY — not yet deployed.** The backend (HTTP API + remote MCP + shared engine), frontend demo console, and landing page are built and tested locally. No public Cloud Run deployment is live yet. This is a hosted **demo**, not a production service. No login, anonymous, and the public deployment scans **only** an allowlist (our deployed editable fixture + selected Indian government domains, read-only).

> See [`HACKATHON_TEAM_HANDOFF.md`](HACKATHON_TEAM_HANDOFF.md) for the full team brief, and [`Accessibility_MCP_PRD.md`](Accessibility_MCP_PRD.md) for the spec (the prepended hosted-demo addendum supersedes the original local-only P0 delivery constraint).

---

## What this repo contains

| Path | Owner | Contents / status |
| --- | --- | --- |
| `Accessibility_MCP_PRD.md` | Docs | PRD + hosted-demo scope addendum. Spec, not code. |
| `HACKATHON_TEAM_HANDOFF.md` | Team | Planning/status handoff. |
| `web/` | Frontend | React + TypeScript + Vite demo console (served at `/console`). No `node_modules`/`dist` committed. |
| `landing-page/` | Frontend | Landing page static export (served at `/`). |
| `docs/AGENT_INSTRUCTIONS.md` | Docs | Coding-agent repair-loop instructions. |
| `src/` | Backend | HTTP API + remote MCP + shared scan engine. Implemented; contracts fix verified (see test status below). |
| deployment / CI | DevOps | Cloud Run, GCS, Artifact Registry. **Gated — not deployed yet.** |

> **Implementation status.** The backend package, demo console, and landing page are built and wired locally (`/` landing, `/console` demo console). What remains is the public Cloud Run deploy plus same-URL live verification.

---

## Planned architecture

- **Backend (root package, planned):** single TypeScript/Node service. One shared scanning/normalization/comparison engine serves both:
  - Remote **Streamable HTTP MCP** at `/mcp` — tools `audit_page(url)` and `verify_fixes(url, baseline_id)`.
  - **HTTP API**: `POST /api/v1/audits` `{ "url": ... }`; `POST /api/v1/verifications` `{ "url": ..., "baseline_id": ... }`; `GET /api/v1/runs/:run_id`; `GET /api/v1/config`; `GET /healthz`.
- **Frontend (`web/`, scaffolded):** React + TypeScript + Vite, static, served same-origin. Landing page + minimal demo screen. No dashboard.
- **Storage (planned):** private GCS for normalized runs with a 24-hour app-enforced TTL; dedicated narrowly scoped service account/bucket. GCS lifecycle deletion is eventual, best-effort.
- **Detection:** Playwright Chromium + axe; eight rule IDs mapped to six categories; deterministic guidance; source edits by the coding agent only.

## Backend configuration env (planned)

| Env var | Purpose |
| --- | --- |
| `ACCESSIBILITY_ALLOWED_ORIGINS` | Allowed origins |
| `ACCESSIBILITY_ALLOWED_HOSTS` | Allowed scan hosts (allowlist) |
| `ACCESSIBILITY_PUBLIC_BASE_URL` | Public base URL for the deployment |
| `ACCESSIBILITY_REPORT_BUCKET` | GCS bucket (final name confirmed by backend) |
| `ACCESSIBILITY_REPORT_DIR` | Local report dir (dev/local mode) |
| `ACCESSIBILITY_ALLOW_LOCAL` | `true` only for developer tests — **never on Cloud Run** |

The public demo scans **only** allowlisted hosts (our deployed fixture + selected Indian government domains). localhost is unreachable from the cloud; local development uses an explicit test-only local mode. The intended demo base is the developer-hosted preview URL — do not invent a public base URL.

## Frontend

`web/` is a Vite React app. See `web/.env.example` for `VITE_API_BASE_URL` (public URL only, never secrets; default = same origin). Planned scripts (scaffolded, not yet verified):

```bash
cd web
npm install
npm run dev        # dev server (planned)
npm run build       # tsc -b && vite build (planned)
npm run preview      # preview production build (planned)
```

## Build / test status (honest)

| Item | Status |
| --- | --- |
| Root/backend package (`npm run build`, `npm test`) | **Built** — `npm test`: 254 tests passing (includes contracts fix for rule-level incomplete items with empty targets) |
| Frontend build (`web/`) / landing page (`landing-page/`) | **Wired locally** — landing page at `/`, demo console at `/console` (same service) |
| Scan engine implementation | **Built** (Playwright Chromium + axe; eight rules / six categories) |
| Remote MCP + HTTP API | **Built** — `audit_page` / `verify_fixes` plus `/api/v1/*`, `/healthz`, `/api/v1/config` |
| GCS storage + 24h TTL | Implemented; live behavior pending public deploy |
| Deployed base URL / endpoints | **None live** — Cloud Run deploy still gated; use `<DEPLOYED_BASE_URL>` |
| Real scan findings / live metrics | **None measured against a public deploy yet** — placeholders until live verification |

Planned OpenCode MCP configuration (for DevOps/backend to apply, using current `mcp.servers` schema):

```json
{
  "mcp": {
    "servers": {
      "accessibility-companion": {
        "type": "remote",
        "url": "https://<DEPLOYED_BASE_URL>/mcp",
        "oauth": false
      }
    }
  }
}
```

Relative paths/configs must be resolved to absolute paths for local development where needed.

## Privacy & honesty notes

- Reports are anonymous and keyed by **opaque report IDs** — anyone holding the ID can retrieve the report. API enforces 24-hour expiration; storage cleanup may be asynchronous.
- No credentials collected, no report-listing dashboard, no cookies/screenshots.
- DOM snippets are untrusted and best-effort redacted; they may reach the host model.
- Government sites are scanned read-only; the code is never edited. Only our own deployed fixture is source-repaired. Switching URLs is not repair evidence.
- This is an automated subset only — no certification, no full WCAG conformance claim.

## Next steps (Cloud Run deploy still gated)

- Deploy to Cloud Run in `asia-south1` (Mumbai, approved); confirm public base URL, then replace `<DEPLOYED_BASE_URL>`.
- Run the real repair loop against the public URL (source repair → same-URL redeploy → readiness → `verify_fixes` → behavior check) with a real OpenCode connection.
