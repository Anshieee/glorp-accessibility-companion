#!/usr/bin/env node
/*
 * Agent source-repair evidence — MECHANICAL, REPRODUCIBLE (not a host-model demonstration).
 *
 * Replays, against a disposable copy in a temp dir, the exact same on-disk repair steps the
 * e2e suite performs, and emits a JSON evidence record. No server, no browser, no network,
 * no scans, no claims about an OpenCode host run. Exit 0 only if every repair is a real
 * source edit at the SAME file path with stable element IDs preserved.
 *
 * Run: node test/e2e-fixtures/repair-evidence.unit.mjs [out.json]
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLAWED_SOURCE = path.join(HERE, "registration.html");
const CORRECTED_SOURCE = path.join(HERE, "registration-corrected.html");

/* Same edit chain as test/e2e.test.ts — single source of truth are these constants. */
const IMG_NO_ALT = '<img id="product-image" src="/img/chart.png" width="16" height="16">';
const ALT_FIX_SEARCH = 'id="product-image" src=';
const ALT_FIX_REPLACE = 'id="product-image" alt="Product variety chart" src=';
const NEW_ISSUE_LABEL = '    <input type="text" id="new-extra-field" name="extra" autocomplete="off">\n';
const FORM_CLOSE_SEARCH = "  </form>";

const STABLE_IDS = [
  "registration-main",
  "registration-form",
  "product-image",
  "fine-print-paragraph",
  "reg-username",
  "region",
  "icon-button",
  "icon-link",
];

const FINAL_REPAIR_MARKERS = [
  '<html lang="en">',
  'alt="Product variety chart"',
  '<label for="reg-username">',
  "<label for=\"region\">",
  'aria-label="Region"',
  'aria-label="Show sign-up help"',
  'aria-label="Back to home page"',
  "color: #333333",
];

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

const flawed = await fs.readFile(FLAWED_SOURCE, "utf8");
const corrected = await fs.readFile(CORRECTED_SOURCE, "utf8");

if (!flawed.includes(IMG_NO_ALT)) fail("flawed fixture is missing the unlabelled image source");
if (corrected.length < 1) fail("corrected reference is empty");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ac-repair-evidence-"));
const target = path.join(tmp, "registration.html"); // the SAME path across all edits
const steps = [];

/* stage 0: flawed source on disk */
await fs.writeFile(target, flawed, "utf8");
let content = await fs.readFile(target, "utf8");
for (const id of STABLE_IDS) {
  if (!content.includes(`id="${id}"`)) fail(`flawed stage: stable id "${id}" missing`);
}
steps.push({ stage: "flawed", sha256: sha256(content), bytes: content.length });

/* stage 1: agent source repair, partial — the img attribute only, SAME file */
const partial = content.replace(ALT_FIX_SEARCH, ALT_FIX_REPLACE);
if (partial === content || !partial.includes('alt="Product variety chart"')) {
  fail("partial repair did not apply the img attribute edit");
}
await fs.writeFile(target, partial, "utf8");
content = await fs.readFile(target, "utf8");
if (!content.includes('id="product-image')) fail("stable id product-image lost by partial repair");
steps.push({ stage: "partial_repair", sha256: sha256(content), bytes: content.length });

/* stage 2: agent source edit introduces a new issue — still the SAME file */
const withNewIssue = content.replace(FORM_CLOSE_SEARCH, `${NEW_ISSUE_LABEL}${FORM_CLOSE_SEARCH}`);
if (!withNewIssue.includes('id="new-extra-field"')) fail("new-issue edit did not apply");
await fs.writeFile(target, withNewIssue, "utf8");
content = await fs.readFile(target, "utf8");
steps.push({ stage: "new_issue_introduced", sha256: sha256(content), bytes: content.length });

/* stage 3: corrected reference copied over the SAME file (same URL, source replacement) */
await fs.writeFile(target, corrected, "utf8");
content = await fs.readFile(target, "utf8");
if (content !== corrected) fail("corrected copy over the SAME file did not land verbatim");
if (sha256(content) === sha256(flawed)) fail("corrected source is identical to flawed source");
for (const id of STABLE_IDS) {
  if (!content.includes(`id="${id}"`)) fail(`corrected stage: stable id "${id}" not preserved`);
}
for (const marker of FINAL_REPAIR_MARKERS) {
  if (!content.includes(marker)) fail(`corrected reference missing repair evidence marker: ${marker}`);
}
if (content.includes('color: #9e9e9e')) fail("low-contrast color still present in corrected reference");
steps.push({ stage: "corrected_replacement", sha256: sha256(content), bytes: content.length });

await fs.rm(tmp, { recursive: true, force: true });

const outPath = process.argv[2];
const evidence = {
  meaning: "mechanical agent source-repair evidence (fs-level, reproducible), NOT a host/model demonstration",
  same_file_path: true,
  same_url_spot: "/registration.html",
  source: FLAWED_SOURCE,
  corrected_reference: CORRECTED_SOURCE,
  stable_ids: STABLE_IDS,
  steps,
};
if (outPath) {
  await fs.writeFile(outPath, JSON.stringify(evidence, null, 2), "utf8");
}
console.log("PASS: agent source repair evidence (mechanical, on-disk, same-path) written" + (outPath ? ` to ${outPath}` : " to stdout"));
