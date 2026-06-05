# Ensemble macOS Desktop Parity Guide

This document describes how the macOS desktop app builds, signs, and ships in lock-step with Windows. **Most of what was originally framed as "to do" here is now implemented** — the sections below have been updated to describe the current state (current baseline: `0.0.18`).

Currently shipped:

- macOS DMG build pipeline (`scripts/macos-dmg.mjs`, two-pass R/W → AppleScript layout → UDZO compress)
- Per-platform sidecar staging via `scripts/prep-sidecar.mjs` (writes `ensemble-core-aarch64-apple-darwin` / `ensemble-core-x86_64-apple-darwin` without `.exe`)
- macOS-specific SEA codesign step in `core/scripts/make-exe.mjs`
- macOS activation policy + dual-channel readiness signal (`fs.writeSync` + `.port` sentinel) + 12s watchdog in `src-tauri/src/lib.rs`
- Cross-platform `cli-config.ts` with macOS GUI PATH compensation (`/opt/homebrew/bin`, `~/.local/bin`, etc.)
- `UpdateManifest.platforms` schema + client-side per-platform filtering

Still pending (not blocking dev parity, only first public macOS release):

- First macOS DMG upload to `manifest.platforms.macos-arm64` / `manifest.platforms.macos-x64` — run a clean build on a Mac with Developer ID + notary credentials and push the artifacts
- Hardened-runtime entitlements review (current ad-hoc + `--options runtime` is enough for dev; release notarization requires explicit entitlements file if any sandboxed APIs are added)

## Goals

The macOS build must be the same product, not a separate port:

- Same frontend routes, layout, dialogs, i18n strings, onboarding tutorial, and keyboard behavior.
- Same local sidecar API/WebSocket contract.
- Same provider model: Claude local, OpenAI API, OpenAI-compatible, Codex CLI.
- Same SQLite schema and data semantics.
- Same peer messaging behavior, especially `peer_send` / `peer_query` across Claude, OpenAI, OpenAI-compatible, and Codex agents.
- Same update manifest shape and release discipline.

Platform-native differences are allowed only where macOS requires them: signing, notarization, app bundle paths, permissions, shell environment discovery, and installer format.

## Required macOS Environment

Install and verify:

```bash
xcode-select --install
xcodebuild -version
rustup show
node -v
pnpm -v
cargo -V
```

Expected toolchain:

- Xcode: current stable release from the App Store or Apple Developer.
- Rust: stable toolchain with `aarch64-apple-darwin`; also install `x86_64-apple-darwin` if producing Intel builds.
- Node: same major version as Windows packaging, currently Node 22 or newer.
- pnpm: repo-managed via Corepack if possible.
- Tauri CLI: invoked through `pnpm dlx @tauri-apps/cli@latest build`.
- Apple Developer account for signing and notarization.

Recommended setup:

```bash
corepack enable
pnpm install
rustup target add aarch64-apple-darwin
rustup target add x86_64-apple-darwin
```

## Current Architecture

Runtime shape:

- `desktop-ui`: Next.js static export used as the Tauri WebView frontend.
- `core`: Node sidecar that hosts Fastify HTTP API, WebSocket, SQLite access, MCP bridge, skills, telemetry, and runtime adapters.
- `src-tauri`: Tauri shell that launches the sidecar and loads `http://127.0.0.1:<port>/`.

Packaged app flow:

1. Tauri launches `ensemble-core` as an external binary.
2. Tauri injects environment variables:
   - `ENSEMBLE_AUTO_PORT=1`
   - `AGENTORCH_DATA_DIR`
   - `AGENTORCH_WEB_ROOT`
   - `AGENTORCH_TOKENIZER_DIR`
   - encrypted blob key env used by the SEA loader
3. Sidecar prints `ENSEMBLE_LISTENING <port>`.
4. Tauri loads the local URL in the WebView.

The macOS app must preserve this launch contract.

## Paths And Data Directories

Windows currently uses:

