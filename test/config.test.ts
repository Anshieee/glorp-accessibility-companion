import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_HOSTS, parseConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";

const base: NodeJS.Dict<string> = {
  ACCESSIBILITY_PROJECT_ROOT: "/tmp/opencode/glorp-root",
};

describe("parseConfig defaults", () => {
  it("applies documented defaults", () => {
    const c = parseConfig({ ...base });
    expect(c.projectRoot).toBe("/tmp/opencode/glorp-root");
    expect(c.reportDir).toBe("/tmp/opencode/glorp-root/.accessibility-mcp/runs");
    expect(c.bucket).toBeUndefined();
    expect(c.allowedOrigins).toEqual([]);
    expect(c.allowedHosts).toEqual([...DEFAULT_ALLOWED_HOSTS]); // india.gov.in + www.india.gov.in
    expect(c.allowLocal).toBe(false);
    expect(c.publicBaseUrl).toBeUndefined();
    expect(c.port).toBe(8080);
    expect(c.ttlMs).toBe(24 * 60 * 60 * 1000);
    expect(c.scanTimeoutMs).toBe(45_000);
    expect(c.maxStoredBytes).toBe(10 * 1024 * 1024);
    expect(c.maxFindings).toBe(100);
    expect(c.trustProxy).toBe(false);
    expect(c.host).toBe("0.0.0.0");
    expect(c.fixturesDir.endsWith("/test/fixtures")).toBe(true);
    expect(c.webDistDir.endsWith("/web/dist")).toBe(true);
  });

  it("demo gov hosts are default allowed (exact)", () => {
    expect(DEFAULT_ALLOWED_HOSTS).toContain("india.gov.in");
    expect(DEFAULT_ALLOWED_HOSTS).toContain("www.india.gov.in");
  });
});

describe("allowlist parsing (exact, no wildcards)", () => {
  it("parses exact origins + hosts from comma lists and merges defaults", () => {
    const c = parseConfig({
      ...base,
      ACCESSIBILITY_ALLOWED_ORIGINS: "https://fixture.example:8443, http://partner.gov.in",
      ACCESSIBILITY_ALLOWED_HOSTS: "rbi.org.in",
    });
    expect(c.allowedOrigins).toEqual(["https://fixture.example:8443", "http://partner.gov.in"]);
    expect(c.allowedHosts).toEqual(["rbi.org.in", "india.gov.in", "www.india.gov.in"]);
  });

  it("rejects wildcards and paths in origins", () => {
    expect(() => parseConfig({ ...base, ACCESSIBILITY_ALLOWED_ORIGINS: "*" })).toThrowError(AppError);
    expect(() => parseConfig({ ...base, ACCESSIBILITY_ALLOWED_ORIGINS: "https://*.example.com" })).toThrowError(/wildcards/);
    expect(() => parseConfig({ ...base, ACCESSIBILITY_ALLOWED_ORIGINS: "https://example.com/path" })).toThrowError(/no path/);
    expect(() => parseConfig({ ...base, ACCESSIBILITY_ALLOWED_HOSTS: "*.gov.in" })).toThrowError(/wildcards/);
    expect(() => parseConfig({ ...base, ACCESSIBILITY_ALLOWED_HOSTS: "host.gov.in:80" })).toThrowError(/without port/);
    expect(() => parseConfig({ ...base, ACCESSIBILITY_PUBLIC_BASE_URL: "https://x.example/a/b" })).toThrowError(/bare origin/);
  });

  it("rejects malformed base urls", () => {
    expect(() => parseConfig({ ...base, ACCESSIBILITY_PUBLIC_BASE_URL: "http" })).toThrowError(AppError);
    // Default ports are normalized away by URL.origin
    expect(parseConfig({ ...base, ACCESSIBILITY_PUBLIC_BASE_URL: "HTTPS://Demo.Example:443/" })).toMatchObject({ publicBaseUrl: "https://demo.example" });
  });
});

describe("allow_local safety", () => {
  it("local mode must be explicitly opted in", () => {
    expect(parseConfig({ ...base, ACCESSIBILITY_ALLOW_LOCAL: "true" }).allowLocal).toBe(true);
    expect(parseConfig({ ...base, ACCESSIBILITY_ALLOW_LOCAL: "false" }).allowLocal).toBe(false);
  });

  it("local mode is NEVER permitted on managed cloud (K_SERVICE)", () => {
    expect(() =>
      parseConfig({
        ...base,
        ACCESSIBILITY_ALLOW_LOCAL: "true",
        K_SERVICE: "some-cloud-run-service",
      }),
    ).toThrowError(/managed cloud/);
  });

  it("other values are rejected loudly", () => {
    expect(() => parseConfig({ ...base, ACCESSIBILITY_ALLOW_LOCAL: "1" })).toThrowError(/exactly 'true' or 'false'/);
  });
});

