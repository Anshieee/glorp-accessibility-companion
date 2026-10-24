# Demo Evidence Runbook

**Status: NOT LIVE — no application metrics exist yet.** The hosted service is
still being stood up; every `<BASE_URL>` below is a placeholder. This runbook
is a rehearsal-ready script for capturing **real** evidence once the service is
live. Do not present anything captured against a placeholder, mock, or local
server as live production evidence.

## 1. Principles (what counts as evidence)

- **Real only.** Every finding, count, gate, and run ID comes from the actual
  hosted API response as saved by `scripts/demo-evidence.mjs`. Never fabricate
  progress, synthetic findings, or pass/fail verdicts.
- **Evidence is the saved JSON**, not the terminal echo. The terminal prints a
  summary only; the authoritative artifacts are the `.response.json` and
  `.manifest.json` files the script writes.
- **The capture CLI is the HTTP client — it is NOT the MCP tooling.** They prove
  different things. The CLI proves the hosted HTTP API. The OpenCode MCP tools
  prove the same service is reachable through the MCP v2 interface. Keep these
  claims separate; never imply the CLI is a tool.
- **Never hardcode expected counts or performance numbers** in slides or the
  narrative. Reads them live from the captured JSON at presentation time.
- **No auth / no production claims** unless the service actually enforces them.
  State exactly what was exercised.

## 2. Prerequisites

- Node.js 24+ (built-in `fetch`, `crypto.randomUUID`).
- The repo checked out: `scripts/demo-evidence.mjs`, `src/contracts.ts`.
- `curl` and `jq` available on the demo machine for the HTTP proof.
- `opencode` CLI for the MCP v2 proof.

## 3. Placeholders

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `<BASE_URL>` | Origin of the hosted API (scheme + host + optional port). No trailing path, no credentials. | `https://staging.acme.example.com` |
| `<GOV_URL>` | The public government homepage you scan read-only. | `https://www.example.gov/` |
| `<FIXTURE_URL>` | Your own deployed fixture page (your sandbox). | `https://sandbox.acme.example.com/` |
| `<BASELINE_ID>` | UUID run_id from a prior audit. | `3f6d4b2e-…` |
| `<MCP_TOOL>` | Tool name the accessibility MCP server exposes. | `accessibility_scan` |

## 4. The evidence CLI

```
node scripts/demo-evidence.mjs audit --base <BASE_URL> --url <GOV_URL> [--out <dir>]
node scripts/demo-evidence.mjs verify --base <BASE_URL> --url <GOV_URL> --baseline <BASELINE_ID> [--out <dir>]
node scripts/demo-evidence.mjs help
```

- Default output: `.accessibility-mcp/demo` (directories 0700, files 0600).
- Writes the exact API JSON plus a manifest containing `capturedAtUTC`,
  `durationClientMs`, `source`, `target`, `base`, `runID`, `baselineID`,
  `gate`, and `httpStatus` under exclusive random-UUID filenames.
- Strict flags; invalid/credentialed URLs and non-UUID baselines are rejected.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Evidence captured, gate clear (`pass`, no violations). |
| 1 | Operational error or contract violation: bad args, network/redirect, non-JSON/oversized/truncated body, HTTP >= 400, `gate=not_evaluated`, execution != `"completed"` (including the PRD failure state `"failed"`), missing/invalid PRD fields, a contradictory pass (violations/incomplete/review present), embedded error markers, baseline/target mismatch, verification gate less restrictive than `current_run`, missing comparison arrays, or save failure. |
| 2 | Evidence captured, gate reports violations or review required (`fail` / `review_required` / still `_detected`). |

`execution` must be exactly `"completed"`. Any other value — including the PRD
operational failure state `"failed"` — is **never** treated as success,
regardless of the rest of the payload, and the response is rejected (exit 1).

### Strict contract validation

Before the CLI reports a "clear" pass it validates the response against the PRD
contract: `schema_version === "1.0"`, `run_id` is a UUID, `requested_url` /
`final_url` / `completed_at` present, all `counts` are non-negative integers
(no guessed zeros), the gate is known, and no embedded error marker exists. A
`pass` gate with `violation_node_count > 0`, `incomplete_node_count > 0`, or a
non-empty `review_items` is rejected as a contradiction. For verification, the
response must match the requested `baseline_id` and canonical target, the
`comparison` arrays must be present, and `gate` cannot be less restrictive than
`current_run.gate`.

## 5. Part A — prove the HTTP API directly (curl + CLI)

Run against the live `<BASE_URL>`. All of these are read-only against the
service.

```bash
# 1. Health
curl -fsS <BASE_URL>/healthz | jq .

# 2. Audit (http capture) — this is the reproducible evidence artifact
node scripts/demo-evidence.mjs audit --base <BASE_URL> --url <GOV_URL> --out .accessibility-mcp/demo
echo "exit=$?"   # record this

# 3. Note the run_id / baseline returned (or read it from the saved manifest)
<BASELINE_ID>=$(jq -r '.runID' .accessibility-mcp/demo/audits/*.manifest.json)

# 4. Verification against that baseline
node scripts/demo-evidence.mjs verify --base <BASE_URL> --url <GOV_URL> --baseline "$<BASELINE_ID>" --out .accessibility-mcp/demo
echo "exit=$?"
```

When the site still has violations, expect exit 2 — that is **correct** and is
itself the evidence. If the service returns a non-JSON body or HTTP >= 400, the
script exits 1 with a clear message; never fake a 0.

## 6. Part B — prove OpenCode MCP v2 tools (not just HTTP)

