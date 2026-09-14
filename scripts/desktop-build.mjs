import { execFileSync } from "node:child_process";

const forceMac = process.argv.includes("--mac");
const targetTriple = process.env.TAURI_TARGET_TRIPLE;

// On Windows, `pnpm` is `pnpm.cmd` and execFileSync without `shell: true`
// can't resolve the .cmd extension via PATHEXT — spawnSync returns ENOENT
// for "pnpm" even though `pnpm` from a shell prompt works fine. Setting
// shell:true defers the lookup to cmd.exe, which DOES walk PATHEXT.
// On POSIX `pnpm` is a script symlink picked up directly; shell:true is
// harmless either way for our arg shapes (no shell-metacharacters).
function run(command, args, options = {}) {
  execFileSync(command, args, {
    // Ignore stdin instead of inheriting it. Under `pnpm run desktop:build`
    // the inherited stdin can be a broken pipe, and on Windows a grandchild
    // node process (scripts/prep-sidecar.mjs) intermittently fails to start
    // with STATUS_DLL_INIT_FAILED (0xC0000142) when it inherits that handle.
    stdio: ["ignore", "inherit", "inherit"],
    shell: true,
    env: { ...process.env, ...options.env },
  });
}

if (forceMac && process.platform !== "darwin") {
  console.error("[desktop-build] --mac requires macOS");
  process.exit(1);
}

if (process.platform === "darwin" || forceMac) {
  const tauriArgs = ["dlx", "@tauri-apps/cli@latest", "build", "--bundles", "app"];
  if (targetTriple) {
    tauriArgs.push("--target", targetTriple);
  }
  run("pnpm", ["desktop:prep"]);
  run("pnpm", tauriArgs, { env: { ENSEMBLE_SKIP_DESKTOP_PREP: "1" } });
  run("node", ["scripts/macos-dmg.mjs"]);
} else {
  run("pnpm", ["desktop:prep"]);
  run("pnpm", ["desktop:build:tauri"], { env: { ENSEMBLE_SKIP_DESKTOP_PREP: "1" } });
}
