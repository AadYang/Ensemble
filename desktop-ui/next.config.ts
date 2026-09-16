import type { NextConfig } from "next";

// Ensemble desktop-ui is always built as a static export consumed by Tauri's
// WebView (or by ensemble-core's fastify-static when running standalone).
// There is no `next dev` mode here — the dev workflow is `pnpm desktop:dev`
// which spins up Tauri + sidecar together.
//
// `distDir: "static-out"` (instead of next's default `out`) is a workaround
// for a Windows EBUSY when the Search Indexer holds the legacy `out` dir.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  distDir: "static-out",
  // The workspace package is consumed as TypeScript SOURCE (`shared` ships
  // `src/index.ts`), so it must be compiled by the bundler rather than treated
  // as an already-built dependency.
  //
  // Normally `desktop-ui/node_modules/@agentorch/shared` is a link and Turbopack
  // resolves it back to the real directory outside `node_modules`, where its
  // `.ts` is ordinary project source. On a host that refuses to follow reparse
  // points (see docs/plans/incident-2026-09-16-jobs-and-reparse-points.md) it is
  // a real copy inside `node_modules`, and without this line Turbopack stops at
  // `Unknown module type` for that `.ts` file. Listed explicitly so the build
  // does not depend on which of the two layouts the install produced.
  transpilePackages: ["@agentorch/shared"],
};

export default nextConfig;
