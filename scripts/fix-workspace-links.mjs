#!/usr/bin/env node
// Workspace links that this machine cannot follow, made real.
//
// Why this exists (2026-09-16): on a Windows host that refuses to follow
// UNTRUSTED reparse points, junctions and symlinks are unreadable *to every
// process* -- not only to Ensemble's children. Verified cross-process on the
// affected machine: a junction created and read by the same process fails, and a
// WMI-spawned `cmd` (a non-descendant process tree) fails identically with
// "the mount point is not trusted".
//
// `pnpm` links workspace packages with a junction
// (`core/node_modules/@agentorch/shared -> ../../shared`), so on such a host
// module resolution, `tsc`, and `vitest` all fail with a bare
// `UNKNOWN: unknown error, open ...` that names no cause -- and `pnpm install`
// itself cannot repair it, because pnpm has to read through the link it just
// created.
//
// `.npmrc` already asks pnpm for a hoisted, injected (hardlink-copied) layout,
// which is what keeps THIRD-PARTY packages resolvable. This script applies the
// same rule to the workspace packages themselves: a real copy instead of a link.
//
// Idempotent by construction: it only touches a dependency it cannot read
// through. On a healthy machine it is a no-op that says so.
//
// Usage: `node scripts/fix-workspace-links.mjs` (also wired to `pnpm deps:repair`
// and to the root `postinstall`, so a later `pnpm install` heals itself).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Which local packages are consumed by which workspace packages.
 *
 *  Read from package.json rather than hardcoded: a new cross-package dependency
 *  must be repaired by the same rule without anyone remembering this file. */
function workspaceLinks() {
  const packages = ["shared", "core", "desktop-ui", "ensemble_server"];
  const localNames = new Map();
  for (const dir of packages) {
    const manifest = join(repoRoot, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.name) localNames.set(pkg.name, dir);
  }

  const links = [];
  for (const dir of packages) {
    const manifest = join(repoRoot, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      const target = localNames.get(name);
      if (!target) continue;
      links.push({ consumer: dir, name, source: join(repoRoot, target) });
    }
  }
  return links;
}

/** Can this dependency actually be read through? */
function readable(depDir) {
  try {
    readFileSync(join(depDir, "package.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Remove a LINK without following it.
 *
 *  `rm -r` on a junction can delete the target's contents on Windows, so the
 *  link is removed with `rmdir`, which drops the reparse point and nothing
 *  else. */
function removeLink(path) {
  execFileSync("cmd", ["/c", "rmdir", path], { stdio: "ignore" });
}

const results = [];
for (const { consumer, name, source } of workspaceLinks()) {
  const depDir = join(repoRoot, consumer, "node_modules", ...name.split("/"));
  if (!existsSync(depDir)) {
    results.push(`${consumer}: ${name} missing (run pnpm install first)`);
    continue;
  }
  if (readable(depDir)) {
    results.push(`${consumer}: ${name} readable`);
    continue;
  }
  removeLink(depDir);
  if (existsSync(depDir)) {
    rmSync(depDir, { recursive: true, force: true });
  }
  cpSync(source, depDir, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(source.length);
      return !rel.includes("node_modules") && !rel.includes(".git");
    },
  });
  if (!readable(depDir)) {
    console.error(`[deps] ${consumer}: ${name} is STILL unreadable after copying`);
    process.exitCode = 1;
    continue;
  }
  results.push(`${consumer}: ${name} was an unusable link -> real copy`);
}

console.log(`[deps] workspace links checked:\n  ${results.join("\n  ")}`);
