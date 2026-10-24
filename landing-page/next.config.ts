import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Static export served by the existing Express backend (no new Next server process).
  output: 'export',
  // Pin tracing root (works whether the config loads as CJS or ESM): the repo
  // also keeps the original pnpm-lock.yaml for reference (npm/package-lock.json
  // is canonical for Docker), so tell Next not to infer the workspace root
  // from a parent lockfile. `npm run build` always runs from this directory.
  outputFileTracingRoot: path.resolve('.'),
  images: {
    unoptimized: true,
  },
  // Keep local builds light on constrained machines (2 vCPU / 16 GB laptop).
  // Next reads this in `next build`; single worker avoids OOM/swap pressure.
  experimental: {
    cpus: 1,
  },
};

export default nextConfig;
