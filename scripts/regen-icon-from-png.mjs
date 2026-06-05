// Regenerate platform icon set from a raster source PNG.
// Trims/pads the source to 1024×1024 with the app dark bg, then expands
// via @tauri-apps/cli icon.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const srcPath = process.argv[2] ?? "D:/icon.png";
const masterPath = resolve(root, "src-tauri/icons/_master-1024.png");
const APP_BG = { r: 0x0a, g: 0x0e, b: 0x14, alpha: 1 };

console.log("[icon] source:", srcPath);
const raw = sharp(readFileSync(srcPath));
const meta = await raw.metadata();
console.log(`[icon] meta: ${meta.width}x${meta.height} ${meta.format}`);

// Strip enough margin to land INSIDE the source's rounded-rect dark bg
// (the area outside the rounded corner is white-ish on the source PNG and
// would bleed into our final icon). Bottom needs an extra cut for the
// "豆包AI生成" watermark.
const trimTop = Math.round(meta.height * 0.07);
const trimSide = Math.round(meta.width * 0.07);
const trimBottom = Math.round(meta.height * 0.14);
const cropW = meta.width - trimSide * 2;
const cropH = meta.height - trimTop - trimBottom;
console.log(`[icon] cropping → ${cropW}x${cropH} (top ${trimTop}, sides ${trimSide}, bottom ${trimBottom})`);

// Step 1: extract the trimmed art (no-watermark, inside the rounded bg).
const trimmed = await sharp(readFileSync(srcPath))
  .extract({ left: trimSide, top: trimTop, width: cropW, height: cropH })
  .toBuffer();

// Step 2: resize the trimmed art so its LONGER side fits ~1024px (we trimmed
// generously, so use the full canvas — the design is already padded inside).
const longSide = Math.max(cropW, cropH);
const fitTarget = 1024;
const scale = fitTarget / longSide;
const resizedW = Math.round(cropW * scale);
const resizedH = Math.round(cropH * scale);
const resized = await sharp(trimmed).resize(resizedW, resizedH).toBuffer();

// Step 3: composite centered onto a 1024x1024 app-bg canvas.
const canvasBuf = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: APP_BG },
})
  .composite([
    {
      input: resized,
      top: Math.round((1024 - resizedH) / 2),
      left: Math.round((1024 - resizedW) / 2),
    },
  ])
  .png({ compressionLevel: 9 })
  .toBuffer();
writeFileSync(masterPath, canvasBuf);
const finalMeta = await sharp(canvasBuf).metadata();
console.log(`[icon] master geometry: ${finalMeta.width}x${finalMeta.height}`);
console.log("[icon] master →", masterPath);

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
console.log("[icon] done");
