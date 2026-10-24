# Hackathon Judging Strategy — Accessibility Companion

Version: 1.0 · Date: 24 October 2026 · Audience: every teammate (presenter, demo runner, engineer, video)
Source of truth for scoring: the official PDF rubric is **authoritative and exact** — total **50 pts**, weights **20 / 30 / 20 / 20 / 10** (Innovation & Creativity 10, Technical Implementation 15, Problem Solving & Relevance 10, Presentation & Demonstration 10, Feasibility/Scalability/Impact 5). **We do not predict marks; we maximize scored evidence.**

> **Honesty rule that governs everything:** nothing below claims something is done unless it is literally verified. The app is **implementation-paused / integrating** — backend compiles, engine unit + protocol tests pass, but **real-browser scan, live API, and remote MCP are NOT verified yet and are NOT deployed**. All "LIVE" labels are placeholders until we prove them.

---

## 0. Current verified status (what is real right now)

| Area | Status |
| --- | --- |
| Backend compile (`tsc`) | ✅ Verified — compiles clean |
| Engine unit / protocol tests | ✅ Verified — `contracts`, `mcp`, `config`, `errors`, `compare`, `service`, `store` pass |
| Real-browser scan tests | ❌ Fail today (`SCAN_FAILED`, browser en/ unavailable) — **not verified** |
| `network` EgressProxy tests | ❌ 6 failing — integration in progress |
| Frontend typecheck (`web`, `tsc -b`) | ✅ Verified — clean; `npm audit` 0 |
| Evidence capture script unit tests | ✅ Verified — 3 groups pass (CLI, not a scan) |
| Hosted API / remote MCP live | ❌ Not deployed — no public URL yet |
| Real browser scan on fixture / gov | ❌ Not run yet (India.gov.in reachable 200, title verified — scan not run) |
| GCP prereqs (bucket, image repo, SAs, region `asia-south1`) | ✅ Provisioned — private bucket exists, **app not deployed** |

---

## 1. Exact rubric mapping (criterion → claim → evidence → status → failure-avoid)

### 1.1 Innovation & Creativity (10) — judge wants: originality, unique approach, differentiation
- **Our claim:** not a new scanner and not the first accessibility MCP (Deque already ships one). Our innovation is **workflow integration + fresh-verification evidence**: the coding agent edits *source*, redeploys the *same URL*, and re-verifies honestly.
- **Evidence/artifact:** product story (audit → agent repairs source → redeploy SAME URL → verify) + two-tool MCP + conservative gate.
- **Current status:** story is real; the live loop is **PLANNED** until a real scan runs.
- **Failure avoid:** never say "first MCP" or "new detection engine". Differentiate on the *closed-loop workflow and honest evidence*, not on detection. Credit axe-core / Playwright / Deque.

### 1.2 Technical Implementation (15) — judge wants: working prototype, appropriate tools, code quality, execution of core features
- **Our claim:** a working TypeScript/Node service with one shared engine behind both a REST API and a remote Streamable-HTTP MCP; two tools (`audit_page`, `verify_fixes`); strict gates; immutable reports.
- **Evidence/artifact:** real HTTP calls (`/api/v1/audits`, `/verifications`), real MCP discovery + calls, tests, source, deploy config. The demo **must** show *actual* `audit_page` and `verify_fixes` responses (real JSON), not a mock.
- **Current status:** engine/protocol tests pass; **real browser scan + live calls NOT verified**. Treat as PLANNED until measured.
- **Failure avoid:** do not present unit tests as scan proof. Do not show a capture-CLI as an MCP tool. No fabricated findings/counts/endpoints.

### 1.3 Problem Solving & Relevance (10) — judge wants: problem understanding, effectiveness, target users/needs
- **Our claim:** most pages fail basic automated accessibility checks; coding agents ship UI without post-checking. We target developers/agents; beneficiaries are people facing barriers.
- **Evidence/artifact:** a crisp 2-line problem statement and a clear target user. Optionally cite WebAIM stats **only from our PRD as secondary source, marked PLANNED/secondary** — do not invent new percentages.
- **Current status:** problem framing is solid; live measurement of impact is PLANNED.
- **Failure avoid:** no invented stats, no "solves all accessibility", no certification claims.

