# Hackathon Team Handoff — Accessibility Companion

Version: 1.1
Date: 24 October 2026
Audience: everyone preparing the demo (landing page, PPT, video, launch)
Status: IMPLEMENTED LOCALLY / DEPLOY GATED — backend + demo console + landing page are built and tested locally; no public Cloud Run deployment is live yet. See Section 2 for what is real vs. pending.

---

## 1. What we are building (confirmed new scope)

This supersedes the local-only, 180-minute PRD (`Accessibility_MCP_PRD.md`). We are building a **hosted demo**, NOT a production service.

- Hosted public demo, no login, for the hackathon.
- Hosted HTTP API **plus** a remote Streamable HTTP MCP server sharing one scan engine.
- MCP tools are exactly two: `audit_page(url)` and `verify_fixes(url, baseline_id)`.
- A landing page plus a minimal usable demo screen (URL input → progress → findings → verification). Not a dashboard.

### 1.1 What the product does

- Uses Playwright Chromium + `@axe-core/playwright` to scan a rendered page for six categories mapped to eight rule IDs:

  | Category | axe rule IDs |
  | --- | --- |
  | Text contrast | `color-contrast` |
  | Image alternatives | `image-alt` |
  | Form labels | `label`, `select-name` |
  | Link names | `link-name` |
  | Button names | `button-name` |
  | Document language | `html-has-lang`, `html-lang-valid` |

- The **coding agent (OpenCode + its existing model) edits source**, not the server. No additional inference API key, no server-side LLM.
- Conservative gate results: `pass` / `fail` / `review_required` / `not_evaluated`, plus explicit operational errors. Missing/disappeared evidence never becomes a false pass.

### 1.2 Public scan targets (allowlist only)

The public page may scan ONLY configured, allowlisted hosts:

1. Our own deployed **editable flawed fixture** (public URL) — this is the primary demo.
2. **Selected Indian government domains** for real read-only detection.

Hard constraints:

- No localhost, no private/reserved networks, no auth pages, no cookie import, no crawling, no form submission.
- Government sites are scanned read-only for **real** findings. We must NOT assume any particular site fails; we show only actual observed findings.
- A separate publicly deployed registration sample demonstrates the **agent source repair + same-URL fresh verification** loop.

---

## 2. Honest status: built vs. pending deploy

> The backend (HTTP API + remote MCP + shared scan engine), the demo console, and the landing page are implemented and tested locally. **No public Cloud Run deployment is live yet.**

| Item | Status |
| --- | --- |
| Application implementation (scan engine, API, MCP server, frontend) | Built locally — landing page wired at `/`, demo console at `/console` (same service) |
| API/MCP contracts | Implemented; contracts fix verified (rule-level incomplete items with empty targets stay `review_required`, never pass) |
| Test suite | 254 tests passing (`npm test`) |
| Cloud Run / public deploy | **Gated — not deployed; no public URL live** |
| `gcloud` CLI installed, MCP connected, active CLI auth | Verified |
| Cloud Build / Artifact Registry APIs | NOT enabled; no resources provisioned |
| Region Mumbai `asia-south1` | **APPROVED by user** — no hosting/deployment yet |
| GCP project ID `project-f788c2f2-5518-4c6d-847` | Authorized; do NOT put in presentation assets |
| Billing / costs | Billing exists, costs possible, **no pricing guarantees**; caps planned, not zero charges |
| Hosting URL / endpoints | None live. Use placeholder `<DEPLOYED_BASE_URL>` |
| Live scan findings / performance numbers | No real measurements against a public deploy — use placeholders |

Anything not listed as verified above is **pending** and must be presented as such.

### 2.1 Planned architecture (blueprint, to validate during implementation)

- Single TypeScript Node.js supported-LTS service; exact versions/deps locked during implementation.
- Official MCP SDK (one consistent generation) + a small HTTP framework/validation library (TBD).
- One shared scanning/normalization/comparison core used by both HTTP API and MCP.
- Stateless remote MCP server.
- Private GCS for normalized run objects, persisted across service restarts, with a 24-hour app-enforced expiration. **Storage budget detail:** the 24h limit is enforced by the application (API rejects/expires runs past it); GCS lifecycle deletion is an eventual, best-effort cleanup — do not present it as instant or guaranteed.
- Cloud Run container from a compatible Playwright image.
- Dedicated, narrowly scoped service identity.
- Artifact Registry / Cloud Build path — pending verification.
- Frontend: React + TypeScript + Vite (Tailwind optional), static, served from the same Cloud Run service as the API (easiest integration).
- Conservative browser-worker concurrency, bounded timeout and scaling. No production SLA.

