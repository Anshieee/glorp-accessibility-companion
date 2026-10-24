import { mkdtemp, lstat, rm, symlink, writeFile, appendFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { LocalStoreOptions } from "../src/store.js";
import { createLocalStore } from "../src/store.js";
import { AppError } from "../src/errors.js";
import { finding, makeStored, reviewItem } from "./fakes.js";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpStore(): Promise<LocalStoreOptions> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acompanion-store-"));
  dirs.push(dir);
  return { reportDir: dir, ttlMs: 24 * 60 * 60 * 1000, maxStoredBytes: 10 * 1024 * 1024 };
}

function sampleRecord() {
  return makeStored({
    url: "https://india.gov.in/page",
    findings: [finding({ rule_id: "label", targets: ["#reg-name"] })],
    reviewItems: [],
  });
}

describe("local filesystem run store", () => {
  it("saves atomically and loads identical content by opaque id", async () => {
    const opts = await tmpStore();
    const store = createLocalStore(opts);
    const record = sampleRecord();
    await store.save(record);
    const loaded = await store.load(record.run.run_id);
    expect(loaded.run.run_id).toBe(record.run.run_id);
    expect(loaded.full_findings).toHaveLength(1);
    expect(loaded.run.report_path).toBe(`runs/${record.run.run_id}.json`);
    // Only the single report file must exist (tmp written files cleaned up)
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(opts.reportDir);
    expect(files).toEqual([`${record.run.run_id}.json`]);
  });

  it("stores report_path without absolute paths or bucket references", async () => {
    const opts = await tmpStore();
    const store = createLocalStore(opts);
    const record = sampleRecord();
    await store.save(record);
    const loaded = await store.load(record.run.run_id);
    expect(loaded.run.report_path.startsWith("runs/")).toBe(true);
    expect(loaded.run.report_path).not.toMatch(/[/\\]{2,}|^\//);
  });

  it("rejects overwriting an existing run id (immutable)", async () => {
    const opts = await tmpStore();
    const store = createLocalStore(opts);
    const record = sampleRecord();
    await store.save(record);
    const tampered = JSON.parse(JSON.stringify(record));
    tampered.run.completed_at = new Date().toISOString();
    await expect(store.save(tampered)).rejects.toMatchObject({ code: "REPORT_WRITE_FAILED" });
  });

  it("rejects oversized saved content with REPORT_TOO_LARGE and never writes it", async () => {
    const opts = await tmpStore();
    const store = createLocalStore({ ...opts, maxStoredBytes: 200 });
    const record = sampleRecord();
    await expect(store.save(record)).rejects.toMatchObject({ code: "REPORT_TOO_LARGE" });
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(opts.reportDir)).toEqual([]);
  });

  it("rejects network-symlinked report files on load (traversal guard)", async () => {
    const opts = await tmpStore();
    const outside = path.join(opts.reportDir, "..", "outside-secret.json");
    await writeFile(outside, "{}", "utf8");
    const linkTarget = path.join(opts.reportDir, "4b3d08e6-8f2b-4d99-bc37-2a0b0ee5b770.json");
    await symlink(outside, linkTarget);
    await expect(createLocalStore(opts).load("4b3d08e6-8f2b-4d99-bc37-2a0b0ee5b770")).rejects.toMatchObject({ code: "BASELINE_NOT_FOUND" });
  });

  it("rejects invalid JSON / missing metadata / truncated schemas as BASELINE_NOT_FOUND", async () => {
    const opts = await tmpStore();
    const store = createLocalStore(opts);
    await writeFile(path.join(opts.reportDir, "9b3d08e6-8f2b-4d99-bc37-2a0b0ee5b770.json"), "{ not json", "utf8");
    await expect(store.load("9b3d08e6-8f2b-4d99-bc37-2a0b0ee5b770")).rejects.toMatchObject({ code: "BASELINE_NOT_FOUND" });
    const nothing = "9b3d08e6-8f2b-4d99-bc37-2a0b0ee5b771";
    await expect(store.load(nothing)).rejects.toMatchObject({ code: "BASELINE_NOT_FOUND" });
  });

  it("enforces the 24h retention window strictly at read time", async () => {
    const opts = await tmpStore();
    const store = createLocalStore({ ...opts, ttlMs: 1 });
    const record = sampleRecord();
    await store.save(record);
    await new Promise((r) => setTimeout(r, 10));
    await expect(store.load(record.run.run_id)).rejects.toMatchObject({ code: "REPORT_EXPIRED" });
  });

  it("rejects path-like ids before filesystem access", async () => {
    const opts = await tmpStore();
    const store = createLocalStore(opts);
    await expect(store.load("../../etc/passwd.json")).rejects.toMatchObject({ code: "BASELINE_NOT_FOUND" });
    await expect(store.load("../../etc/passwd.json")).rejects.toThrow(/run identifier|No valid saved run/);
  });

  it("reports are written 0600 (private mode) and file stays regular even after fsync", async () => {
    const opts = await tmpStore();
    const store = createLocalStore(opts);
    const record = sampleRecord();
    await store.save(record);
    const s = await lstat(path.join(opts.reportDir, `${record.run.run_id}.json`));
    expect(s.isFile()).toBe(true);
    expect((s.mode & 0o077) === 0).toBe(true);
  });

  it("rule-level incomplete ReviewItem with empty targets survives save/load", async () => {
    const opts = await tmpStore();
    const store = createLocalStore(opts);
    const record = makeStored({
      findings: [],
      reviewItems: [reviewItem({ rule_id: "color-contrast", targets: [] })],
    });
    await store.save(record);
    const loaded = await store.load(record.run.run_id);
    expect(loaded.full_review_items).toHaveLength(1);
    expect(loaded.full_review_items[0].targets).toEqual([]);
  });
});