### 1.4 Presentation & Demonstration (10) — judge wants: clarity, live demo, confidence, teamwork, Q&A
- **Our claim:** a tight, honest 3-minute demo that proves the repair loop live.
- **Evidence/artifact:** run-of-show (§5), 8-slide deck (§4), rehearse Q&A (§7), visible teamwork roles (§6).
- **Current status:** rehearsal is required; live demo is PLANNED until the scan works.
- **Failure avoid:** never fake a reroute as a repair; never claim a whole build in 3 minutes; show *observed* errors honestly.

### 1.5 Feasibility / Scalability / Impact (5) — judge wants: practicality, future development, scaling, real-world impact
- **Our claim:** feasible as a hosted demo (not production); designed with bounded concurrency, allowlist, private 24h reports; a credible roadmap exists.
- **Evidence/artifact:** deploy plan, allowlist, security controls, roadmap; honest statement that it's a demo, not production.
- **Current status:** architecture is planned; nothing load-tested. No scaling numbers.
- **Failure avoid:** no pricing/scaling guarantees; no "ready for production" claims; no promised funding/money.

---

## 2. Pitches

### 2.1 30-second crisp pitch
> "Most web pages fail basic accessibility checks, and AI coding agents ship UI fast — without checking it. Accessibility Companion plugs into your coding agent: it scans the page with axe + Playwright, the agent repairs the *source*, redeploys the *same URL*, and our tool re-verifies honestly. So a developer's normal 'generate and edit' loop ends with evidence that common accessibility issues are gone — not a claim."

### 2.2 Truthful innovation pitch (what is actually novel)
- Novelty = **the integrated loop + fresh verification evidence**, not the detection engine.
- We reuse established tooling (axe-core, Playwright). Deque already offers an accessibility MCP server — we credit that.
- We offer an **executable MCP tool + REST API** (machine-callable, returning structured data) rather than markdown guidance. Important nuance: *MCP tool availability is not enforcement* — soft instruction only, not a guaranteed loop. We say so plainly.

---

## 3. Priorities: must-show vs cut (per criterion)

**Must show (highest proof value):**
1. Real `audit_page` on our own deployed flawed fixture → real findings across all six categories.
2. Agent edits source (scratch) → real diff/hash.
3. Redeploy SAME URL → wait for readiness.
4. Real `verify_fixes` same URL + baseline → honest `no_longer_detected` / remaining / new.
5. Behavior preserved (form still works).
6. Both evidence streams: HTTP API **and** remote MCP tool calls.

**Cut / do not spend time on (scope creep per criterion):**
- No dashboard, no extra tools, no arbitrary URL scanning, no screenshots, no auth.
- No performance/load claims, no pricing/scaling estimates, no enterprise security.
- No new detection engines, no certification, no multi-route crawling.
- Don't expand features to chase a criterion — the loop **is** the demo.

---

## 4. The 8-slide deck (theory 3 bullets, speaker 2 sentences, evidence label)

Each slide labels evidence: **LIVE** (verified on screen), **MEASURED** (real numbers from saved JSON), **PLANNED** (not yet real). Only ever use those three labels.

1. **Title — "Accessibility Companion: a coding-agent accessibility loop."** · Bullets: audit → agent repairs source → redeploy same URL → verify. Speaker: "A hosted demo that closes the loop between generating UI and checking it." Evidence: PLANNED.
2. **Problem & gap.** · Bullets: most pages fail basic checks; agents ship without post-checking. Speaker: "Generation got fast; checking didn't." Evidence: PLANNED (secondary source: PRD citing WebAIM).
3. **The loop (how it works).** · 4 steps visual. Speaker: "The fix is the agent editing source — we verify the same URL afterward." Evidence: PLANNED.
4. **Live demo focus (flawed fixture).** · Bullets: scan → repair → redeploy → verify → behavior. Speaker: "This is the proof — read live from the API." Evidence: LIVE when running.
5. **Evidence & tooling.** · Bullets: REST API + remote MCP; two tools; strict gates. Speaker: "Same engine behind both surfaces; every result is honest JSON." Evidence: MEASURED (once running).
6. **Endpoints / docs.** · REST routes + MCP interface. Speaker: "Any agent can call it." Evidence: PLANNED.
7. **Honest limits.** · Subset of rules; no certification; hosted demo not production; gov read-only. Speaker: "We're precise about what we don't claim." Evidence: PLANNED.
8. **Next steps / ask.** · Roadmap. Speaker: "What remains is proof + scale paths." Evidence: PLANNED.

