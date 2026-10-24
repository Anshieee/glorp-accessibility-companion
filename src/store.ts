/**
 * Immutable run store. Two backends behind one RunStore interface:
 *  - local filesystem (default): atomic exclusive-create writes under the
 *    configured report directory; loads reject symlinks and oversized/corrupt
 *    content; 24h expiration enforced at read time.
 *  - GCS (when ACCESSIBILITY_GCS_BUCKET is set): private objects written with
 *    ifGenerationMatch: 0 (create-only, immutable ids), size guard, and the
 *    same 24h app-enforced read-time expiration.
 * report_path is a safe opaque relative reference ("runs/<id>.json"); bucket
 * names or absolute paths are never exposed in it.
 */
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { Storage } from "@google-cloud/storage";
import type { StoredScan, RunStore } from "./contracts.js";
import { validateStoredScan, isValidRunId } from "./contracts.js";
import { AppError } from "./errors.js";

export interface LocalStoreOptions {
  reportDir: string;
  ttlMs: number;
  maxStoredBytes: number;
}

export interface GcsStoreOptions {
  bucket: string;
  ttlMs: number;
  maxStoredBytes: number;
}

export interface RunStoreOptions extends LocalStoreOptions {
  /** When set, the GCS backend is used; otherwise the local filesystem backend. */
  gcsBucket: string | undefined;
}

function checkFresh(record: StoredScan, ttlMs: number): void {
  const completedAt = Date.parse(record.run.completed_at);
  if (!Number.isFinite(completedAt)) {
    throw AppError.notFound(record.run.run_id);
  }
  if (Date.now() > completedAt + ttlMs) {
    throw AppError.expired(record.run.run_id);
  }
}

function withReportPath(record: StoredScan): StoredScan {
  const run = { ...record.run, report_path: `runs/${record.run.run_id}.json` };
  return { ...record, run };
}

function rejectCorrupt(id: string): AppError {
  return AppError.notFound(id);
}

// ---------------------------------------------------------------------------
// Local filesystem store
// ---------------------------------------------------------------------------

function localPath(dir: string, id: string): string {
  if (!isValidRunId(id)) throw AppError.notFound(id);
  return path.join(dir, `${id}.json`);
}

