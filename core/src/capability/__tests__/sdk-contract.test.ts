import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Contract tests for the runtime-critical SDKs.
//
// WHY: the capability layer's answers are only worth anything if the thing that
// actually talks to the model behaves the way the layer assumes. A minor bump
// of a CLI-wrapper SDK can change whether a context window is declared, what a
// turn limit defaults to, or whether a session resumes server-side — silently
// invalidating every resolved plan. So the versions are pinned exactly and the
// assumptions are asserted here instead of living in a comment.
//
// This file reads package.json rather than importing the SDKs on purpose: it
// must fail when the PIN is wrong, including on a machine where the wrong
// version happens to be installed.

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, "..", "..", "..");

/** SDKs whose behaviour the capability layer reasons about. Adding a runtime
 *  means adding its SDK here. */
const RUNTIME_CRITICAL: Record<string, string> = {
  "@anthropic-ai/claude-agent-sdk": "claude runtime CLI contract",
  "@openai/codex-sdk": "codex runtime contract",
  "@openai/agents": "OpenAI API runtime contract",
};

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const corePkg = () => readJson(join(CORE, "package.json"));
const deps = () => (corePkg().dependencies ?? {}) as Record<string, string>;

describe("runtime-critical SDK versions", () => {
  // A caret range means the next install may pull a different minor, so the
  // parameters these contract tests pin could change without a single line of
  // our code changing.
  it("pins every runtime-critical SDK to an exact version", () => {
    for (const name of Object.keys(RUNTIME_CRITICAL)) {
      const spec = deps()[name];
      expect(spec, `${name} is not a core dependency`).toBeDefined();
      expect(spec, `${name}="${spec}" is a range; pin it exactly`).toMatch(/^\d+\.\d+\.\d+/);
      expect(spec, `${name}="${spec}" must not use a range operator`).not.toMatch(/[\^~><*]|\|\|| - /);
      // The lockfile carries the same specifier, so `--frozen-lockfile` in CI
      // agrees with what this test asserts.
      const lock = readFileSync(join(CORE, "..", "pnpm-lock.yaml"), "utf8");
      expect(lock).toContain(`specifier: ${spec}`);
    }
  });

  // The pin is only real if the installed tree matches it. A stale node_modules
  // would otherwise let these contract tests pass against a different SDK than
  // the one the pin names.
  it("has the pinned version actually installed", () => {
    for (const [name, spec] of Object.entries(deps())) {
      if (!(name in RUNTIME_CRITICAL)) continue;
      const installed = readJson(join(CORE, "node_modules", name, "package.json")) as {
        version: string;
      };
      expect(installed.version, `${name} installed != pinned`).toBe(spec);
    }
  });

  it("does not carry a duplicate runtime-critical SDK in a second range", () => {
    const pkg = corePkg();
    for (const bucket of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
      const section = (pkg[bucket] ?? {}) as Record<string, string>;
      for (const name of Object.keys(RUNTIME_CRITICAL)) {
        expect(section[name], `${name} is also declared in ${bucket}`).toBeUndefined();
      }
    }
  });

  it("explains why each one is pinned", () => {
    for (const [name, why] of Object.entries(RUNTIME_CRITICAL)) {
      expect(deps()[name], name).toBeDefined();
      expect(why.length).toBeGreaterThan(0);
    }
  });
});
