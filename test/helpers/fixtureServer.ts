/**
 * Test-only static fixture server with behavior hooks for scanner tests:
 *  - serves files from a (mutable) working copy of test/fixtures under
 *    /fixtures/<name> so tests can edit "the same source file" and rescan the
 *    same URL (simulating the source repair loop);
 *  - 404 for unknown names (fatal-error scenario);
 *  - /fixtures/__redirect?to=<path>  → same-origin redirect (allowed case);
 *  - /fixtures/__crossredirect      → redirect to a non-allowlisted external
 *     host (must be blocked before navigation);
 *  - /fixtures/__hang               → never responds (SCAN_TIMEOUT scenario).
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface FixtureServer {
  port: number;
  /** e.g. http://127.0.0.1:PORT (exact origin string for allowlisting). */
  origin: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".css": "text/css",
  ".js": "text/javascript",
};

export async function startFixtureServer(rootDir: string): Promise<FixtureServer> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      const pathname = url.pathname;

      if (pathname === "/fixtures/__hang") {
        // Never respond; the socket is closed when the client disappears.
        return;
      }

      if (pathname === "/fixtures/__crossredirect") {
        res.writeHead(302, { location: "https://definitely-not-allowlisted.example.com/scan-me" });
        res.end();
        return;
      }

      if (pathname === "/fixtures/__sameredirect") {
        res.writeHead(302, { location: "/fixtures/help.html" });
        res.end();
        return;
      }

      if (!pathname.startsWith("/fixtures/") || pathname.includes("..")) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }

      const rel = pathname.slice("/fixtures/".length);
      const target = path.resolve(rootDir, rel);
      if (!target.startsWith(path.resolve(rootDir))) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const data = await fs.readFile(target);
      const type = MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server failed to bind");
  }

  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Copy the pristine fixture set into a per-test working directory. */
export async function copyFixtures(sourceDir: string, workDir: string): Promise<void> {
  await fs.mkdir(workDir, { recursive: true });
  for (const entry of await fs.readdir(sourceDir)) {
    await fs.copyFile(path.join(sourceDir, entry), path.join(workDir, entry));
  }
}
