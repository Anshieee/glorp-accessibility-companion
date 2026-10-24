import { describe, expect, it } from "vitest";
import { AppError, ERROR_STATUS, toAppError } from "../src/errors.js";

describe("AppError", () => {
  it("carries PRD defaults with recoverable=true default", () => {
    const e = new AppError("TARGET_UNREACHABLE", "Page could not be loaded.", "Start the site and retry.");
    expect(e.recoverable).toBe(true);
    expect(e.nextAction).toBe("Start the site and retry.");
    expect(e.status).toBe(502);
  });

  it("maps error codes to HTTP statuses", () => {
    expect(ERROR_STATUS["INVALID_ARGUMENT"]).toBe(400);
    expect(ERROR_STATUS["TARGET_NOT_ALLOWED"]).toBe(403);
    expect(ERROR_STATUS["RATE_LIMITED"]).toBe(429);
    expect(ERROR_STATUS["SCAN_BUSY"]).toBe(503);
    expect(ERROR_STATUS["SCAN_TIMEOUT"]).toBe(504);
    expect(ERROR_STATUS["REPORT_EXPIRED"]).toBe(410);
    expect(ERROR_STATUS["REPORT_WRITE_FAILED"]).toBe(500);
    expect(ERROR_STATUS["REPORT_TOO_LARGE"]).toBe(413);
    expect(ERROR_STATUS["BASELINE_NOT_FOUND"]).toBe(404);
    expect(ERROR_STATUS["BASELINE_INCOMPATIBLE"]).toBe(409);
    expect(ERROR_STATUS["CONFIGURATION_ERROR"]).toBe(500);
  });

  it("produces the PRD §13 envelope", () => {
    const e = new AppError("TARGET_UNREACHABLE", "The configured page could not be loaded.", "Start the application and retry the same URL.");
    expect(e.toBody()).toEqual({
      execution: "failed",
      error: {
        code: "TARGET_UNREACHABLE",
        message: "The configured page could not be loaded.",
        recoverable: true,
        next_action: "Start the application and retry the same URL.",
      },
    });
  });

  it("expired() / notFound() produce the documented shapes", () => {
    expect(AppError.expired("4b3d08e6-8f2b-4d99-bc37-2a0b0ee5b770").status).toBe(410);
    expect(AppError.expired("x").code).toBe("REPORT_EXPIRED");
    expect(AppError.notFound("y").code).toBe("BASELINE_NOT_FOUND");
  });

  it("toAppError wraps unknown errors without leaking raw messages upward (safe message only)", () => {
    const a = toAppError(new Error("secret stack detail"));
    expect(a.code).toBe("SCAN_FAILED");
    expect(a.message).not.toContain("secret");
    const b = toAppError(new AppError("SCAN_BUSY", "busy", "wait"));
    expect(b).toBeInstanceOf(AppError);
    expect(b.code).toBe("SCAN_BUSY");
  });
});