---

## 5. Run-of-show (3 min) + video storyboard (3 min)

**Shared reusable evidence:** the same saved JSON artifacts (audit/verify responses), the same "that" sequence, the same honesty labels.

### 5.1 Live run-of-show (target 3 min)
- 0:00–0:20 Hook + one-line problem.
- 0:20–0:40 Product + loop.
- 0:40–1:20 `audit_page` on our deployed fixture → show real findings (read from live JSON).
- 1:20–1:40 Agent edits source (show real diff).
- 1:40–2:00 Redeploy SAME URL — wait for readiness. **If this takes > my min, use a pre-recorded, labeled "previously recorded deployment" segment.**  time-jump; never pretend the run was instant. Never show a reroute as a repair.
- 2:00–2:20 `verify_fixes` same URL → honest remaining / no-longer-detected.
- 2:20–2:35 Behavior test (form submits).
- 2:35–2:50 Optional gov read-only scan — actual observed findings only, "we do not edit government sites".
- 2:50–3:00 Wrap + honest limits.
- **Backup:** if the live scan fails, show a low-tech prior recording labeled "recorded earlier, not live" with the *observed* error shown — never a fabricated success. Do not promise a whole build in 3 minutes.

### 5.2 Video storyboard (3 min) — same structure, story-shots
- 0:00–0:15 Hook (problem).
- 0:15–0:35 Product intro + loop.
- 0:35–1:10 Real flawed-fixture `audit_page` output.
- 1:10–1:30 Source repair (real diff).
- 1:30–1:50 Redeploy same URL (recorded segment, labeled as such).
- 1:50–2:10 `verify_fixes` same URL (honest deltas).
- 2:10–2:20 Behavior preserved.
- 2:20–2:40 Optional gov read-only detection (real findings only).
- 2:40–3:00 Wrap + limits + "hosted demo, not production".

---

## 6. Team roles (3–4 people) & handoffs

| Role | Who (fill in) | Responsibilities | Handoff |
| --- | --- | --- | --- |
| **Presenter / storyteller** | Friend A | Pitch, deck, Q&A, owns narrative | needs evidence JSON from Demo Runner |
| **Demo runner / evidence** | Friend B | Runs live loop, captures proof, owns runbook | hands evidence to Presenter |
| **Engineer / truth-keeper** | Friend C | Backend, engine, deploy; decides what is *actually verified* | signs off each evidence claim |
| **Video / backup** | Friend D (optional) | Records segments, edits storyboard, runs fallback | uses same evidence artifacts |

Handoff rule: **nothing enters the deck/video unless the Engineer confirms it is verified.** Demo Runner owns the evidence directory; Presenter pulls only from it.

---

## 7. 10–12 judge questions — honest concise answers

