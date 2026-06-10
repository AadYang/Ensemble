import { execFileSync } from "node:child_process";

if (process.env.ENSEMBLE_SKIP_DESKTOP_PREP === "1") {
  console.log("[tauri-before-build] skipping desktop:prep; caller already prepared assets");
  process.exit(0);
}

execFileSync("pnpm", ["desktop:prep"], {
  stdio: "inherit",
  shell: true,
});
