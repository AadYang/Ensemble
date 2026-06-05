// Crop the three raw QR screenshots down to their QR-only square, equalize
// size + format, and write them into public/assets/. The originals (wechat,
// douyin, miniapp/视频号) come from different apps' share dialogs and look
// inconsistent at the source — this script normalizes them.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "assets");
const TARGET = 360;

// Each source needs a specific crop window. Values are fractions of the
// source dimensions (0–1) so they survive any future resize.
const JOBS = [
  {
    src: "20260514-204654.jpg", // WeChat (square QR with WeChat logo center)
    out: "qr-wechat.png",
    crop: { x: 0.17, y: 0.31, w: 0.66, h: 0.45 },
  },
  {
    src: "20260514-204600.jpg", // Douyin (round QR with E logo center)
    out: "qr-douyin.png",
    crop: { x: 0.17, y: 0.13, w: 0.67, h: 0.45 },
  },
  {
    src: "20260514-204532.jpg", // Mini program / 视频号 (radial QR with E center)
    out: "qr-miniapp.png",
    crop: { x: 0.13, y: 0.27, w: 0.75, h: 0.59 },
  },
];

for (const job of JOBS) {
  const srcPath = path.join(ROOT, job.src);
  const buf = readFileSync(srcPath);
  const meta = await sharp(buf).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const left = Math.round(W * job.crop.x);
  const top = Math.round(H * job.crop.y);
  const width = Math.round(W * job.crop.w);
  const height = Math.round(H * job.crop.h);
  const square = Math.max(width, height);
  console.log(`[qr] ${job.src} ${W}×${H} → crop ${width}×${height} → ${TARGET}px`);
  const cropped = await sharp(buf)
    .extract({ left, top, width, height })
    .extend({
      top: Math.floor((square - height) / 2),
      bottom: Math.ceil((square - height) / 2),
      left: Math.floor((square - width) / 2),
      right: Math.ceil((square - width) / 2),
      background: { r: 255, g: 255, b: 255 },
    })
    .resize(TARGET, TARGET, { fit: "contain", background: { r: 255, g: 255, b: 255 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(path.join(OUT_DIR, job.out), cropped);
}
console.log("[qr] done → public/assets/qr-*.png");
