import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("[macos-dmg] macOS is required");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const tauriConfig = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const productName = tauriConfig.productName ?? "Ensemble";
const version = tauriConfig.version ?? "0.0.0";
const targetTriple = process.env.TAURI_TARGET_TRIPLE ?? "";
if (targetTriple === "universal-apple-darwin") {
  console.error("[macos-dmg] universal DMG requires a dedicated universal app build workflow");
  process.exit(1);
}
const targetRoot = targetTriple
  ? path.join(ROOT, "src-tauri", "target", targetTriple, "release")
  : path.join(ROOT, "src-tauri", "target", "release");
const appPath = path.join(
  targetRoot,
  "bundle",
  "macos",
  `${productName}.app`,
);
const dmgDir = path.join(targetRoot, "bundle", "dmg");
const arch = targetTriple.includes("x86_64")
  ? "x64"
  : targetTriple.includes("universal")
    ? "universal"
    : process.arch === "arm64"
      ? "aarch64"
      : process.arch;
const dmgPath = path.join(dmgDir, `${productName}_${version}_${arch}.dmg`);
const signingIdentity = process.env.ENSEMBLE_CODESIGN_IDENTITY ?? process.env.APPLE_SIGNING_IDENTITY ?? "-";

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
}

function sign(pathToSign, extraArgs = []) {
  const args = ["--force", "--sign", signingIdentity, ...extraArgs, pathToSign];
  run("codesign", args);
}

function adHocOrDeveloperSignApp() {
  const macosDir = path.join(appPath, "Contents", "MacOS");
  const runtimeArgs = signingIdentity === "-" ? [] : ["--options", "runtime"];
  sign(path.join(macosDir, "ensemble-core"), runtimeArgs);
  sign(path.join(macosDir, "ensemble"), runtimeArgs);
  sign(appPath, ["--deep", ...runtimeArgs]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

if (!existsSync(appPath) || !lstatSync(appPath).isDirectory()) {
  console.error(`[macos-dmg] missing app bundle: ${appPath}`);
  console.error("[macos-dmg] run `pnpm dlx @tauri-apps/cli@latest build --bundles app` first");
  process.exit(1);
}

console.log(`[macos-dmg] signing ${appPath}`);
adHocOrDeveloperSignApp();

mkdirSync(dmgDir, { recursive: true });
rmSync(dmgPath, { force: true });

const stagingDir = mkdtempSync(path.join(tmpdir(), "ensemble-dmg-"));
const intermediateDmg = path.join(tmpdir(), `ensemble-rw-${Date.now()}.dmg`);
const mountRoot = mkdtempSync(path.join(tmpdir(), "ensemble-mount-"));
let mountPoint = null;
try {
  const stagedApp = path.join(stagingDir, `${productName}.app`);
  console.log(`[macos-dmg] staging ${stagedApp}`);
  run("ditto", [appPath, stagedApp]);
  symlinkSync("/Applications", path.join(stagingDir, "Applications"));

  // Two-pass DMG build: first a read-write UDRW we can mount + customize
  // via AppleScript, then a compressed UDZO for distribution.
  //
  // Why we don't just `hdiutil create -srcfolder ... -ov -format UDZO`:
  // a compressed-immutable DMG is shipped without a saved Finder layout,
  // so when the user mounts it they see a generic icon list and have no
  // visual hint that the app should be dragged onto the Applications
  // alias. Without that hint, several users have copied Ensemble.app to
  // ~/Documents instead of /Applications (the reported "Ensemble 没有
  // 出现在应用程序内而是在文稿内" bug). The applescript below positions
  // the icons, sets a roomy window, and switches Finder to icon view so
  // the drag target is unambiguous.
  console.log(`[macos-dmg] creating intermediate R/W DMG`);
  run("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    stagingDir,
    "-ov",
    "-format",
    "UDRW",
    "-fs",
    "HFS+",
    intermediateDmg,
  ]);

  console.log(`[macos-dmg] mounting R/W DMG to apply Finder layout`);
  const attachOut = execFileSync(
    "hdiutil",
    [
      "attach",
      "-readwrite",
      "-noverify",
      "-noautoopen",
      "-mountroot",
      mountRoot,
      intermediateDmg,
    ],
    { encoding: "utf8" },
  );
  // hdiutil returns one or more lines like: "/dev/diskN \tApple_HFS\t/Volumes/Ensemble"
  // — grab the actual mountpoint in case the suggested one collided.
  const mountLine = attachOut
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.includes(mountRoot));
  mountPoint = mountLine?.split("\t").pop()?.trim() ?? path.join(mountRoot, productName);
  console.log(`[macos-dmg] mounted at ${mountPoint}`);

  const layoutScript = `
tell application "Finder"
    tell disk "${productName}"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {200, 120, 760, 460}
        set viewOpts to the icon view options of container window
        set arrangement of viewOpts to not arranged
        set icon size of viewOpts to 96
        set position of item "${productName}.app" of container window to {140, 170}
        set position of item "Applications" of container window to {420, 170}
        update without registering applications
        close
    end tell
end tell
`;
  try {
    run("osascript", ["-e", layoutScript]);
  } catch (err) {
    // Layout customization is best-effort — if osascript is blocked by
    // Privacy controls in the build environment, ship an unstyled DMG
    // rather than fail the release. The /Applications symlink is still
    // there so the user can drag, just without the arranged icons.
    console.warn(
      `[macos-dmg] osascript layout failed (${err instanceof Error ? err.message : String(err)}); shipping without Finder layout`,
    );
  }
  // Give the Finder a moment to flush .DS_Store before unmounting,
  // otherwise the layout silently disappears.
  run("sync", []);

  console.log(`[macos-dmg] unmounting R/W DMG`);
  run("hdiutil", ["detach", mountPoint, "-quiet"]);
  mountPoint = null;

  console.log(`[macos-dmg] compressing to ${dmgPath}`);
  run("hdiutil", [
    "convert",
    intermediateDmg,
    "-format",
    "UDZO",
    "-imagekey",
    "zlib-level=9",
    "-o",
    dmgPath,
  ]);

  if (signingIdentity !== "-") {
    sign(dmgPath);
    run("codesign", ["--verify", "--verbose=2", dmgPath]);
  }
} finally {
  if (mountPoint) {
    // detach failed earlier; try once more so we don't leak a mounted volume.
    try {
      execFileSync("hdiutil", ["detach", mountPoint, "-force", "-quiet"], { stdio: "ignore" });
    } catch {
      // best-effort
    }
  }
  rmSync(intermediateDmg, { force: true });
  rmSync(mountRoot, { recursive: true, force: true });
  rmSync(stagingDir, { recursive: true, force: true });
}

console.log(`[macos-dmg] done: ${dmgPath}`);
