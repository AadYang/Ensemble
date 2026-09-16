import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The write path ends in a sqlite row, and `db.js` picks that file at module
// load — hence the env redirect + dynamic import (same pattern as the other
// db-backed tests).
const TMP = mkdtempSync(join(tmpdir(), "provider-transport-"));
process.env.AGENTORCH_DATA_DIR = TMP;
process.env.AGENTORCH_DB_PATH = join(TMP, "providers.db");

let pt: typeof import("../provider-transport.js");
let db: typeof import("../db.js");
let caps: typeof import("../capability/transport.js");

beforeAll(async () => {
  pt = await import("../provider-transport.js");
  db = await import("../db.js");
  caps = await import("../capability/transport.js");
});

afterAll(() => {
  try {
    db?.closeDb();
  } catch {
    // already closed — the cleanup below is what matters.
  }
  rmSync(TMP, { recursive: true, force: true });
});

// The three writes the HTTP layer performs, exercised through the SAME helpers
// the routes call. The routes themselves are Fastify handlers inside the
// listen-on-import entry point, so what is pinned here is the contract they
// delegate to: schema shape, kind policy, merge rule, and what actually lands in
// the row — plus the property that matters most, that the planner reads the
// value back.

describe("transport choice schema", () => {
  it("accepts the three preferences on create", () => {
    for (const value of ["auto", "responses", "chat-completions"]) {
      expect(pt.transportInputSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it("refuses a value that is not a preference", () => {
    for (const value of ["native-cli", "Responses", "", 42, {}]) {
      expect(pt.transportInputSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });

  it("lets a patch clear the choice with null, which create cannot", () => {
    expect(pt.transportPatchSchema.safeParse(null).success).toBe(true);
    expect(pt.transportPatchSchema.safeParse("responses").success).toBe(true);
    expect(pt.transportInputSchema.safeParse(null).success).toBe(false);
  });
});

describe("transport choice persistence", () => {
  it("stores the choice on create, and the planner reads it back", async () => {
    const applied = pt.transportMetadataFor({
      kind: "openai-compat",
      transport: "responses",
      metadata: {},
    });
    expect(applied.ok).toBe(true);
    const created = await db.prisma.provider.create({
      data: {
        name: "pt-create",
        kind: "openai-compat",
        baseUrl: "https://pt.example/v1",
        apiKey: "k",
        metadata: applied.ok && applied.metadata ? applied.metadata : {},
      },
    });
    expect(created.metadata).toEqual({ transport: "responses" });
    // The API response shape and the planner read the same value.
    expect(pt.readProviderTransport(created.metadata)).toBe("responses");
    expect(caps.readProviderTransportPreference(created.metadata)).toBe("responses");
  });

  it("updates the choice on patch without dropping the other metadata", async () => {
    const before = await db.prisma.provider.create({
      data: {
        name: "pt-patch",
        kind: "openai-compat",
        baseUrl: "https://pt.example/v1",
        apiKey: "k",
        metadata: { transport: "auto", notes: "kept" },
      },
    });
    const applied = pt.transportMetadataFor({
      kind: before.kind,
      transport: "chat-completions",
      metadata: before.metadata,
    });
    expect(applied.ok).toBe(true);
    const updated = await db.prisma.provider.update({
      where: { id: before.id },
      data: applied.ok && applied.metadata ? { metadata: applied.metadata } : {},
    });
    expect(updated.metadata).toEqual({ transport: "chat-completions", notes: "kept" });
    expect(caps.readProviderTransportPreference(updated.metadata)).toBe("chat-completions");
  });

  it("clears the choice with null, leaving no key behind", async () => {
    const before = await db.prisma.provider.create({
      data: {
        name: "pt-clear",
        kind: "openai-local",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        metadata: { transport: "responses", defaultSandbox: "workspace-write" },
      },
    });
    const applied = pt.transportMetadataFor({
      kind: before.kind,
      transport: null,
      metadata: before.metadata,
    });
    expect(applied.ok).toBe(true);
    const updated = await db.prisma.provider.update({
      where: { id: before.id },
      data: applied.ok && applied.metadata ? { metadata: applied.metadata } : {},
    });
    expect(updated.metadata).toEqual({ defaultSandbox: "workspace-write" });
    expect(pt.readProviderTransport(updated.metadata)).toBeNull();
    expect(caps.readProviderTransportPreference(updated.metadata)).toBeUndefined();
  });

  it("reports nothing to write when the value is already stored", () => {
    const applied = pt.transportMetadataFor({
      kind: "openai-compat",
      transport: "auto",
      metadata: { transport: "auto" },
    });
    expect(applied).toEqual({ ok: true, metadata: null });
    // …and clearing an absent choice is a no-op, not an empty-blob write.
    expect(
      pt.transportMetadataFor({ kind: "openai-compat", transport: null, metadata: {} }),
    ).toEqual({ ok: true, metadata: null });
  });

  it("refuses the choice on a kind with no HTTP transport, before any write", () => {
    for (const kind of ["anthropic-local", "openai-codex", "anthropic"]) {
      const applied = pt.transportMetadataFor({ kind, transport: "responses", metadata: {} });
      expect(applied.ok, kind).toBe(false);
      if (!applied.ok) {
        expect(applied.error).toBe("invalid_for_kind");
        expect(applied.message).toContain(kind);
      }
    }
    expect(pt.isTransportPreferenceKind("openai-compat")).toBe(true);
    expect(pt.isTransportPreferenceKind("openai-local")).toBe(true);
  });

  it("reads an unrecognised stored value as no choice, never as auto", async () => {
    const row = await db.prisma.provider.create({
      data: {
        name: "pt-handedited",
        kind: "openai-compat",
        baseUrl: "https://pt.example/v1",
        apiKey: "k",
        metadata: { transport: "Responses" },
      },
    });
    expect(pt.readProviderTransport(row.metadata)).toBeNull();
    expect(caps.readProviderTransportPreference(row.metadata)).toBeUndefined();
  });
});