describe("report bucket env (canonical + alias + cloud)", () => {
  it("canonical ACCESSIBILITY_REPORT_BUCKET wins and alias works backwards-compatibly", () => {
    const viaCanonical = parseConfig({ ...base, ACCESSIBILITY_REPORT_BUCKET: "glorp-demo-reports" });
    const viaAlias = parseConfig({ ...base, ACCESSIBILITY_GCS_BUCKET: "glorp-demo-reports" });
    expect(viaCanonical.bucket).toBe("glorp-demo-reports");
    expect(viaAlias.bucket).toBe("glorp-demo-reports");
  });

  it("rejects contradictory dual bucket values outright", () => {
    expect(() =>
      parseConfig({
        ...base,
        ACCESSIBILITY_REPORT_BUCKET: "accessibility-reports-demo",
        ACCESSIBILITY_GCS_BUCKET: "some-other-bucket",
      }),
    ).toThrowError(/contradictory/);
  });

  it("identical dual values are accepted (not contradictory)", () => {
    const c = parseConfig({
      ...base,
      ACCESSIBILITY_REPORT_BUCKET: "accessibility-reports-demo",
      ACCESSIBILITY_GCS_BUCKET: "accessibility-reports-demo",
    });
    expect(c.bucket).toBe("accessibility-reports-demo");
  });

  it("cloud (K_SERVICE set) REQUIRES a real bucket — no silent disk persistence", () => {
    expect(() =>
      parseConfig({ ...base, K_SERVICE: "accessibility-companion" }),
    ).toThrowError(/missing bucket on managed cloud/);
    const ok = parseConfig({ ...base, K_SERVICE: "accessibility-companion", ACCESSIBILITY_REPORT_BUCKET: "glorp-demo-reports" });
    expect(ok.bucket).toBe("glorp-demo-reports");
    expect(ok.allowLocal).toBe(false);
  });

  it("cloud still rejects ACCESSIBILITY_ALLOW_LOCAL", () => {
    expect(() =>
      parseConfig({
        ...base,
        K_SERVICE: "accessibility-companion",
        ACCESSIBILITY_REPORT_BUCKET: "glorp-demo-reports",
        ACCESSIBILITY_ALLOW_LOCAL: "true",
      }),
    ).toThrowError(/never permitted on managed cloud/);
  });

  it("manager-cloud without bucket rejects an INVALID bucket name as well", () => {
    expect(() => parseConfig({ ...base, ACCESSIBILITY_REPORT_BUCKET: "bad bucket name!" })).toThrowError(AppError);
  });
});

describe("limits and tuning", () => {
  it("accepts explicit overrides", () => {
    const c = parseConfig({
      ...base,
      ACCESSIBILITY_GCS_BUCKET: "glorp-demo-reports",
      ACCESSIBILITY_SCAN_TIMEOUT_MS: "30000",
      ACCESSIBILITY_MAX_FINDINGS: "50",
      ACCESSIBILITY_TTL_MS: "3600000",
      PORT: "3000",
      HOST: "127.0.0.1",
      ACCESSIBILITY_TRUST_PROXY: "true",
      ACCESSIBILITY_CORS_ORIGINS: "https://frontend.example",
      ACCESSIBILITY_READINESS_SELECTOR: "#ready",
      ACCESSIBILITY_BROWSER_EXECUTABLE: "/usr/bin/chromium",
    });
    expect(c.bucket).toBe("glorp-demo-reports");
    expect(c.scanTimeoutMs).toBe(30_000);
    expect(c.maxFindings).toBe(50);
    expect(c.ttlMs).toBe(3_600_000);
    expect(c.port).toBe(3000);
    expect(c.host).toBe("127.0.0.1");
    expect(c.trustProxy).toBe(true);
    expect(c.corsOrigins).toEqual(["https://frontend.example"]);
    expect(c.readinessSelector).toBe("#ready");
    expect(c.browserExecutable).toBe("/usr/bin/chromium");
  });

  it("rejects non-numeric limits", () => {
    expect(() => parseConfig({ ...base, PORT: "nope" })).toThrowError(/PORT/);
    expect(() => parseConfig({ ...base, ACCESSIBILITY_SCAN_TIMEOUT_MS: "-1" })).toThrowError(AppError);
    expect(() => parseConfig({ ...base, ACCESSIBILITY_GCS_BUCKET: "bad bucket name!" })).toThrowError(AppError);
  });
});
