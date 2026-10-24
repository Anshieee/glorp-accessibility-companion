# MCP Showcase — Accessibility Companion

How to connect the hosted Accessibility Companion MCP server and demo the before/after repair loop. Hosted demo only: no login, no secrets, no production claims.

## 1. Prerequisites

- Node.js >= 22 < 25 (`node --version`).
- A running server base URL (no trailing path, no credentials):
  - Local dev: `http://127.0.0.1:8097` (start with `PORT=8097`). Port 8080 is unavailable — do not use it.
  - Deployed: `<DEPLOYED_BASE_URL>` (replace with the real Cloud Run URL once live; never invent one).
- `opencode` CLI installed.
- A served demo pair: `demo/before.html` (flawed) and `demo/after.html` (repaired), served at the **same URL** before/after the fix. See §4.

> Localhost is reachable only in local dev mode (`ACCESSIBILITY_ALLOW_LOCAL=true`, developer tests only — never on Cloud Run). The deployed server scans only its allowlist (own editable fixture + selected read-only government domains). Do not expect an arbitrary local/demo URL to scan on the deployed server.

## 2. Connect via OpenCode

Register the remote server (Streamable HTTP MCP at `/mcp`):

```bash
opencode mcp add accessibility-companion --url <BASE_URL>/mcp
```

Where `<BASE_URL>` is `http://127.0.0.1:8097` locally or `https://<DEPLOYED_BASE_URL>` when deployed.

Verify it is connected:

```bash
opencode mcp list
# expect: accessibility-companion — connected
```

If it is not connected, stop here and report the connection failure. Do not claim tool results without a live connection. See `docs/AGENT_INSTRUCTIONS.md` for the authoritative repair loop and `docs/DEMO_RUNBOOK.md` for the full evidence script.

## 3. The two tools

Discovery returns exactly two tools:

| Tool | Input | What it does |
| --- | --- | --- |
| `audit_page` | `url` (string) | Fresh scan of the rendered page on the allowlisted URL. Returns `run_id` (keep as baseline), `gate`, counts, findings with selectors/snippets, and the 8-rule / 6-category coverage. |
| `verify_fixes` | `url` + `baseline_id` (opaque `run_id` from a prior `audit_page`) | Fresh scan of the **same URL**, compared against the baseline. Returns current `gate` plus `no_longer_detected` / `still_detected` / `newly_detected`. |

Rules: only direct tool calls count. The `gate` (`pass` / `fail` / `review_required` / `not_evaluated`) is authoritative — never override it. On `pass`, use only the verbatim wording from `docs/AGENT_INSTRUCTIONS.md` §7.

## 4. Before/after demo script

Serve `demo/before.html` at your demo URL (`<DEMO_URL>`), then repair the source and re-serve `demo/after.html` content at the **same URL**. Switching URLs is not repair evidence.

```text
1. Serve the flawed page at <DEMO_URL> (content of demo/before.html).
   Wait for readiness (page responds, expected content present).

2. Baseline audit (in the OpenCode session with the MCP connected):
   audit_page(url=<DEMO_URL>)
   -> save run_id as <BASELINE_ID>. Record the real gate and counts.
      Expected: gate=fail (violations present). Read numbers from the
      tool response — never hardcode them.

3. Fix the source (demo/after.html content): add the missing labels,
   names, alt text, lang, and contrast fixes in the actual source,
   preserving handlers, IDs, navigation, validation, and layout.
   Max 3 repair batches (per docs/AGENT_INSTRUCTIONS.md).

4. Redeploy to the SAME <DEMO_URL>. Wait for readiness again.

5. Verify (same URL, same session):
   verify_fixes(url=<DEMO_URL>, baseline_id=<BASELINE_ID>)
   -> record the real gate and comparison arrays.
      Expected: gate moves toward pass; check no_longer_detected vs.
      still_detected / newly_detected honestly. Any remaining fail or
      review_required is reported as-is.

6. Report: latest run ID, tested URL, selected coverage (8 rules /
   6 categories), and outstanding review items.
```

No recorded results ship with this doc — every gate, count, and ID must come from a live run. Report IDs are capabilities (24h TTL); keep them out of slides and public surfaces.
