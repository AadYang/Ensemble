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
};

export default nextConfig;
