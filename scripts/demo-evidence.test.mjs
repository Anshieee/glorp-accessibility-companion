/**
 * Unit tests for scripts/demo-evidence.mjs.
 *
 * These are synthetic, clearly unit-level checks against a LOCAL fixture HTTP
 * server (127.0.0.1). They are NOT evidence and NOT a scanner. No cloud
 * operations, no real service, no scanner invocation.
 *
 * Each test runs the CLI as a child process (node scripts/demo-evidence.mjs)
 * against the fixture server and asserts the exit code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(ROOT, 'demo-evidence.mjs');
const BASE_UUID = '11111111-2222-3333-4444-555555555555';
const CUR_RUN_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// fixture server
// ---------------------------------------------------------------------------

function makeScan(over = {}, url) {
  const u = url ?? 'https://demo.example.org/scenarios/pass';
  const base = {
    schema_version: '1.0',
    run_id: BASE_UUID,
    execution: 'completed',
    started_at: '2026-10-24T00:00:00Z',
    completed_at: '2026-10-24T00:00:01Z',
    requested_url: u,
    final_url: u,
    page_title: 'Fixture',
    conditions: { viewport: { width: 1280, height: 800 }, color_scheme: 'light', browser_locale: 'en', readiness_selector: null, scope: 'full_page' },
    engine: { axe_version: 'x', playwright_version: 'y', rule_ids: [], ruleset_fingerprint: 'f' },
    coverage: { categories: [], evaluated_rule_ids: [], inapplicable_rule_ids: [], incomplete_rule_ids: [], current_rendered_state_only: true, frame_coverage: 'main_document_only' },
    counts: { violation_rule_count: 0, violation_node_count: 0, incomplete_node_count: 0, returned_finding_count: 0, omitted_finding_count: 0 },
    findings: [],
    review_items: [],
    gate: 'pass',
    details_truncated: false,
    report_path: 'runs/x.json',
    warnings: [],
    limitations: [],
  };
  return { ...base, ...over, counts: { ...base.counts, ...(over.counts || {}) } };
}

function scenarioOf(u) {
  try {
    const parts = new URL(u).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let payload = {};
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch {}
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        const s = scenarioOf(payload.url || '');
        const mk = (over = {}) => makeScan(over, payload.url);
        const verif = (over) =>
          send(200, {
            schema_version: '1.0',
            baseline_id: payload.baseline_id,
            current_run: makeScan({ run_id: CUR_RUN_ID, gate: 'pass', ...(over.currentRun || {}) }, payload.url),
            comparison: {
              comparable: true,
              remaining_ids: [],
              newly_detected_ids: [],
              no_longer_detected_ids: [],
              uncertain_baseline_ids: [],
              notes: [],
              ...(over.comparison || {}),
            },
            gate: over.gate ?? 'pass',
            completion_claim: '',
          });

        if (req.method === 'POST' && req.url === '/api/v1/audits') {
          switch (s) {
            case 'pass': return send(200, mk());
            case 'fail': return send(200, mk({ gate: 'fail', counts: { violation_node_count: 2, violation_rule_count: 2 }, findings: [{ id: 'a' }] }));
            case 'review': return send(200, mk({ gate: 'review_required', review_items: [{ rule_id: 'r', targets: ['x'], reason: 'z', html: null }] }));
            case 'not-evaluated': return send(200, mk({ gate: 'not_evaluated' }));
            case 'exec-failed': return send(200, mk({ execution: 'failed', gate: 'pass' }));
            case 'exec-running': return send(200, mk({ execution: 'running', gate: 'pass' }));
            case 'incomplete-pass': return send(200, mk({ gate: 'pass', counts: { incomplete_node_count: 2 } }));
            case 'pass-violations': return send(200, mk({ gate: 'pass', counts: { violation_node_count: 1 } }));
            case 'pass-review-items': return send(200, mk({ gate: 'pass', review_items: [{ rule_id: 'r', targets: ['x'], reason: '', html: null }] }));
            case 'missing-counts': {
              const sc = mk();
              delete sc.counts;
              return send(200, sc);
            }
            case 'bad-schema': return send(200, mk({ schema_version: '2.0' }));
            case 'bad-runid': return send(200, mk({ run_id: 'not-a-uuid' }));
            case 'errorobj': return send(200, { ...mk(), error: 'boom' });
            case 'unknown-gate': return send(200, mk({ gate: 'maybe' }));
            case 'nonjson': {
              res.writeHead(200, { 'content-type': 'text/plain' });
              res.end('this is not json');
              return;
            }
            case 'trunc': {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.write('{"schema_version":"1.0",');
              res.socket.destroy();
              return;
            }
            case 'redirect': {
              res.writeHead(302, { location: 'https://evil.example.org/' });
              res.end();
              return;
            }
            case 'huge': {
              const buf = Buffer.alloc(13 * 1024 * 1024, 'a');
              res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
              res.end(buf);
              return;
            }
            case 'mismatch-target': return send(200, mk({ requested_url: 'https://other.example/' }));
            default: return send(200, mk());
          }
        }

        if (req.method === 'POST' && req.url === '/api/v1/verifications') {
          switch (s) {
            case 'verify-pass': return verif({ gate: 'pass', comparison: { no_longer_detected_ids: ['a', 'b'] } });
            case 'verify-fail': return verif({ gate: 'fail', comparison: { newly_detected_ids: ['c'] } });
            case 'verify-review': return verif({ gate: 'review_required', comparison: { uncertain_baseline_ids: ['x'] } });
            case 'verify-lessrestrictive': return verif({ gate: 'pass', currentRun: { gate: 'fail' } });
            case 'verify-missing-arrays':
              return send(200, {
                schema_version: '1.0',
                baseline_id: payload.baseline_id,
                current_run: mk({ run_id: CUR_RUN_ID }),
                comparison: { comparable: true },
                gate: 'pass',
                completion_claim: '',
              });
            case 'verify-baseline-mismatch': {
              return send(200, {
                schema_version: '1.0',
                baseline_id: '99999999-0000-0000-0000-000000000000',
                current_run: mk({ run_id: CUR_RUN_ID }),
                comparison: { comparable: true, remaining_ids: [], newly_detected_ids: [], no_longer_detected_ids: [], uncertain_baseline_ids: [], notes: [] },
                gate: 'pass',
                completion_claim: '',
              });
            }
            case 'verify-not-evaluated': return verif({ gate: 'not_evaluated', currentRun: { gate: 'not_evaluated' } });
            case 'verify-pass-newlydetected': return verif({ gate: 'pass', comparison: { newly_detected_ids: ['c'] } });
            default: return verif({ gate: 'pass' });
          }
        }

        send(404, { error: 'not found' });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout ?? 15000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function audit(base, scenario, extra = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-'));
  const target = `https://demo.example.org/scenarios/${scenario}`;
  const r = await runCli(['audit', '--base', base, '--url', target, '--out', dir, ...extra]);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return r;
}

async function verify(base, scenario, baseline = BASE_UUID) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-'));
  const target = `https://demo.example.org/scenarios/${scenario}`;
  const r = await runCli(['verify', '--base', base, '--url', target, '--baseline', baseline, '--out', dir]);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return r;
}

// ---------------------------------------------------------------------------
// suites
// ---------------------------------------------------------------------------

test('demo-evidence: CLI help and arg validation', async (t) => {
  const h = await runCli(['help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /Exit codes/);

  const noargs = await runCli([]);
  assert.equal(noargs.code, 1);

  const badScheme = await runCli(['audit', '--base', 'ftp://x', '--url', 'https://example.org/']);
  assert.equal(badScheme.code, 1);

  const credBase = await runCli(['audit', '--base', 'https://u:p@example.com', '--url', 'https://example.org/']);
  assert.equal(credBase.code, 1);

  const verifyNoBaseline = await runCli(['verify', '--base', 'https://example.com', '--url', 'https://example.org/']);
  assert.equal(verifyNoBaseline.code, 1);

  const badBaseline = await runCli(['verify', '--base', 'https://example.com', '--url', 'https://example.org/', '--baseline', 'nope']);
  assert.equal(badBaseline.code, 1);
});

test('demo-evidence: audit gate outcomes and contract violations', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // clear pass -> 0
    assert.equal((await audit(base, 'pass')).code, 0, 'pass');
    // fail -> 2
    assert.equal((await audit(base, 'fail')).code, 2, 'fail');
    // review_required -> 2
    assert.equal((await audit(base, 'review')).code, 2, 'review');
    // not_evaluated -> 1
    assert.equal((await audit(base, 'not-evaluated')).code, 1, 'not_evaluated');

    // execution=failed with gate=pass -> NEVER success -> 1
    assert.equal((await audit(base, 'exec-failed')).code, 1, 'execution=failed + gate=pass must not be success');
    // execution=running -> 1
    assert.equal((await audit(base, 'exec-running')).code, 1, 'execution=running');

    // contradictory pass -> 1
    assert.equal((await audit(base, 'incomplete-pass')).code, 1, 'pass + incomplete_node_count>0');
    assert.equal((await audit(base, 'pass-violations')).code, 1, 'pass + violation_node_count>0');
    assert.equal((await audit(base, 'pass-review-items')).code, 1, 'pass + review_items non-empty');

    // malformed / missing PRD fields -> 1
    assert.equal((await audit(base, 'missing-counts')).code, 1, 'missing counts');
    assert.equal((await audit(base, 'bad-schema')).code, 1, 'bad schema_version');
    assert.equal((await audit(base, 'bad-runid')).code, 1, 'run_id not UUID');
    assert.equal((await audit(base, 'unknown-gate')).code, 1, 'unknown gate');
    assert.equal((await audit(base, 'mismatch-target')).code, 1, 'requested_url mismatch');
    assert.equal((await audit(base, 'errorobj')).code, 1, 'embedded error object');

    // transport / body issues -> 1
    assert.equal((await audit(base, 'nonjson')).code, 1, 'non-JSON');
    assert.equal((await audit(base, 'trunc')).code, 1, 'truncated body');
    assert.equal((await audit(base, 'redirect')).code, 1, 'redirect refused');
    assert.equal((await audit(base, 'huge')).code, 1, 'oversized body');
  } finally {
    server.close();
  }
});

test('demo-evidence: verification outcomes and contract violations', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // clear pass -> 0
    assert.equal((await verify(base, 'verify-pass')).code, 0, 'verify pass');
    // fail -> 2
    assert.equal((await verify(base, 'verify-fail')).code, 2, 'verify fail');
    // review_required with current pass -> 2 (allowed: not less restrictive)
    assert.equal((await verify(base, 'verify-review')).code, 2, 'verify review');

    // verification gate less restrictive than current_run -> 1
    assert.equal((await verify(base, 'verify-lessrestrictive')).code, 1, 'verify gate less restrictive than current_run');
    // missing comparison arrays -> refuse clear -> 1
    assert.equal((await verify(base, 'verify-missing-arrays')).code, 1, 'missing comparison arrays');
    // baseline mismatch -> 1
    assert.equal((await verify(base, 'verify-baseline-mismatch')).code, 1, 'baseline mismatch');
    // not_evaluated -> 1
    assert.equal((await verify(base, 'verify-not-evaluated')).code, 1, 'verify not_evaluated');
    // pass but newly_detected present -> 1
    assert.equal((await verify(base, 'verify-pass-newlydetected')).code, 1, 'verify pass with newly_detected');
  } finally {
    server.close();
  }
});
