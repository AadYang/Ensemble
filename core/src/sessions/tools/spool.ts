// The bounded spool: where a tool puts output that may be larger than the
// result it is allowed to hand back.
//
// The failure this replaces is the one a size check AFTER collection cannot fix:
//
//   const chunks: Buffer[] = [];
//   child.stdout.on("data", (buf) => chunks.push(buf));
//   …
//   const output = Buffer.concat(chunks).toString("utf8");   // ← peak == result
//   if (tooBig(output)) storeAsArtifact(output);
//
// Every byte is in memory before anything decides whether it should have been,
// so a command that prints a gigabyte takes the sidecar down while "handling"
// it. The decision has to be made WHILE the bytes arrive, and it has to cost a
// fixed amount of memory whatever the result weighs.
//
// So the spool keeps at most `memoryLimitBytes` in memory. Past that it spills
// to a temporary file and holds nothing: the bytes go to disk as they arrive,
// and the size and the digest are updated incrementally, so at the end there is
// nothing to compute over a copy of the result — the numbers are already there.
// The body is then committed as an artifact straight from the spool, in chunks,
// without ever being assembled.
//
// Two details that are not optional:
//   • bytes are decoded through a StringDecoder as they arrive, and the CANONICAL
//     UTF-8 is what gets stored, hashed and measured. A multi-byte character
//     split across two pipe chunks would otherwise become U+FFFD — and a digest
//     taken over the raw bytes would not be the digest of the stored text.
//   • the spill file is removed by `dispose()`, which every caller runs in a
//     `finally`. A command that FAILS still wrote a file, and a temp file that
//     outlives a failed command is a leak that only shows up on the disk of
//     whoever ran it most.

import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { utf8SafeEnd } from "../../artifacts.js";
import type { ArtifactBodySource } from "../../artifacts.js";

/** Bytes a chunked read/write is cut into. Matches the artifact chunk size so a
 *  spooled body goes to storage in the same units it was read from the spill
 *  file, with no re-slicing in between. */
const DEFAULT_CHUNK_BYTES = 1_048_576;

export interface SpoolOptions {
  /** Bytes held in memory before anything spills. Past this the spool holds
   *  NOTHING: the body lives in the spill file until it is committed, and a
   *  reader asks for the range it needs. */
  memoryLimitBytes: number;
  /** Short label used in the spill file name, so a leftover file on a developer
   *  machine says which tool produced it. */
  label: string;
  /** Injected for tests. Defaults to the OS temp directory. */
  tmpDir?: string;
}

export class OutputSpool implements ArtifactBodySource {
  private readonly limit: number;
  private readonly label: string;
  private readonly tmpDir: string;
  /** Bytes held in memory, in arrival order. Emptied at the moment of spilling. */
  private held: Buffer[] = [];
  private heldBytes = 0;
  private fd: number | null = null;
  private spillPath: string | null = null;
  /** The in-memory body, assembled once, when a reader wants it and the body
   *  never spilled. Bounded by `limit`, which is why it can be assembled. */
  private inline: Buffer | null = null;
  private readonly decoder = new StringDecoder("utf8");
  private readonly hash = createHash("sha256");
  private sealed = false;
  private disposed = false;
  private total = 0;
  private peakHeld = 0;

  constructor(opts: SpoolOptions) {
    this.limit = Math.max(1, Math.floor(opts.memoryLimitBytes));
    this.label = opts.label.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "spool";
    this.tmpDir = opts.tmpDir ?? tmpdir();
  }

  /** Bytes written so far, exactly as they will be stored. */
  get byteSize(): number {
    this.seal();
    return this.total;
  }

  /** sha256 of the bytes as they will be stored — computed as they arrived, not
   *  by walking a copy at the end. */
  get sha256(): string {
    this.seal();
    return this.hash.copy().digest("hex");
  }

  /** True when the body outgrew the memory limit and lives in the spill file. */
  get spilled(): boolean {
    return this.spillPath !== null;
  }

  /** The most bytes this spool ever held in memory. The bound is the point of
   *  the class, so it is observable rather than argued about. */
  get peakRetainedBytes(): number {
    return this.peakHeld;
  }

