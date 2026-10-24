/**
 * Test helper: builds a AppConfig for local-browser tests through the real
 * env parser (engine ownership) so tests exercise the actual configuration
 * path. Local tests explicitly enable ACCESSIBILITY_ALLOW_LOCAL=true, which is
 * the ONLY supported way for loopback targets (never on K_SERVICE).
 */
import path from "node:path";
import os from "node:os";
import { parseConfig } from "../../src/config.js";

export interface LocalTestConfigOverrides {
  allowedOrigins: string[];
  allowedHosts?: string[];
  allowLocal?: boolean;
  reportDirOverride?: string;
  scanTimeoutMs?: number;
  readinessSelector?: string;
  browserExecutable?: string;
  bucket?: string;
}

export function createConfig(overrides: LocalTestConfigOverrides) {
  const env: NodeJS.Dict<string> = {
    ACCESSIBILITY_PROJECT_ROOT: overrideProjectRoot(),
    ACCESSIBILITY_ALLOW_LOCAL: overrides.allowLocal === false ? "false" : "true",
    ACCESSIBILITY_ALLOWED_ORIGINS: overrides.allowedOrigins.join(","),
    ...(overrides.allowedHosts ? { ACCESSIBILITY_ALLOWED_HOSTS: overrides.allowedHosts.join(",") } : {}),
    ACCESSIBILITY_REPORT_DIR: overrides.reportDirOverride ?? path.join(os.tmpdir(), "glorp-test-reports"),
    ACCESSIBILITY_SCAN_TIMEOUT_MS: String(overrides.scanTimeoutMs ?? 45_000),
    ...(overrides.readinessSelector ? { ACCESSIBILITY_READINESS_SELECTOR: overrides.readinessSelector } : {}),
    ...(overrides.browserExecutable ? { ACCESSIBILITY_BROWSER_EXECUTABLE: overrides.browserExecutable } : {}),
    ...(overrides.bucket ? { ACCESSIBILITY_GCS_BUCKET: overrides.bucket } : {}),
    PORT: "8080",
  };
  return parseConfig(env);
}

function overrideProjectRoot(): string {
  // The service's config derives webDistDir/fixturesDir from projectRoot;
  // tests never write there, so a stable temp value is enough.
  return process.cwd();
}
