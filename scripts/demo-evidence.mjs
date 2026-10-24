#!/usr/bin/env node
/**
 * demo-evidence.mjs
 *
 * Trusted LOCAL CLI for capturing real hosted hackathon demo evidence against
 * the Accessibility Companion HTTP API. It is intentionally NOT a
 * server-facing tool and performs NO cloud operations. It is a thin,
 * read-only capture client that:
 *
 *   - uses only Node built-ins (global fetch, node:crypto, node:fs/promises)
 *   - records the exact JSON the API returns plus a manifest
 *   - never invents progress, findings, or pass/fail results
 *   - strictly validates the response against the PRD contract before it will
 *     call anything a "clear" pass
 *
 * API contract implemented:
 *   POST /api/v1/audits        { url }                 -> ScanRun
 *   POST /api/v1/verifications { url, baseline_id }    -> VerificationResult
 *   GET  /healthz             (used by the runbook)
 *
 * Contract rules enforced here (see src/contracts.ts):
 *   - schema_version must be "1.0"; run_id must be a UUID.
 *   - execution must be exactly "completed" on ScanRun and verify.current_run.
 *     Any other execution — including the PRD operational failure state
 *     "failed" — is NEVER treated as success.
 *   - counts must be present non-negative integers; no guessed zeros.
 *   - A pass gate with violation_node_count>0, incomplete_node_count>0, or a
 *     non-empty review_items is a contradiction and is rejected.
 *   - Any embedded error object / isError marker is rejected regardless of
 *     gate or HTTP status.
 *   - verification.gate cannot be less restrictive than current_run.gate.
 *   - Missing comparison arrays cause us to refuse a clear verdict.
 *   - requested_url must match the canonical (fragment-less) target; for
 *     verification baseline_id must match the requested baseline.
 *
 * Exit codes (documented in docs/DEMO_RUNBOOK.md):
 *   0  evidence captured, gate clear (pass / no violations)
 *   1  operational error or contract violation (bad args, network, redirect,
 *      non-JSON/oversized/truncated body, HTTP>=400, execution!="completed"
 *      incl. "failed", gate=not_evaluated, missing/invalid PRD fields,
 *      contradictory pass, error markers, baseline/target mismatch,
 *      verification gate less restrictive than current_run, or save failure)
 *   2  evidence captured, gate reports violations or review required (fail /
 *      review_required / still_detected)
 *
 * This script is trusted to run locally only. Never expose it as a tool on
 * the server. All saved files are mode 0600, directories 0700.
 */

'use strict';

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';

const PROG = 'demo-evidence.mjs';
const DEFAULT_OUT = '.accessibility-mcp/demo';
const REQUEST_TIMEOUT_MS = 55_000;
const MAX_BODY_BYTES = 12 * 1024 * 1024; // 12 MiB

const KNOWN_GATES = new Set(['pass', 'fail', 'review_required', 'not_evaluated']);
const GATE_RANK = { pass: 0, review_required: 1, fail: 2, not_evaluated: 3 };
const COUNT_KEYS = [
  'violation_rule_count',
  'violation_node_count',
  'incomplete_node_count',
  'returned_finding_count',
  'omitted_finding_count',
];
const COMPARISON_KEYS = [
  'no_longer_detected_ids',
  'newly_detected_ids',
  'remaining_ids',
  'uncertain_baseline_ids',
];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class UsageError extends Error {}
class OperationalError extends Error {}

// ---------------------------------------------------------------------------
// strict flag parsing
// ---------------------------------------------------------------------------

const FLAG_SPECS = {
  audit: {
    base: { required: true },
    url: { required: true },
    out: { required: false },
  },
  verify: {
    base: { required: true },
    url: { required: true },
    baseline: { required: true },
    out: { required: false },
  },
};