The HTTP capture proves the REST API. Separately, prove the service is usable
through the OpenCode MCP v2 interface **without modifying the authoritative
`opencode.json`**.

1. Locate the installed official v2 config that declared the accessibility MCP
   server. In this repo the live config is `opencode.json` at the root
   (currently registers `gcloud-mcp`). The accessibility server entry arrives
   with the same deployment.
2. **Do not overwrite `opencode.json`.** Work from a scratch copy:

   ```bash
   cp opencode.json /tmp/opencode/opencode.demo.json
   ```

3. In `/tmp/opencode/opencode.demo.json`, under `mcp.servers`, copy the
   accessibility server entry verbatim from the official installed config, and
   set the remote server override:

   ```json
   {
     "mcp": {
       "servers": {
         "<MCP_SERVER_NAME>": {
           "type": "remote",
           "url": "<BASE_URL>/mcp",
           "oauth": false,
           "enabled": true
         }
       }
     }
   }
   ```

   Keep the copied entry's real URL/token shape; only normalize
   `"oauth": false` for the remote handshake. Do not touch the actual
   `opencode.json`.
4. Launch opencode against the scratch config so the real config stays intact:
   ```bash
   OPENCODE_CONFIG=/tmp/opencode/opencode.demo.json opencode
   ```
5. In the session, connect the server and call the tool on `<GOV_URL>`:
   ```
   /mcp connect <MCP_SERVER_NAME>
   <MCP_TOOL> url=<GOV_URL>
   ```
6. Record the MCP tool's live result. This proves the MCP v2 path end to end.

> The CLI (Part A) and the MCP tool (Part B) are separate evidence streams.
> Do not claim the CLI is an MCP tool.

## 7. Part C — the demo narrative (two segments)

### Segment 1 — read-only scan of the public government homepage

1. `curl <BASE_URL>/healthz` (fast, shows the service is up).
2. Run the audit via the CLI against `<GOV_URL>`.
3. Show the **actual** gate, violation counts, and report/run ID from the saved
   JSON. Read these numbers live from the file — never from a hardcoded slide.
4. This is read-only: we do not edit the government site.

### Segment 2 — own fixture: fix loop with verification

Run **your own** fixture (`<FIXTURE_URL>`), never the government site:

1. **Baseline audit:** `… audit --base <BASE_URL> --url <FIXTURE_URL>` →
   save the run_id as `<BASELINE_ID>`.
2. **Agent edits source** (in a scratch branch), e.g. the fixture repo.
3. **Record the actual source diff and build digest** — not a prepared URL
   switch:
   ```bash
   git diff --stat                          # real diff
   git rev-parse HEAD                       # commit digest
   # or hash the built artifact:
   sha256sum dist/index.html
   ```
4. **Behavior tests** pass for the change.
5. **Redeploy to the SAME `<FIXTURE_URL>`** (same URL, not a new page).
6. **Wait** for the health endpoint and confirm the page content changed
   (`curl <BASE_URL>/healthz`, `curl -s <FIXTURE_URL> | grep <expected-text>`).
7. **MCP verify** the baseline: call the MCP verification tool (Part B) with
   `<BASELINE_ID>` and `<FIXTURE_URL>`.
8. **Additionally capture via HTTP** for reproducibility:
   ```bash
   node scripts/demo-evidence.mjs verify --base <BASE_URL> --url <FIXTURE_URL> --baseline <BASELINE_ID>
   ```
   Print the `no_longer_detected` count verbatim — say **"no_longer_detected"**,
   never "fixed", unless the API literally reports something else.

## 8. Repair protocol

- **Max 3 repair batches** per demo fix. After batch 3, stop editing and show
  the real remaining state.
- **Baseline expiry = 24h.** A baseline older than 24h must be re-captured with
  a fresh audit before verification.
- **Report / run IDs are a private capability.** Do not put them in public
  slides, videos, or shareable decks.

## 9. Rehearsal and fallbacks

Run a **3-minute rehearsal** end to end before the demo.

- If `<GOV_URL>` is unreachable or errors: **show the error** (exit 1 output)
  — never a fake success. Then fall back to the **own fixture** segment as a
  backup, clearly stating the government segment was unavailable.
- If Part B (MCP) fails to connect: show the failure, then continue with Part A
  only. Never claim the MCP tools ran if they did not.
- If the fixture is broken, stop and fix it — do not substitute a different URL
  and call it "the same".

## 10. Shipping tasks (landing page for teammates/friends)

The landing page is a **React + TypeScript + Vite** SPA, same-origin with the
API:

- `VITE_API_BASE_URL` is the only public env var; commit a `.env.example` (no
  secrets). Never commit real tokens, `.env`, or `node_modules`.
- Publish only `src/components` and static assets; keep server secrets out of
  the bundle.
- Build locally, confirm the SPA calls `<BASE_URL>` and renders the real
  captured JSON (read from `.accessibility-mcp/demo/*.json`).

## 11. Presentation materials (PPT/video)

- Pull numbers **from the saved JSON after implementation**:
  - `…audits/*.response.json` → `counts`, `gate`, `run_id`;
  - `…verifications/*.response.json` → `comparison.no_longer_detected_ids` length;
  - `….manifest.json` → `capturedAtUTC`, `durationClientMs`, `target`, `base`.
- Screenshot the live MCP tool output for the tooling segment.
- Never hardcode expected counts or latency numbers.

## 12. Security / compliance notes

- The repo repo is a trusted local capture tool — do not expose it as a server
  endpoint.
- Never log page HTML to the terminal.
- Unless the API proves otherwise, default to "no auth, no production claim".
- Report IDs are sensitive capabilities — keep them local.