  /** Append raw bytes from a pipe/file. Invalid UTF-8 becomes U+FFFD exactly as
   *  decoding a whole buffer would produce it, and a character split across two
   *  calls is held until its other half arrives. */
  write(chunk: Buffer | string): void {
    if (this.sealed) throw new Error("this spool was already read: append before the body is consumed");
    if (this.disposed) throw new Error("this spool was disposed");
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (text.length === 0) return;
    this.append(Buffer.from(text, "utf8"));
  }

  /** One line, newline included. Tools that produce one match per line write
   *  through here so the spool never has to guess where a line ended. */
  writeLine(line: string): void {
    this.write(`${line}\n`);
  }

  /** The first `maxBytes` bytes as text, cut on a character boundary. Reads the
   *  head of the spill file (or of the memory buffer) and nothing else. */
  preview(maxBytes: number): string {
    this.seal();
    const want = Math.max(1, Math.floor(maxBytes));
    const raw = this.readAt(0, Math.min(this.total, want + 4));
    return raw.subarray(0, utf8SafeEnd(raw, 0, want)).toString("utf8");
  }

  /** The whole body as one string. Throws when it spilled — the caller is
   *  asking for the thing that was deliberately not kept. */
  text(): string {
    this.seal();
    if (this.spilled) {
      throw new Error(
        `this spool holds ${this.total} bytes in ${this.spillPath} and was spilled because it exceeded the ` +
          `${this.limit}-byte memory limit: read it in chunks or store it as an artifact instead of asking for it whole`,
      );
    }
    return this.inlineBuffer().toString("utf8");
  }

  /** The body in chunks of at most `chunkBytes` bytes, each cut on a character
   *  boundary so that concatenating them reproduces the stored bytes exactly. */
  *chunks(chunkBytes: number = DEFAULT_CHUNK_BYTES): Generator<Buffer> {
    this.seal();
    const step = Math.max(1, Math.floor(chunkBytes));
    let from = 0;
    while (from < this.total) {
      const raw = this.readAt(from, Math.min(this.total - from, step + 4));
      const end = utf8SafeEnd(raw, 0, step);
      const out = raw.subarray(0, end);
      if (out.length === 0) return; // unreachable: utf8SafeEnd always advances
      from += out.length;
      yield out;
    }
  }

  /** Remove the spill file. Idempotent, and safe to call when nothing spilled. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const path = this.spillPath;
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed by a failed write; the unlink below is the real work */
      }
      this.fd = null;
    }
    this.held = [];
    this.heldBytes = 0;
    this.inline = null;
    if (path !== null) {
      try {
        unlinkSync(path);
      } catch {
        /* the file is already gone — that is the state dispose() exists to reach */
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Flush the decoder's pending partial character and stop accepting writes.
   *  Called by every reader, so there is no "finish()" step a caller can forget
   *  — the reason a trailing byte could otherwise go missing. */
  private seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    const tail = this.decoder.end();
    if (tail.length > 0) this.append(Buffer.from(tail, "utf8"));
  }

  private append(bytes: Buffer): void {
    // The limit is checked BEFORE the bytes are kept, so peak retained memory is
    // the limit itself and not the limit plus one chunk.
    if (this.spillPath === null && this.heldBytes + bytes.length > this.limit) this.spill();
    this.total += bytes.length;
    this.hash.update(bytes);
    if (this.fd === null) {
      this.held.push(bytes);
      this.heldBytes += bytes.length;
      if (this.heldBytes > this.peakHeld) this.peakHeld = this.heldBytes;
      return;
    }
    writeSync(this.fd, bytes);
  }

  /** Move everything held into a temporary file and drop it from memory. */
  private spill(): void {
    const path = join(this.tmpDir, `ensemble-spool-${process.pid}-${randomUUID()}-${this.label}.tmp`);
    this.fd = openSync(path, "wx+");
    this.spillPath = path;
    for (const buf of this.held) writeSync(this.fd!, buf);
    this.held = [];
    this.heldBytes = 0;
  }

  /** Bytes [from, from + len) from wherever the body lives. Bounded by `len`. */
  private readAt(from: number, len: number): Buffer {
    if (len <= 0) return Buffer.alloc(0);
    if (this.fd === null) return this.inlineBuffer().subarray(from, from + len);
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(this.fd, buf, 0, len, from);
    return buf.subarray(0, read);
  }

  private inlineBuffer(): Buffer {
    if (this.inline === null) this.inline = Buffer.concat(this.held);
    return this.inline;
  }
}