function parseArgv(argv) {
  if (argv.length === 0) throw new UsageError('missing command');
  const command = argv[0];
  if (!['audit', 'verify', 'help'].includes(command)) {
    throw new UsageError(`unknown command "${command}"`);
  }
  if (command === 'help') {
    if (argv.length > 1) throw new UsageError('help takes no arguments');
    return { command, opts: {} };
  }
  const spec = FLAG_SPECS[command];
  const opts = {};
  const seen = new Set();
  const rest = argv.slice(1);
  let i = 0;
  while (i < rest.length) {
    const tok = rest[i];
    if (!tok.startsWith('--')) {
      throw new UsageError(`unexpected positional argument "${tok}"`);
    }
    let name;
    let value;
    const eq = tok.indexOf('=');
    if (eq !== -1) {
      name = tok.slice(2, eq);
      value = tok.slice(eq + 1);
    } else {
      name = tok.slice(2);
      if (i + 1 >= rest.length) throw new UsageError(`missing value for --${name}`);
      value = rest[i + 1];
      i += 1;
    }
    if (!(name in spec)) throw new UsageError(`unknown flag --${name}`);
    if (seen.has(name)) throw new UsageError(`duplicate flag --${name}`);
    seen.add(name);
    if (value === '') throw new UsageError(`empty value for --${name}`);
    opts[name] = value;
    i += 1;
  }
  for (const [name, s] of Object.entries(spec)) {
    if (s.required && !(name in opts)) {
      throw new UsageError(`missing required flag --${name}`);
    }
  }
  return { command, opts };
}

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

function validateHttpUrl(raw, label) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new UsageError(`${label} is not a valid absolute URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UsageError(`${label} must use http:// or https://`);
  }
  if (u.username !== '' || u.password !== '') {
    throw new UsageError(`${label} must not contain embedded credentials`);
  }
  return u;
}

function validateBaseline(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id.trim())) {
    throw new UsageError('--baseline must be a valid UUID (run_id style)');
  }
  return id.trim();
}

function canonical(raw) {
  try {
    const u = new URL(String(raw));
    u.hash = '';
    return u.href;
  } catch {
    return String(raw);
  }
}

// ---------------------------------------------------------------------------
// response contract validation
// ---------------------------------------------------------------------------

function requireRecord(v, label) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new OperationalError(`${label} must be a JSON object`);
  }
  return v;
}

/** Recursive, depth-bounded scan for any embedded error marker. */
function hasErrorMarker(node, depth = 0) {
  if (depth > 8 || node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    for (const item of node) if (hasErrorMarker(item, depth + 1)) return true;
    return false;
  }
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'error' || k === 'isError' || k === 'errors') && v) return true;
    if (hasErrorMarker(v, depth + 1)) return true;
  }
  return false;
}