### 2.2 Hosted-demo security requirements (REQUIRED for any hosted demo)

Not yet implemented or verified — these are requirements:

- Meaningful target/readiness checks before a scan.
- URL redirect restrictions.
- Basic SSRF protection + metadata/private-address protections.
- Remote assets only under a planned safe public-network request policy. Do **not** claim sandbox isolation.
- DOM snippets are untrusted, best-effort redacted, and may reach the host model (state this).
- Anonymous private reports are accessed via unguessable capability IDs. Anyone holding the ID can retrieve the report — no tenant auth. API enforces 24h expiration; storage cleanup may be asynchronous.
- No screenshots, no cookies.

### 2.3 Backend endpoints (PROPOSED — not frozen, not implemented)

| Method & path | Body | Purpose |
| --- | --- | --- |
| `POST /api/v1/audits` | `{ "url": "..." }` | Start/perform a scan |
| `POST /api/v1/verifications` | `{ "url": "...", "baseline_id": "..." }` | Verify fixes against a baseline |
| `GET /api/v1/runs/:run_id` | — | Fetch a stored run |
| `POST /mcp` | MCP JSON-RPC | Remote Streamable HTTP MCP |
| `GET /healthz` | — | Liveness |

- Frontend uses same-origin API base; optional `VITE_API_BASE_URL` env (public URL only, never secrets).
- Rate/resource limits return 429/503/504 — planned; exact status validation TBD.
- **Do not fabricate an async job API or progress percentages.** UI shows a pending spinner / request stages until the contract supports more.

---

## 3. Demo proof: the repair loop (the core story)

The demo must show the **agent repair loop**, not a scanner side-effect.

1. Open the deployed flawed registration fixture (public URL).
2. Ask OpenCode to improve the page using its existing model (per the agent instructions).
3. Run `audit_page(url)` → real findings across the six categories.
4. Show the agent editing **source**.
5. **Redeploy the same URL** (await rollout/readiness — do not skip or fake this).
6. Run `verify_fixes(url, baseline_id)` on the **same URL** → remaining/new/no-longer-detected, honest.
7. Confirm registration behavior still works.