- Data: `%APPDATA%\dev.ensemble.app\`
- Installed app: `%LOCALAPPDATA%\Ensemble\`
- Sidecar: `%LOCALAPPDATA%\Ensemble\ensemble-core.exe`

macOS should use Tauri's app data directory:

- Data: `~/Library/Application Support/dev.ensemble.app/`
- App bundle: `/Applications/Ensemble.app`
- Sidecar inside bundle resources, resolved through Tauri externalBin/resource APIs.

Important persisted files:

- `agentorch.db`
- `agentorch.db-wal`
- `agentorch.db-shm`
- `skills/`
- `codex-runtime/<agentId>/config.toml`
- `codex-runtime/<agentId>/auth.json`

Do not change the SQLite schema or filename for macOS. Cross-platform backups should remain portable.

## Build Scripts (current state)

All three of the following have been updated to be cross-platform; what was originally a "to do" list is now the architecture in place. Sections below describe the current behavior — change at your peril, this is the path validated end-to-end on Windows 0.0.18 and macOS 0.0.18:

- `scripts/prep-sidecar.mjs` — stages the SEA sidecar with the correct target-triple suffix
- `scripts/desktop-build.mjs` — routes `pnpm desktop:build` per platform
- `scripts/macos-dmg.mjs` — two-pass DMG construction with Finder layout
- `core/scripts/make-exe.mjs` — Node SEA binary build + macOS codesign
- `src-tauri/tauri.conf.json` — bundle config (`externalBin`, `resources`)

### Sidecar Naming

Tauri external binaries require target-triple suffixes. Windows currently stages:

```text
src-tauri/binaries/ensemble-core-x86_64-pc-windows-msvc.exe
```

macOS should stage:

```text
src-tauri/binaries/ensemble-core-aarch64-apple-darwin
src-tauri/binaries/ensemble-core-x86_64-apple-darwin
```

Do not include `.exe` on macOS.

`scripts/prep-sidecar.mjs` must:

- Choose output extension by platform.
- Copy from `core/dist/ensemble-core` on macOS and `core/dist/ensemble-core.exe` on Windows.
- Keep `TAURI_TARGET_TRIPLE` override for CI/universal builds.
- Fail loudly if target triple is unknown.

### Node SEA Output

`core/scripts/make-exe.mjs` currently always writes:

```text
core/dist/ensemble-core.exe
```

Refactor it to write:

```text
core/dist/ensemble-core.exe   # Windows
core/dist/ensemble-core       # macOS/Linux
```

The script should still:

- Generate `sea-prep.blob`.
- Copy `process.execPath`.
- Inject `NODE_SEA_BLOB` with `postject`.
- Stage `desktop-ui/static-out` to `core/dist/web`.
- Extract tokenizer data to `core/dist/tokenizer-data`.

macOS-specific postject notes:

- Apple signatures can be invalidated by blob injection. Inject before signing.
- Inject the SEA blob into Mach-O segment `NODE_SEA` (`--macho-segment-name NODE_SEA`); the default `__POSTJECT` segment makes Node SEA crash before the loader runs.
- After injection, run ad-hoc signing for local dev and Developer ID signing for release.
- Validate the sidecar runs directly before Tauri packaging:

```bash
./core/dist/ensemble-core --version || true
./core/dist/ensemble-core
```

The sidecar should start the API server in standalone mode unless `ENSEMBLE_AUTO_PORT=1` is set.

## Tauri macOS Packaging

`src-tauri/tauri.conf.json` already includes:

```json
"bundle": {
  "targets": "all",
  "externalBin": ["binaries/ensemble-core"],
  "resources": {
    "../desktop-ui/static-out": "./web",
    "../core/dist/tokenizer-data": "./tokenizer-data"
  }
}
```

Confirm on macOS:

- `bundle.externalBin` resolves the correct target-triple sidecar.
- Resource paths are present inside `Ensemble.app`.
- `icon.icns` renders correctly.
- The frameless window behavior matches Windows.

Expected build commands:

```bash
pnpm install
pnpm -F @ensemble/core typecheck
pnpm -F @ensemble/core test
pnpm -F @ensemble/desktop-ui build
pnpm desktop:build
```

On macOS, `pnpm desktop:build` builds the `.app` bundle first and then creates a DMG through
`scripts/macos-dmg.mjs`. This avoids the Finder AppleScript step in Tauri's default `create-dmg`
path, which is fragile in sandboxed or headless build environments. The script still signs the
bundled sidecar and app bundle before creating the DMG; use `ENSEMBLE_CODESIGN_IDENTITY` or
`APPLE_SIGNING_IDENTITY` for Developer ID signing, otherwise it uses ad-hoc signing for local builds.

For Apple Silicon release:

```bash
TAURI_TARGET_TRIPLE=aarch64-apple-darwin pnpm desktop:build
```

For Intel release:

```bash
TAURI_TARGET_TRIPLE=x86_64-apple-darwin pnpm desktop:build
```

When cross-building Intel on Apple Silicon or Apple Silicon on Intel, set `ENSEMBLE_NODE_BIN` to an
official Node binary for the target architecture so the staged sidecar matches the Tauri target.
`scripts/desktop-build.mjs` passes `TAURI_TARGET_TRIPLE` through to `tauri build --target`.

Universal builds are optional for first release. If required, build both targets and combine app binaries using Tauri-supported universal packaging or a controlled `lipo` workflow.

## Signing And Notarization

Release builds must be signed and notarized.

Required Apple assets:

- Developer ID Application certificate.
- Team ID.
- App-specific password or App Store Connect API key for notarization.

Validation checklist:

```bash
codesign --verify --deep --strict --verbose=2 /path/to/Ensemble.app
spctl --assess --type execute --verbose /path/to/Ensemble.app
```

Notarization checklist:

```bash
xcrun notarytool submit /path/to/Ensemble.dmg --keychain-profile <profile> --wait
xcrun stapler staple /path/to/Ensemble.dmg
xcrun stapler validate /path/to/Ensemble.dmg
```

The sidecar must be signed as part of the app bundle. If Gatekeeper blocks the sidecar, the app will open but never reach `sidecar ready`.

## Shell And CLI Discovery

Windows often finds CLI binaries through `%PATH%`. macOS GUI apps launched from Finder do not inherit the user's interactive shell PATH.

This affects:

- `claude`
- `codex`
- `node`
- `npm`
- `npx`
- custom MCP stdio commands

Required behavior:

- Prefer explicit user-configured paths when present.
- Search common macOS locations:
  - `/opt/homebrew/bin`
  - `/usr/local/bin`
  - `/usr/bin`
  - `/bin`
  - `/opt/local/bin`
  - `~/.local/bin`
  - `~/.npm-global/bin`
- For Codex installed by npm, find the real native binary, not just the shell shim.
- For Claude local, resolve the user-installed CLI path the same way Windows does.

Mac engineer should verify `core/src/cli-config.ts` handles GUI PATH limitations. If it does not, patch there rather than adding platform hacks in each runtime.

## Provider Parity

All provider kinds must behave the same as Windows:

- `anthropic-local`: local Claude Code CLI login.
- `anthropic`: Anthropic-compatible HTTP provider.
- `openai-local`: official OpenAI API.
- `openai-compat`: OpenAI-compatible HTTP provider.
- `openai-codex`: local Codex CLI / ChatGPT login.

Codex-specific current contract:

- Uses local `codex` CLI.
- Uses `~/.codex/auth.json`.
- Does not accept `baseUrl` or `apiKey`.
- Defaults to `danger-full-access` for MCP compatibility in Windows `0.0.14`.
- Agent-level sandbox override still works.
- Changing sandbox must clear native Codex resume state so next turn starts a fresh Codex session.
- `peer_send` / `peer_query` are exposed through the packaged stdio MCP bridge.

macOS must preserve this, including packaged sidecar child launch:

```text
Ensemble.app sidecar -> ensemble-core codex-stdio-mcp
```

The packaged stdio MCP child must receive the encrypted blob key equivalent. This was a previous Windows bug; verify on macOS.

## Peer Messaging Acceptance Criteria

The following must pass on macOS before release:

1. Claude agent can call `peer_send`.
2. OpenAI official/API agent can call `peer_send`.
3. OpenAI-compatible agent can call `peer_send`.
4. Codex agent can call `peer_send`.
5. `peer_query` returns recent text history without running the target agent.
6. A busy target returns a clear error.
7. Closed target returns a clear error.
8. Target agent receives the message as a new user turn.
9. Source agent receives a delivery status or tool result.
10. Target provider failure does not erase delivery; delivery means the message was persisted and queued.

Run or port the existing smoke:

```bash
node node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs core/scripts/codex-peer-smoke.ts
```

If shell glob expansion is inconvenient, use the exact installed `tsx` path from `node_modules/.pnpm`.

Expected success markers:

```text
mcp__agentorch-internal-*__peer_send
/api/mcp/internal-tool/<agentId>/peer_send
delivered=true
codex result={"finalText":"done"}
```

## Resume And Sandbox Behavior

Important invariant:

`codex exec resume` cannot apply new `--sandbox` or `--cd`.

Therefore:

- Changing `codexWorkspace` must clear `lastSessionId`.
- Changing agent `sandboxMode` must clear `lastSessionId`.
- Changing provider `defaultSandbox` must clear `lastSessionId` for agents that inherit provider sandbox.
- It should not delete message history.
- It should not require `/clear`.
- The next user message starts a fresh native Codex session using the new sandbox.

This is the intended solution. Do not implement "apply then clear then codex resume"; resume is the part that prevents sandbox changes from applying.

## UI/UX Parity Checklist

Mac UI must match Windows behavior:

- Frameless window opens only after sidecar is ready.
- Initial window size: `1280x800`; minimum `800x600`.
- Sidebar tree, provider panel, MCP panel, skills panel, and chat panes render identically.
- Settings dialog is draggable and not clipped.
- Provider edit/new flows match Windows.
- Codex provider form shows sandbox selector and Codex login hints.
- Agent settings hides permission mode for Codex and shows sandbox mode instead.
- `/help`, `/model`, `/provider`, `/mcp`, `/skills`, `/status`, `/clear`, `/compact`, `/cost` behave the same.
- Input history with arrow keys behaves the same.
- No text overlaps at `800x600`, `1280x800`, and a common MacBook retina viewport.

Native macOS expectations:

- App name is `Ensemble`.
- Menu bar does not expose debug-only commands in release.
- Cmd+Q quits cleanly.
- Closing the window should match Windows product decision. If Windows keeps tray/background behavior, macOS must either match or document an intentional platform difference.
- External website links only open allowed Ensemble domains.

## Local MCP And Skills

MCP server configuration is stored in SQLite and must remain cross-platform.

For stdio MCP commands on macOS:

- Validate shell/PATH behavior from GUI launch.
- Do not assume `.cmd` suffix.
- Preserve `env` entries.
- If command is `npx`, resolve it using expanded PATH or explicit location.

Skills search paths must remain:

1. `<agent.codexWorkspace>/.claude/skills/<name>/SKILL.md`
2. `<DATA_DIR>/skills/<name>/SKILL.md`
3. `~/.claude/skills/<name>/SKILL.md`
4. `~/.codex/skills/<name>/SKILL.md`

Verify macOS path casing and permissions do not break skill scanning.

## Telemetry And Update Parity

The macOS app should report:

- platform: `macos` or the current shared enum value
- app version
- anonymous device id
- update check result

Do not reuse Windows installer filenames in macOS manifests.

Recommended release assets:

```text
Ensemble_0.0.xx_aarch64.dmg
Ensemble_0.0.xx_x64.dmg
```

If using one universal DMG:

```text
Ensemble_0.0.xx_universal.dmg
```

Update manifest is now platform-aware (0.0.18+). The wire format carries BOTH the legacy single-asset triple (read by ≤ 0.0.17 clients, treated as the Windows installer) AND an optional `platforms` map for per-OS / per-arch installers:

```json
{
  "version": "0.0.18",
  "publishedAt": "2026-05-18T06:33:57Z",
  "downloadUrl": "https://ensemble-ai.cn/download/releases/Ensemble_0.0.18_x64-setup.exe",
  "sha256": "...",
  "sizeBytes": ...,
  "platforms": {
    "windows-x64": { "downloadUrl": "...", "sha256": "...", "sizeBytes": ... },
    "macos-arm64": { "downloadUrl": "...", "sha256": "...", "sizeBytes": ... },
    "macos-x64":   { "downloadUrl": "...", "sha256": "...", "sizeBytes": ... }
  },
  "releaseNotes": "...",
  "mandatory": false,
  "minSupportedVersion": "0.0.1"
}
```

Clients (≥ 0.0.18) call `detectPlatformKey()` → look up `platforms[<key>]`. If `platforms` is present but no entry matches the client's platform, the update prompt is **suppressed entirely** — the user does NOT see a "click to download" button pointing at the wrong OS. If `platforms` is absent (manifest is from before 0.0.18), the client falls back to the top-level `downloadUrl`.

Validation: server-side `ManifestStore.validate()` enforces both shapes. A typo'd `sha256` or non-https URL in any platform asset rejects the whole manifest load, leaving the previous good manifest in place. See `ensemble_server/src/__tests__/manifest.test.ts` for the regression coverage.

**First macOS DMG publishing flow** (done from a Mac after `pnpm desktop:build:mac`):

```bash
# 1) Build (on Mac)
pnpm desktop:build:mac
# → src-tauri/target/.../bundle/dmg/Ensemble_0.0.X_aarch64.dmg

