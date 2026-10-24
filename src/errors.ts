/**
 * Error contract (PRD §13 + hosted-demo additions).
 * AppError(code, message, nextAction, recoverable=true) with HTTP status mapping.
 */

export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "TARGET_NOT_ALLOWED"
  | "TARGET_UNREACHABLE"
  | "TARGET_NOT_READY"
  | "BROWSER_UNAVAILABLE"
  | "SCAN_TIMEOUT"
  | "SCAN_BUSY"
  | "SCAN_FAILED"
  | "RULESET_UNSUPPORTED"
  | "BASELINE_NOT_FOUND"
  | "BASELINE_INCOMPATIBLE"
  | "REPORT_WRITE_FAILED"
  | "REPORT_TOO_LARGE"
  | "REPORT_EXPIRED"
  | "RATE_LIMITED"
  | "CONFIGURATION_ERROR";

const STATUS: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  TARGET_NOT_ALLOWED: 403,
  TARGET_UNREACHABLE: 502,
  TARGET_NOT_READY: 502,
  BROWSER_UNAVAILABLE: 503,
  SCAN_TIMEOUT: 504,
  SCAN_BUSY: 503,
  SCAN_FAILED: 500,
  RULESET_UNSUPPORTED: 500,
  BASELINE_NOT_FOUND: 404,
  BASELINE_INCOMPATIBLE: 409,
  REPORT_WRITE_FAILED: 500,
  REPORT_TOO_LARGE: 413,
  REPORT_EXPIRED: 410,
  RATE_LIMITED: 429,
  CONFIGURATION_ERROR: 500,
};

export type SerializedError = {
  execution: "failed";
  error: {
    code: ErrorCode;
    message: string;
    recoverable: boolean;
    next_action: string;
  };
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly nextAction: string;
  readonly recoverable: boolean;
  readonly status: number;

  constructor(code: ErrorCode, message: string, nextAction: string, recoverable: boolean = true) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.nextAction = nextAction;
    this.recoverable = recoverable;
    this.status = STATUS[code];
  }

  /** PRD §13 error envelope. */
  toBody(): SerializedError {
    return {
      execution: "failed",
      error: {
        code: this.code,
        message: this.message,
        recoverable: this.recoverable,
        next_action: this.nextAction,
      },
    };
  }

  /** Anonymous reports: expired IDs are simply no longer loadable. */
  static expired(id: string): AppError {
    return new AppError(
      "REPORT_EXPIRED",
      `Report ${id} has passed its 24-hour retention window and is no longer available.`,
      "Run a new audit to create a fresh baseline.",
    );
  }

  static notFound(id: string): AppError {
    return new AppError(
      "BASELINE_NOT_FOUND",
      `No valid saved run exists for id ${id}.`,
      "Check the run_id came from a completed audit in the last 24 hours, then retry.",
    );
  }
}

/** Wrap unknown throwables into AppError (SCAN_FAILED). */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError("SCAN_FAILED", "Unexpected server error while processing the request.", "Retry the request; if it persists, contact the demo operators.", false);
}

/** Functional core of toAppError (for mappers): */
export { toAppError as mapError };

/** Overload: expose the code→status map (exported for API layer). */
export { STATUS as ERROR_STATUS };
