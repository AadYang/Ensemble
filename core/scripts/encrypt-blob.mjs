// Layer 3 of source protection: encrypt the obfuscated CJS bundle with
// AES-256-GCM and emit a thin SEA-compatible loader stub.
//
// Build-time flow:
//   1. Generate random 32-byte AES key + 12-byte nonce.
//   2. Encrypt dist/ensemble-core.cjs → dist/ensemble-core.enc
//      (payload format: nonce || authTag || ciphertext).
//   3. Write dist/loader.cjs — the new SEA main; reads the encrypted
//      payload via sea.getAsset(), gets the key from process env
//      (ENSEMBLE_BLOB_KEY), decrypts, evaluates.
//   4. Write src-tauri/src/blob_key.rs — a generated Rust source file
//      containing the key as a const &[u8; 32]. Tauri's spawn code reads
//      that const and passes the hex-encoded key to the sidecar via env
//      var. The key is therefore baked into the Rust native binary, not
//      into the readable Node SEA blob.
//
// Threat model raised:
//   - Casual: extract SEA blob → only get loader stub + encrypted bytes.
//     Useless without the key.
//   - Determined: strings-dump the Rust binary → find the 32-byte sequence.
//     Manageable. The key is mixed with a per-build nonce constant inside
//     Rust so it doesn't appear as a contiguous string literal — see the
//     emit_rust_key() function below.
//   - Expert: attach debugger to running sidecar → grab decrypted bundle
//     from memory. The L2 self-defending + debug protection layer triggers
//     here; a debugger pause halts the runtime in an infinite check loop.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CORE_ROOT, "..");
const PAYLOAD_IN = path.join(CORE_ROOT, "dist", "ensemble-core.cjs");
const PAYLOAD_OUT = path.join(CORE_ROOT, "dist", "ensemble-core.enc");
const LOADER_OUT = path.join(CORE_ROOT, "dist", "loader.cjs");
const RUST_KEY_OUT = path.join(REPO_ROOT, "src-tauri", "src", "blob_key.rs");

console.log("[encrypt] generating AES-256-GCM key + nonce");
const key = crypto.randomBytes(32);
const nonce = crypto.randomBytes(12);

console.log(`[encrypt] reading ${PAYLOAD_IN}`);
const plaintext = readFileSync(PAYLOAD_IN);

const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const authTag = cipher.getAuthTag();

const payload = Buffer.concat([nonce, authTag, ciphertext]);
writeFileSync(PAYLOAD_OUT, payload);
console.log(
  `[encrypt] payload: ${(plaintext.length / 1024 / 1024).toFixed(2)} MB → ${(
    payload.length / 1024 / 1024
  ).toFixed(2)} MB  (nonce ${nonce.length}B + tag ${authTag.length}B + ciphertext)`,
);

// ─── Loader stub (SEA main) ────────────────────────────────────────────────
// This is the ONLY JS that gets stored in the SEA blob in cleartext.
// Kept intentionally small + obvious in shape; the real bundle is inside
// the encrypted asset and only reachable with the right key.
const loaderSrc = `// Ensemble SEA loader stub. Real bundle is encrypted in asset 'payload'.
const { getAsset } = require('node:sea');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

const keyHex = process.env.ENSEMBLE_BLOB_KEY;
if (!keyHex || keyHex.length !== 64) {
  console.error('[ensemble] missing or malformed ENSEMBLE_BLOB_KEY (got len=' + (keyHex ? keyHex.length : 0) + '). The sidecar must be launched by the Ensemble shell binary.');
  process.exit(2);
}
const key = Buffer.from(keyHex, 'hex');
globalThis.__ENSEMBLE_BLOB_KEY = keyHex;
delete process.env.ENSEMBLE_BLOB_KEY;

const buf = Buffer.from(getAsset('payload'));
const nonce = buf.subarray(0, 12);
const authTag = buf.subarray(12, 28);
const ciphertext = buf.subarray(28);

const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
decipher.setAuthTag(authTag);
const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

// Wipe the in-memory copies that aren't strictly needed past this point.
buf.fill(0);
key.fill(0);

// Run the decrypted bundle as a CJS module. Use a Module instance so
// require() / module.exports / __filename / __dirname work as normal.
const m = new Module(path.join(__dirname, 'ensemble-core.cjs'));
m.filename = path.join(process.execPath, '..', 'ensemble-core.cjs');
m.paths = Module._nodeModulePaths(path.dirname(m.filename));
m._compile(plaintext.toString('utf8'), m.filename);
`;

writeFileSync(LOADER_OUT, loaderSrc);
console.log(`[encrypt] loader → ${LOADER_OUT}`);

// ─── Emit Rust source with the key ─────────────────────────────────────────
// We don't write the 32 bytes as a single literal because `strings` would
// dump them as one contiguous run. Instead we XOR the key with a per-build
// scramble mask and split across two const arrays, recombining at runtime.
// (Not real crypto — just steganographic noise to thwart trivial scans.)
const scramble = crypto.randomBytes(32);
const obfuscatedKey = Buffer.alloc(32);
for (let i = 0; i < 32; i++) obfuscatedKey[i] = key[i] ^ scramble[i];

const fmt = (buf) =>
  Array.from(buf)
    .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
    .join(", ");

const rustSrc = `// AUTO-GENERATED by core/scripts/encrypt-blob.mjs — DO NOT EDIT.
// Regenerated on every \`pnpm desktop:build\`. Different build = different key.
// The bytes below are XOR-scrambled across two arrays; see blob_key() for the
// recombination step.

const SCRAMBLED: [u8; 32] = [
    ${fmt(obfuscatedKey)},
];

const MASK: [u8; 32] = [
    ${fmt(scramble)},
];

/// Returns the 64-char hex string passed to the sidecar via the
/// ENSEMBLE_BLOB_KEY env var. The bytes are reassembled at call time so
/// they don't appear as a single contiguous run in a strings dump.
pub fn blob_key_hex() -> String {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = SCRAMBLED[i] ^ MASK[i];
    }
    let mut hex = String::with_capacity(64);
    for b in out.iter() {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}
`;

mkdirSync(path.dirname(RUST_KEY_OUT), { recursive: true });
writeFileSync(RUST_KEY_OUT, rustSrc);
console.log(`[encrypt] rust key module → ${RUST_KEY_OUT}`);