# 2) Hash + size
shasum -a 256 src-tauri/target/.../bundle/dmg/Ensemble_0.0.X_aarch64.dmg
stat -f %z  src-tauri/target/.../bundle/dmg/Ensemble_0.0.X_aarch64.dmg

# 3) Upload to download server
scp -i .../tencent_cloud_key.pem ...aarch64.dmg \
    ubuntu@43.156.94.143:/tmp/Ensemble_0.0.X_aarch64.dmg
ssh ... 'sudo install -m 644 -o www-data -g www-data \
         /tmp/Ensemble_0.0.X_aarch64.dmg \
         /var/www/ensemble-dl/download/releases/'

# 4) Edit manifest.json on server — ADD `platforms.macos-arm64` entry,
#    do NOT touch the top-level downloadUrl (that stays Windows for legacy clients).

# 5) Restart so the manifest watcher picks up the new file
ssh ... 'sudo systemctl restart ensemble-server'
```

CORS already configured for the manifest endpoint (`Access-Control-Allow-Origin: *` on `/v1/`) — works for `tauri://localhost` and `http://tauri.localhost` webview origins without extra client config.

## Release Gate

A macOS build is release-ready only after all of these pass:

```bash
pnpm -F @ensemble/core typecheck
pnpm -F @ensemble/core test
pnpm -F @ensemble/desktop-ui build
pnpm desktop:build
```

