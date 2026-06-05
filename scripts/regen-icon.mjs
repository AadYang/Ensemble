// Regenerate all platform icon variants from src-tauri/icons/source.svg.
// 1) sharp renders SVG → 1024px PNG master.
// 2) @tauri-apps/cli icon expands that master into every required size
//    (icon.ico, icon.icns, icon.png, 32x32.png, 128x128.png, 128x128@2x.png,
//    Square*Logo.png for the Windows installer / Store).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const svgPath = resolve(root, "src-tauri/icons/source.svg");
const masterPath = resolve(root, "src-tauri/icons/_master-1024.png");

console.log("[icon] rendering SVG →", masterPath);
const svg = readFileSync(svgPath);
const png = await sharp(svg, { density: 384 })
  .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toBuffer();
writeFileSync(masterPath, png);

console.log("[icon] expanding via @tauri-apps/cli icon");
const r = spawnSync(
  "pnpm",
  ["dlx", "@tauri-apps/cli@latest", "icon", masterPath, "-o", "src-tauri/icons"],
  { stdio: "inherit", cwd: root, shell: true },
);
if (r.status !== 0) {
  console.error("[icon] tauri icon failed (status", r.status, ")");
  process.exit(r.status ?? 1);
}
console.log("[icon] done — restart desktop:build to bundle the new icons");
