import { execFileSync } from "node:child_process";

if (process.env.ENSEMBLE_SKIP_DESKTOP_PREP === "1") {
  console.log("[tauri-before-build] skipping desktop:prep; caller already prepared assets");
  process.exit(0);
}

execFileSync("pnpm", ["desktop:prep"], {
  // Same stdin-inheritance hazard as scripts/desktop-build.mjs: a broken
  // inherited stdin can make the grandchild prep-sidecar node process fail to
  // start on Windows (STATUS_DLL_INIT_FAILED).
  stdio: ["ignore", "inherit", "inherit"],
  shell: true,
});