Manual smoke:

- Launch by double-clicking `Ensemble.app`, not only from terminal.
- App reaches main UI.
- Providers load.
- Create one agent for each provider kind available on the machine.
- Send a basic message.
- Run `peer_send` from Claude/OpenAI/OpenAI-compatible.
- Run `peer_send` from Codex.
- Change Codex sandbox from `workspace-write` to `danger-full-access`; verify next turn uses fresh session without `/clear`.
- Add a stdio MCP server using `npx`; verify tool discovery.
- Restart app; verify data persists.
- Reboot machine or log out/in; verify app still launches.
- Run Gatekeeper validation on the signed artifact.

## Known Risks To Watch

- macOS GUI PATH differs from terminal PATH.
- SEA postject can invalidate signatures; always sign after injection.
- Gatekeeper may block unsigned sidecars even if the main app is signed.
- Codex CLI can affect external Codex CLI sessions because vendor state is shared by ChatGPT account.
- Codex MCP behavior is vendor-controlled; keep the Codex peer smoke as a release gate.
- `danger-full-access` is the compatibility default for Codex, but it gives the Codex process broad local access. UI/docs must continue to label it clearly.
- Apple notarization may reject suspicious binary injection if signing order or entitlements are wrong.

## Engineering Rule

When macOS needs a platform-specific fix, isolate it in:

- path/build scripts,
- Tauri config,
- CLI discovery,
- signing/notarization pipeline,
- OS integration code.

Do not fork business logic, provider logic, peer messaging, SQLite schema, or frontend behavior by platform unless there is a documented product decision.