Important: The built-in flawed fixture repairs **require** deployment propagation before `verify_fixes` (don't silently skip the same-URL wait). A known-corrected fixture is a useful test, but **switching URLs is NOT repair evidence**.

---

## 4. Audiences & task ownership

| Deliverable | Owner (assign) | Audience |
| --- | --- | --- |
| Landing page | Frontend | Judges, general hackathon visitors |
| Demo screen (scan UI) | Frontend + backend | Live-run judges, curious users |
| PPT (7–9 slides) | Presenter + technical writer | Judges |
| Video (~3 min) | Video + tech writer | Judges, public (post-event) |
| Backend/API + MCP | Backend | Technical demo, integration |
| Deploy (Cloud Run/GCS/Artifact Registry) | DevOps | Live run |
| Repo release packaging | All | Everyone |

---

## 5. Landing page brief

- Accessible, responsive page.
- Content: product hero; problem; "how it works" in 3 steps; the six categories; an **actual interactive demo** (URL dropdown + input); MCP setup / API quickstart; honest limits; footer.
- Never include: user auth or payment UI, fake scores/counts, made-up testimonials, certification claims, or "first of its kind" claims.
- Working product label: **"Accessibility Companion"** — do not rename `glorp` as the final brand without an explicit flag/decision.
- Design style is the team's choice, but enforce accessibility and keep dependency assets small.

### 5.1 Frontend file handoff

Include in the handoff: component tree, assets, README, env example (values only, no tokens), `package.json` + lockfile. **No `node_modules`/`dist`.** Provide integration instructions. No unnecessary router/backend/auth.

**Compact repo component layout** (proposed):

```
/                 # single service (Node LTS)
  server/        # HTTP API + remote MCP (/mcp), shared scan engine
    src/
      server.ts  # express-like app + /healthz + /api/v1/...
      mcp.ts     # Streamable HTTP MCP + audit_page / verify_fixes
      scanner.ts # Playwright Chromium + axe-core
      normalize.ts / compare.ts / policy.ts  # gate + deltas
      store.ts   # GCS run objects, 24h app expiration
  web/           # frontend (React+TS+Vite)
    src/         # components + api/client.ts (snippet above)
    .env.example # VITE_API_BASE_URL only — no secrets
  README.md
```

- Backend origin placeholder: use `<DEPLOYED_BASE_URL>` — never an invented real URL.
- API helper code must carry a clear PROPOSED status.
- Any scanned DOM snippet must render as **text**, never HTML. Never expose secrets.

### 5.2 Proposed frontend integration (fetch API) — for builders

Contract is **planned**, not live; the snippet shows expected `gate`/counts/findings/error fields per the PRD. It is NOT a fake live result.

```ts
// env: VITE_API_BASE_URL (public URL only, never secrets); default = same origin
const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export type Gate = "pass" | "fail" | "review_required" | "not_evaluated";

export interface ScanRun {
  run_id: string;
  requested_url: string;
  gate: Gate;
  counts: {
    violation_rule_count: number;
    violation_node_count: number;
    incomplete_node_count: number;
    returned_finding_count: number;
    omitted_finding_count: number;
  };
  findings: Array<{ rule_id: string; impact: string; description: string; html: string }>;
  warnings: string[];
  limitations: string[];
  details_truncated: boolean;
}

export interface ApiError {
  error: { code: string; message: string; recoverable: boolean; next_action: string };
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Planned limit handling TBD: 429/503/504 → distinct messages
    throw new Error((await res.json().catch(() => null))?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // PROPOSED — not implemented yet
  audit: (url: string) => request<ScanRun>("/api/v1/audits", { url }),
  verify: (url: string, baseline_id: string) =>
    request<{ current_run: ScanRun; comparison: unknown; gate: Gate }>(
      "/api/v1/verifications",
      { url, baseline_id }
    ),
};
```

Frontend builders workflow — **build components independently**:
- Use the same-origin API base (or `VITE_API_BASE_URL` for a public URL). Never put API keys/secrets in frontend env.
- Preserve gate states; never clear a `fail`/`review_required` result on a re-render.
- Never use `dangerouslySetInnerHTML` for findings — render snippets as plain text.
- Retain `baseline_id` after an audit and reuse it for same-URL verification.
- No fabricated progress percentages: show a pending spinner/request stages until the contract supports more.

---

## 6. PPT brief (7–9 slides)

Truthful technical story. Use placeholders for measured evidence until real numbers exist.

Suggested flow (approx. 3-min script):

1. Title — problem: most web pages fail basic accessibility checks.
2. The gap: existing coding agents ship UI without post-checking.
3. Our tool: an accessibility companion that checks during generation.
4. How it works: audit → agent repairs source → redeploy → verify same URL.
5. Live demo focus: flawed scan → source repair → redeploy → same-URL verification → behavior test. (Government detection is secondary; never claim the government edited source.)
6. Endpoint/docs demo (if time).
7. Limitations & honesty: automated subset only, no certification, hosted demo not production.
8. Ask / next steps.

- Non-technical framing: people with disabilities benefit; parity with existing tools.
- Credit competitors/existing work: axe-core and Playwright as the detection engine; Deque already offers an accessibility MCP server. Do not claim to be the first.
- Include: disclaimers, work split, launch/demo checklist, unresolved decisions (Section 9) — and prepared answers for the Judge Q&A (Section 10).

---

## 7. Video brief (~3 min) — actionable storyboard

Captures the **repair loop**. Main story = our own flawed fixture repair. The government scan is optional/real and clearly secondary (never claim a government edited its source). Don't fabricate screenshots/metrics/endpoints — film or capture only what runs. Use real timestamps; fill with live capture, not stock.

| Time | Shot / action | On-screen / script note |
| --- | --- | --- |
| 0:00–0:20 | Hook | "95%+ of web pages fail basic accessibility checks. AI generates UI fast — but who checks it?" |
| 0:20–0:40 | Product intro | Accessibility Companion label; "audit → the coding agent repairs source → redeploy → verify the same URL". |
| 0:40–1:20 | **Flawed fixture scan (main)** | Run `audit_page` on our deployed fixture; show real findings across the six categories (no fake counts). |
| 1:20–1:40 | Agent source repair | OpenCode edits the fixture source (plain edits, no fake diff). |
| 1:40–2:00 | **Redeploy same URL** | Show deploy/rollout; wait for readiness before verifying. |
| 2:00–2:20 | **verify_fixes same URL** | Same URL, baseline_id; show remaining/new/no-longer-detected honestly. |
| 2:20–2:35 | Behavior test | Registration form still works (submit still executes). |
| 2:35–2:50 | Optional government scan | Real read-only detection on a chosen allowlisted gov domain; show actual findings only; "we do not edit government sites". |
| 2:50–3:00 | Wrap + limits | "Automated subset only — no certification. Hosted demo, not production." |

---

## 8. Planning models (not product requirements)

Internal hackathon planning only — these are NOT product inference requirements:

- GPT 6.1 Sol High — orchestrator (requested).
- GLM 5.3 Flash — OpenCode reasoning workers.
- Mercury 3 — generation workers.

---

## 9. Unresolved decisions / open items

| Decision | Owner | Notes |
| --- | --- | --- |
| Region `asia-south1` | User | **APPROVED** — no hosting/deployment yet |
| Government URL selection + actual observed findings | Backend | Choose after allowlist is real; scan read-only; record real findings only |
| Final dependency / API binding | Backend | MCP SDK generation, HTTP framework, validation lib |
| Deployment URL and limits | DevOps | Use `<DEPLOYED_BASE_URL>` until real |
| Measured performance/cost | Backend | Capture real numbers at demo time |

### 9.1 Launch/demo checklist

- [ ] Repo release verified: startup + HTTP works; actual OpenCode calls work; source behavior preserved.
- [ ] No production-readiness claims anywhere.
- [ ] Allowlist configured (fixture + chosen government domains) and verified.
- [ ] 24h expiration + cleanup verified on GCS.
- [ ] Security requirements (SSRF/private-address/redirect/DOM-redaction) implemented and tested.
- [ ] Landing page + demo screen deployed and reachable.
- [ ] PPT/video use only real measured evidence.
- [ ] `glorp` name decision flagged.

---

## 10. Judge Q&A (prepared honest answers)

Q1. **Aren't there already accessibility MCP servers?**
A. Yes — Deque ships an axe MCP server, and axe-core + Playwright power our detection. We don't claim to be first. Our focus is the integrated loop: the coding agent repairs source, redeploys, and verifies the same URL.

Q2. **Is your scan a full accessibility audit?**
A. No. It runs eight automated axe rules covering six categories on one rendered page state (main document only). That's a useful subset, not a certification or guarantee of full WCAG conformance.

Q3. **How is this different from just running axe on the page?**
A. We wire it into the agent workflow and keep honest evidence: an immutable baseline, a conservative gate, and same-URL verification after a source repair. The "fix" step is the agent editing source, not us switching URLs.

Q4. **Isn't this too slow / does it scale?**
A. We're a hosted demo, not production. We plan conservative browser concurrency and bounded timeouts; we have no real load numbers yet and won't fake them.

Q5. **What about security — can't anyone scan anything?**
A. Public scans are restricted to an allowlist (our fixture + selected government domains), with redirect limits, private-address/SSRF protections, and redacted untrusted DOM snippets. Reports are anonymous, keyed by unguessable IDs, and expire in 24h.

Q6. **What's left before this is real?**
A. The backend, demo console, and landing page are built and tested locally (254 tests passing). Remaining work: deploy to Cloud Run (region approved: `asia-south1`), then run the live same-URL repair loop and capture real measurements.

## 11. Rules of honesty (non-negotiable)

- No fabricated scans, screenshots, metrics, dependency versions, hosting URLs, live endpoints, production-readiness, compliance, or novelty claims.
- Present planned architecture/contracts as planned; mark verified items as verified.
- "Hosted demo, not production" should be stated clearly in the landing page, PPT, and video.
- Keep the working label "Accessibility Companion"; don't claim certification or "first of its kind".