function validateScanRun(run, label) {
  run = requireRecord(run, label);
  if (run.schema_version !== '1.0') {
    throw new OperationalError(`${label}.schema_version must be "1.0" (got ${JSON.stringify(run.schema_version)})`);
  }
  if (typeof run.run_id !== 'string' || !UUID_RE.test(run.run_id)) {
    throw new OperationalError(`${label}.run_id must be a UUID`);
  }
  if (run.execution !== 'completed') {
    throw new OperationalError(
      `${label}.execution must be "completed" — any other execution (including the PRD failure state "failed") is never success (got ${JSON.stringify(run.execution)})`,
    );
  }
  if (typeof run.requested_url !== 'string' || run.requested_url.length === 0) {
    throw new OperationalError(`${label}.requested_url is required`);
  }
  if (typeof run.final_url !== 'string' || run.final_url.length === 0) {
    throw new OperationalError(`${label}.final_url is required`);
  }
  if (typeof run.completed_at !== 'string' || run.completed_at.length === 0) {
    throw new OperationalError(`${label}.completed_at is required`);
  }
  const counts = requireRecord(run.counts, `${label}.counts`);
  for (const k of COUNT_KEYS) {
    const v = counts[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new OperationalError(`${label}.counts.${k} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(run.review_items)) {
    throw new OperationalError(`${label}.review_items must be an array`);
  }
  const gate = run.gate;
  if (typeof gate !== 'string' || !KNOWN_GATES.has(gate)) {
    throw new OperationalError(`${label}.gate must be one of ${[...KNOWN_GATES].join('/')}`);
  }
  if (hasErrorMarker(run)) {
    throw new OperationalError(`${label} embeds an error marker — refusing to treat it as success`);
  }
  return { run, counts, gate };
}

function validateAudit(json, expected) {
  json = requireRecord(json, 'audit');
  const v = validateScanRun(json, 'audit');
  if (canonical(v.run.requested_url) !== expected.target) {
    throw new OperationalError(`audit.requested_url (${v.run.requested_url}) does not match the requested target ${expected.target}`);
  }
  return v;
}

function validateVerification(json, expected) {
  json = requireRecord(json, 'verification');
  if (json.schema_version !== '1.0') {
    throw new OperationalError('verification.schema_version must be "1.0"');
  }
  if (json.baseline_id !== expected.baseline) {
    throw new OperationalError(
      `verification.baseline_id (${JSON.stringify(json.baseline_id)}) does not match requested baseline ${expected.baseline}`,
    );
  }
  const cur = validateScanRun(json.current_run, 'verification.current_run');
  if (canonical(cur.run.requested_url) !== expected.target) {
    throw new OperationalError(`verification.current_run.requested_url does not match the requested target ${expected.target}`);
  }
  const gate = json.gate;
  if (typeof gate !== 'string' || !KNOWN_GATES.has(gate)) {
    throw new OperationalError(`verification.gate must be one of ${[...KNOWN_GATES].join('/')}`);
  }
  const comp = requireRecord(json.comparison, 'verification.comparison');
  for (const k of COMPARISON_KEYS) {
    if (!Array.isArray(comp[k])) {
      throw new OperationalError(`verification.comparison.${k} must be an array (missing arrays mean we refuse a clear verdict)`);
    }
  }
  if (hasErrorMarker(json)) {
    throw new OperationalError('verification embeds an error marker — refusing to treat it as success');
  }
  if (GATE_RANK[gate] < GATE_RANK[cur.gate]) {
    throw new OperationalError(`verification.gate (${gate}) is less restrictive than current_run.gate (${cur.gate})`);
  }
  return { gate, currentGate: cur.gate, comp, currentRun: cur.run };
}

// ---------------------------------------------------------------------------
// verdicts
// ---------------------------------------------------------------------------

function verdictAudit({ gate, counts, run }) {
  if (gate === 'pass') {
    if (counts.violation_node_count > 0 || counts.incomplete_node_count > 0 || run.review_items.length > 0) {
      throw new OperationalError('gate=pass contradicts counts/review_items — refusing to record a false pass');
    }
    return { kind: 'clear', count: counts.violation_node_count, why: `gate=pass (${counts.violation_node_count} violation(s))`, exitCode: 0 };
  }
  if (gate === 'fail') return { kind: 'violations', count: counts.violation_node_count, why: `gate=fail (${counts.violation_node_count} violation(s))`, exitCode: 2 };
  if (gate === 'review_required') return { kind: 'review', count: counts.violation_node_count, why: 'gate=review_required', exitCode: 2 };
  return { kind: 'operational', count: counts.violation_node_count, why: 'gate=not_evaluated', exitCode: 1 };
}

function verdictVerification({ gate, comp }) {
  const nl = comp.no_longer_detected_ids.length;
  const nd = comp.newly_detected_ids.length;
  if (gate === 'pass') {
    if (nd > 0) {
      throw new OperationalError('verification gate=pass but newly_detected_ids is non-empty — refusing a false clear result');
    }
    return { kind: 'clear', nlCount: nl, why: `gate=pass; no_longer_detected=${nl}, newly_detected=0`, exitCode: 0 };
  }
  if (gate === 'fail') return { kind: 'violations', nlCount: nl, why: `gate=fail; still reported (no_longer_detected=${nl})`, exitCode: 2 };
  if (gate === 'review_required') return { kind: 'review', nlCount: nl, why: `gate=review_required (uncertainty; no_longer_detected=${nl})`, exitCode: 2 };
  return { kind: 'operational', nlCount: nl, why: 'gate=not_evaluated', exitCode: 1 };
}

// ---------------------------------------------------------------------------
// HTTP (timeout covers body consumption; redirects refused; body capped)
// ---------------------------------------------------------------------------

async function readBounded(res, ac) {
  if (!res.body) {
    const text = await res.text();
    const buf = Buffer.from(text, 'utf8');
    if (buf.length > MAX_BODY_BYTES) throw new OperationalError(`response body exceeds ${MAX_BODY_BYTES} byte limit`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let r;
    try {
      r = await reader.read();
    } catch (e) {
      if (ac.signal.aborted) throw new OperationalError(`response/body timed out after ${REQUEST_TIMEOUT_MS}ms`);
      throw e;
    }
    if (r.done) break;
    const b = Buffer.from(r.value);
    total += b.length;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new OperationalError(`response body exceeds ${MAX_BODY_BYTES} byte limit`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, total);
}

async function apiPost(baseUrl, apiPath, body, tag) {
  const url = new URL(apiPath, baseUrl);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
      redirect: 'error', // refuse redirects: never re-POST to an unrelated origin
    });
  } catch (e) {
    clearTimeout(timer);
    if (ac.signal.aborted) throw new OperationalError(`${tag}: request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    const why = e?.cause?.code ?? e?.name ?? 'fetch';
    throw new OperationalError(`${tag}: request failed (${why}): ${e.message ?? e}`);
  }
  try {
    const buf = await readBounded(res, ac);
    const httpStatus = res.status;
    const text = buf.toString('utf8');
    if (!text.trim()) throw new OperationalError(`${tag}: empty body (HTTP ${httpStatus})`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new OperationalError(`${tag}: non-JSON body (HTTP ${httpStatus})`);
    }
    return { httpStatus, json };
  } catch (e) {
    if (e instanceof OperationalError) throw e;
    if (ac.signal.aborted) throw new OperationalError(`${tag}: timed out after ${REQUEST_TIMEOUT_MS}ms while reading body`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// atomic persistence (dir 0700, files 0600)
// ---------------------------------------------------------------------------

async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, filePath);
  return filePath;
}

function buildManifest({ cmd, base, target, baseline, httpStatus, execution, gate, runId, responseBaselineId, classification, durationMs, responseName, manifestName }) {
  return {
    schema: 1,
    kind: cmd,
    command: cmd,
    source: 'http-cli',
    capturedAtUTC: new Date().toISOString(),
    durationClientMs: durationMs,
    base: base.href,
    target: target.href,
    runID: runId ?? null,
    baselineID: baseline ?? responseBaselineId ?? null,
    execution: execution ?? null,
    gate: gate ?? null,
    httpStatus,
    outcome: classification.why,
    exitCode: classification.exitCode,
    files: { response: responseName, manifest: manifestName },
  };
}

async function saveEvidence(ctx) {
  const sub = ctx.cmd === 'audit' ? 'audits' : 'verifications';
  const dir = path.join(ctx.outDir, sub);
  const id = randomUUID();
  const responseName = `${id}.response.json`;
  const manifestName = `${id}.manifest.json`;

  const responseAbs = await atomicWriteJson(path.join(dir, responseName), ctx.json);

  const manifest = buildManifest({
    cmd: ctx.cmd,
    base: ctx.base,
    target: ctx.target,
    baseline: ctx.baseline,
    httpStatus: ctx.httpStatus,
    execution: ctx.execution,
    gate: ctx.gate,
    runId: ctx.runId,
    responseBaselineId: ctx.responseBaselineId,
    classification: ctx.classification,
    durationMs: ctx.durationMs,
    responseName,
    manifestName,
  });
  const manifestAbs = await atomicWriteJson(path.join(dir, manifestName), manifest);

  return { responseAbs, manifestAbs, responseName, manifestName };
}

// ---------------------------------------------------------------------------
// command execution
// ---------------------------------------------------------------------------

function pickFirst(obj, keys) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

async function runCommand(cmd, { base, target, baseline, outDir }) {
  const t0 = performance.now();

  const apiPath = cmd === 'audit' ? '/api/v1/audits' : '/api/v1/verifications';
  const payload = cmd === 'audit' ? { url: target.href } : { url: target.href, baseline_id: baseline };

  const { httpStatus, json } = await apiPost(base, apiPath, payload, cmd);
  const expectedTarget = canonical(target.href);

  let classification;
  let meta;
  if (httpStatus >= 400) {
    // API error: still capture the real error body as evidence, but never success.
    classification = { kind: 'operational', why: `HTTP ${httpStatus}`, exitCode: 1 };
    meta = {
      runId: pickFirst(json, ['run_id', 'runId']),
      gate: pickFirst(json, ['gate']),
      execution: pickFirst(json, ['execution']),
      baselineId: pickFirst(json, ['baseline_id', 'baselineId']),
    };
  } else if (cmd === 'audit') {
    const v = validateAudit(json, { target: expectedTarget });
    classification = verdictAudit(v);
    meta = { runId: v.run.run_id, gate: v.gate, execution: 'completed', baselineId: null };
  } else {
    const v = validateVerification(json, { target: expectedTarget, baseline });
    classification = verdictVerification(v);
    meta = { runId: v.currentRun.run_id, gate: v.gate, execution: 'completed', baselineId: json.baseline_id };
  }

  const durationMs = Math.round(performance.now() - t0);

  const files = await saveEvidence({
    cmd,
    base,
    target,
    baseline,
    httpStatus,
    execution: meta.execution,
    gate: meta.gate,
    runId: meta.runId,
    responseBaselineId: meta.baselineId,
    classification,
    durationMs,
    json,
    outDir,
  });

  return { base, target, baseline, runId: meta.runId, gate: meta.gate, httpStatus, classification, files };
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function printSummary(cmd, r) {
  console.log(`${PROG}: ${cmd} evidence captured`);
  console.log(`  base:      ${r.base.href}`);
  console.log(`  target:     ${r.target.href}`);
  if (cmd === 'verify') console.log(`  baseline:   ${r.baseline}`);
  console.log(`  runID:      ${r.runId ?? '(none)'}`);
  console.log(`  gate:       ${r.gate ?? '(unknown)'}`);
  console.log(`  httpStatus: ${r.httpStatus}`);
  console.log(`  outcome:    ${r.classification.why}`);
  if (cmd === 'audit' && r.classification.count !== undefined) {
    console.log(`  violations:  ${r.classification.count} (actual count from response only)`);
  }
  if (cmd === 'verify' && r.classification.nlCount !== undefined) {
    console.log(`  no_longer_detected: ${r.classification.nlCount} (read from comparison, never called "fixed")`);
  }
  console.log('  saved:');
  console.log(`    ${r.files.responseAbs}`);
  console.log(`    ${r.files.manifestAbs}`);
  console.log('');
  console.log('  NOTE: report/run IDs are a PRIVATE capability. Do not paste them');
  console.log('  into public slides, videos, shareable decks, or commit logs.');
  console.log(`  Exit code ${r.classification.exitCode} (see docs/DEMO_RUNBOOK.md for the exit-code table).`);
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node scripts/${PROG} <command> [flags]

Commands:
  audit   POST /api/v1/audits {url} -> ScanRun, validates it, saves it as evidence.
  verify  POST /api/v1/verifications {url,baseline_id} -> VerificationResult, validates it, saves it.
  help    Print this help (no network).

Flags (strict; unknown/duplicate flags are rejected):
  --base <url>      API base origin, http(s)://host[:port]. No credentials.
  --url <url>       Target to audit/verify. Same http(s) rules.
  --baseline <uuid> (verify only) baseline run_id returned by a prior audit.
  --out <dir>       Output directory (default: ${DEFAULT_OUT}).

Examples:
  node scripts/${PROG} audit --base https://staging.example.com \
        --url https://www.example.gov --out /tmp/demo
  node scripts/${PROG} verify --base https://staging.example.com \
        --url https://www.example.gov --baseline 3f6d4b2e-4b2a-4f3e-9d1c-000000000001

Exit codes:
  0  evidence captured, gate clear (pass / no violations).
  1  operational error or contract violation: bad args; network/redirect;
     non-JSON, oversized, or truncated body; HTTP>=400; execution!="completed"
     (including the PRD failure state "failed"); gate=not_evaluated; missing
     or invalid PRD fields; a contradictory pass (violations/incomplete/
     review_items present); embedded error markers; baseline/target mismatch;
     verification gate less restrictive than current_run; missing comparison
     arrays; or save failure. Evidence may or may not exist.
  2  evidence captured, gate reports violations or review required (fail /
     review_required / still_detected).

Security: this is a trusted local capture CLI. Do NOT expose it as a server
tool. It never logs page HTML, refuses redirects, caps response bodies at
12 MiB, and prints only summaries + report IDs to the local terminal.`;
// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}`);
      console.error(`\n${USAGE}`);
      process.exit(1);
    }
    throw e;
  }

  if (parsed.command === 'help') {
    console.log(USAGE);
    return;
  }

  const opts = parsed.opts;
  try {
    const base = validateHttpUrl(opts.base, '--base');
    const target = validateHttpUrl(opts.url, '--url');
    let baseline;
    if (parsed.command === 'verify') baseline = validateBaseline(opts.baseline);
    const outDir = path.resolve(opts.out ?? DEFAULT_OUT);

    const result = await runCommand(parsed.command, { base, target, baseline, outDir });
    printSummary(parsed.command, result);
    process.exit(result.classification.exitCode);
  } catch (e) {
    if (e instanceof OperationalError || e instanceof UsageError) {
      console.error(`error: ${e.message}`);
      if (process.env.DEMO_EVIDENCE_DEBUG) console.error(e);
      process.exit(1);
    }
    console.error(`internal error: ${e?.stack ?? e}`);
    process.exit(1);
  }
}

main();