1. "Aren't there already accessibility MCP servers?" → Yes — Deque ships axe MCP, and axe + Playwright power our detection. We're not first. Our focus is the integrated source-repair → same-URL verification loop.
2. "Is this a full accessibility audit?" → No. Eight automated axe rules across six categories on one rendered page state. A useful subset, not certification or WCAG conformance.
3. "How is this different from just running axe?" → We wire it into the agent workflow and keep honest evidence (immutable baseline, conservative gate, same-URL verify after a source repair). The "fix" is the agent editing source — not us switching URLs.
4. "Doesn't this just make findings disappear?" → No — our deltas are conservative: `no_longer_detected`, not "fixed"; an element that vanishes without confirmation is marked uncertain → `review_required`, never a silent pass.
5. "Too slow / does it scale?" → It's a hosted demo, not production. Bounded 45s single scan, concurrency 1 browser, no load numbers yet — we won't fake them.
6. "Security — can anyone scan anything?" → No. Public scans are allowlist-only (our fixture + selected gov domains); redirect limits, private-address/SSRF blocks, redacted untrusted DOM snippets. Reports are anonymous capability-ID keys, expire in 24h.
7. "What about our/source mapping / auto-enforcement?" → We don't do repository-wide source mapping; MCP tool availability is *soft instruction*, not enforcement. We're honest that it's guidance, not a guarantee.
8. "Cloud privacy / cost?" → Private GCS, anonymous IDs, 24h TTL (app-enforced; GCS deletion is eventual). GCP limits: max 1 instance, no autoscaling; **not free** — we give no pricing guarantees.
9. "Government sites?" → Read-only detection only; a never edit or claim to repair them. We show only observed findings.
10. "Is the fix genuinely semantic?" → We forbid generic alt-text, deletion, hidden content. Ambiguous cases are surfaced as review items — we don't guess a fix that changes meaning.
11. "Can I trust the gates?" → Yes by construction: an error/empty/inc-inclusive scan is never a pass; a pass applies only to selected checks/rendered state/recorded conditions.
12. "What's left before it's real?" → Real-browser scan + live API + remote MCP deployment not yet verified; that's the immediate next step, and we'll only claim it when it's measured.

---

## 8. Evidence checklist (what must exist before presenting)

- [ ] Real HTTP audit call → saved `.response.json` (both `audit_page` and `verify_fixes`).
- [ ] Real remote-MCP tool calls captured (both tools) — separate from HTTP stream.
- [ ] Recorded engine versions (axe, Playwright), conditions, ruleset fingerprint, gates.
- [ ] Source diff before/after (real, hashed) for the fixture repair; same-file path kept.
- [ ] No functional regressions: typecheck passes, unit tests pass, e2e run passes, behavior preserved.
- [ ] Measured report: real scan duration, gate values, counts read live from JSON (never hardcoded).
- [ ] 24h baseline expiry + immutable report ID respected.

---

## 9. Central cheat sheet (one card)

- **Opening (30s):** "AI writes UI fast — who checks it? We close the loop: audit → agent repairs source → redeploy same URL → verify, with honest evidence."
- **Closing:** "It's a hosted demo, not production. We prove a real repair loop on a real page — with truthful gates and no overclaiming."
- **Differentiation:** workflow integration + fresh-verification evidence (not detection, not first MCP).
- **Roadmap (differentiators, not promises):** multi-route coverage, integrated CI enforcement, broader rule set, scaling/load, clearer review workflows.
- **Never:** promised money, funding asks, revenue guarantees, scaling/pricing claims, or fabricated stats.

---

## 10. Next concrete tasks (per person)

**Friend A — Presenter:**
1. Rehearse the 30s pitch out loud twice daily.
2. Build the 8-slide deck from §4, keeping every evidence label PLANNED until the Engineer flips it.
3. Run the judge Q&A (§7) with the team as a mock panel.

**Friend B — Demo Runner:**
1. Get the deployed allowlist fixture URL from Engineer; replace all `<BASE_URL>` placeholders.
2. Run `scripts/demo-evidence.mjs audit`/`verify` against the live service and save JSON.
3. Rehearse §5.1 run-of-show; record the labeled fallback segment (with real observed errors, not fabricated).

**Friend C — Engineer (truth-keeper):**
1. Complete integration fixes: `network` tests and real-browser scan path (browser availability).
2. Deploy to Cloud Run `asia-south1` (region approved) and verify `/healthz` + `audit_page` + `verify_fixes` over HTTP *and* MCP.
3. Sign off each evidence claim before it reaches any teammate.

**Friend D (optional) — Video:**
1. Storyboard + record §5.2 segments from real captured artifacts.
2. Only publish after Engineer sign-off.

**Orchestrator (overall):**
1. Unblock Engineer (approve deploy, flag any blocker) so the live loop is verified first.
2. Keep the status table (§0) updated — nothing is "done" until it is verified.

---

*End of strategy. The single highest-value action: **shut the loop once** — one real scan, one real source repair, one redeploy, one re-verify — and capture both HTTP and MCP evidence; that one artifact dominates Technical Implementation (15) and demonstrates Innovation, Presentation, and Feasibility simultaneously.*