export async function localSave(opts: LocalStoreOptions, input: StoredScan): Promise<void> {
  const record = withReportPath(input);
  if (!isValidRunId(record.run.run_id)) {
    throw new AppError("SCAN_FAILED", "Run record has an invalid run_id and cannot be stored.", "Retry the scan.", false);
  }
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  if (bytes.byteLength > opts.maxStoredBytes) {
    throw new AppError(
      "REPORT_TOO_LARGE",
      `Normalized run exceeds the ${opts.maxStoredBytes}-byte storage limit.`,
      "Reduce page complexity or contact the operators if this is a legitimate result; no baseline was fabricated.",
    );
  }
  try {
    await fs.mkdir(opts.reportDir, { recursive: true });
  } catch (e: unknown) {
    // Wrap ALL persistence-layer failures as precise, safe REPORT_WRITE_FAILED
    // errors — never leak raw backend errors as SCAN_FAILED.
    if (e instanceof AppError) throw e;
    throw new AppError(
      "REPORT_WRITE_FAILED",
      "Failed to prepare the local report directory.",
      "Verify the report directory is writable; no recoverable baseline was produced.",
      false,
    );
  }
  const target = localPath(opts.reportDir, record.run.run_id);
  const tmp = path.join(
    opts.reportDir,
    `${record.run.run_id}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  try {
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    // Atomic, exclusive create: link fails if the run_id already exists
    // (report IDs are immutable; never overwrite an existing baseline).
    await fs.link(tmp, target);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new AppError(
        "REPORT_WRITE_FAILED",
        `A report for run_id ${record.run.run_id} already exists; report IDs are immutable.`,
        "Run a fresh audit for a new baseline.",
        false,
      );
    }
    if (e instanceof AppError) throw e;
    throw new AppError(
      "REPORT_WRITE_FAILED",
      "Failed to persist the run report to the local report directory.",
      "Verify the report directory is writable; no recoverable baseline was produced.",
      false,
    );
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

export async function localLoad(opts: LocalStoreOptions, id: string): Promise<StoredScan> {
  const target = localPath(opts.reportDir, id);
  let st: Stats;
  try {
    // lstat does not follow symlinks — a symlinked report is rejected.
    st = await fs.lstat(target);
  } catch {
    throw AppError.notFound(id);
  }
  if (!st.isFile()) {
    // includes symlinks and directories
    throw AppError.notFound(id);
  }
  if (st.size > opts.maxStoredBytes) {
    throw new AppError(
      "REPORT_TOO_LARGE",
      "Stored report exceeds the configured size limit and is rejected.",
      "Run a new audit.",
      false,
    );
  }
  let raw: Buffer;
  try {
    raw = await fs.readFile(target);
  } catch {
    throw AppError.notFound(id);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw rejectCorrupt(id);
  }
  const record = validateStoredScan(parsed);
  if (record === null || record.run.run_id !== id || record.run.report_path !== `runs/${id}.json`) {
    throw rejectCorrupt(id);
  }
  checkFresh(record, opts.ttlMs);
  return record;
}

export function createLocalStore(opts: LocalStoreOptions): RunStore {
  return {
    save: (record) => localSave(opts, record),
    load: (id) => localLoad(opts, id),
  };
}

// ---------------------------------------------------------------------------
// GCS store (private bucket, create-only writes, 24h app-enforced expiry)
// ---------------------------------------------------------------------------

function objectPath(id: string): string {
  if (!isValidRunId(id)) throw AppError.notFound(id);
  return `runs/${id}.json`;
}

export function createGcsStore(opts: GcsStoreOptions): RunStore {
  // Constructing Storage/bucket does not perform any network operation;
  // credentials come from the environment the service itself runs under
  // (Cloud Run service identity). The app never embeds user credentials.
  //
  // Bounded persistence budget so a slow/broken bucket cannot leave the host
  // idling after the scan succeeded: 10s per-request timeout, at most 1 retry,
  // total retry budget ~20s. Scan target stays 45s; persistence adds a few
  // seconds worst-case (aim: scan ~40s + store ~5s operational envelope).
  const storage = new Storage({
    timeout: 10_000,
    retryOptions: {
      autoRetry: true,
      maxRetries: 1,
      totalTimeout: 20, // seconds (library-level budget for the whole request)
    },
  });
  const bucket = storage.bucket(opts.bucket);

  async function save(input: StoredScan): Promise<void> {
    const record = withReportPath(input);
    const bytes = Buffer.from(JSON.stringify(record), "utf8");
    if (bytes.byteLength > opts.maxStoredBytes) {
      throw new AppError(
        "REPORT_TOO_LARGE",
        `Normalized run exceeds the ${opts.maxStoredBytes}-byte storage limit.`,
        "Reduce page complexity or contact the operators; no baseline was fabricated.",
      );
    }
    const file = bucket.file(objectPath(record.run.run_id), {
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    try {
      // preconditionOpts.ifGenerationMatch: 0 → create-only; fails if the object already exists.
      await file.save(bytes, {
        resumable: false,
        contentType: "application/json",
        metadata: { cacheControl: "private, max-age=0", contentDisposition: "attachment" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/conditionNotMatch|conditionNotMet|Precondition|WorkingState|\b412\b/i.test(message)) {
        throw new AppError(
          "REPORT_WRITE_FAILED",
          `A report for run_id ${record.run.run_id} already exists in the store; report IDs are immutable.`,
          "Run a fresh audit for a new baseline.",
          false,
        );
      }
      throw new AppError(
        "REPORT_WRITE_FAILED",
        "Failed to persist the run report to storage.",
        "Retry the audit; if it persists, contact the operators.",
        false,
      );
    }
  }

  async function load(id: string): Promise<StoredScan> {
    const file = bucket.file(objectPath(id));
    let size: number;
    try {
      const [meta] = await file.getMetadata();
      const rawSize = meta?.size;
      const n = typeof rawSize === "string" ? Number.parseInt(rawSize, 10) : Number(rawSize);
      if (!Number.isFinite(n)) throw rejectCorrupt(id);
      size = n;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw AppError.notFound(id);
    }
    if (size > opts.maxStoredBytes) {
      throw new AppError(
        "REPORT_TOO_LARGE",
        "Stored report exceeds the configured size limit and is rejected.",
        "Run a new audit.",
        false,
      );
    }
    let raw: Buffer;
    try {
      const [buf] = await file.download();
      raw = buf;
    } catch {
      throw AppError.notFound(id);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw rejectCorrupt(id);
    }
    const record = validateStoredScan(parsed);
    if (record === null || record.run.run_id !== id || record.run.report_path !== `runs/${id}.json`) {
      throw rejectCorrupt(id);
    }
    checkFresh(record, opts.ttlMs);
    return record;
  }

  return { save, load };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createRunStore(opts: RunStoreOptions): RunStore {  if (opts.gcsBucket !== undefined) {
    return createGcsStore({ bucket: opts.gcsBucket, ttlMs: opts.ttlMs, maxStoredBytes: opts.maxStoredBytes });
  }
  return createLocalStore({ reportDir: opts.reportDir, ttlMs: opts.ttlMs, maxStoredBytes: opts.maxStoredBytes });
}
