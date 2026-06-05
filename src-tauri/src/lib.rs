use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    plugin::Builder as PluginBuilder,
    tray::TrayIconBuilder,
    Emitter, Manager, Runtime, RunEvent, WindowEvent,
};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// Generated at build time by core/scripts/encrypt-blob.mjs. Contains the
// XOR-scrambled AES key for decrypting the sidecar's SEA payload.
#[path = "blob_key.rs"]
mod blob_key;

/// Holds the running sidecar so we can kill it on app exit / window close.
struct SidecarHandle(Mutex<Option<CommandChild>>);

/// Last known sidecar HTTP port. This is a fallback for the rare macOS path
/// where the watchdog shows the bundled static UI before navigation succeeds.
struct SidecarPort(Mutex<Option<u16>>);

#[tauri::command]
fn get_sidecar_port(app: tauri::AppHandle, state: tauri::State<'_, SidecarPort>) -> Option<u16> {
    if let Some(port) = *state.0.lock().unwrap() {
        return Some(port);
    }
    let sentinel_path = app.path().app_data_dir().ok()?.join(".port");
    let text = std::fs::read_to_string(sentinel_path).ok()?;
    let port = text.trim().parse::<u16>().ok()?;
    *state.0.lock().unwrap() = Some(port);
    Some(port)
}

/// Namespace prefix for the device-id derivation. Versioned so future schema
/// changes (e.g., switching hash function or input shape) can rotate ids
/// deterministically without colliding with the v1 derivation.
const DEVICE_ID_NAMESPACE: &[u8] = b"ensemble:device-id:v1\0";

/// Return a stable, deterministic device id for this machine. Bound to the
/// OS install (Cryptography\MachineGuid / IOPlatformUUID / /etc/machine-id),
/// so reinstalling Ensemble yields the SAME id and copying the appdata
/// folder to another machine yields a DIFFERENT id. Falls back to a random
/// UUID cached at `device-id.txt` when machine_uid() fails (rare — corp
/// policy can hide the registry key).
fn derive_device_id(cache_path: &std::path::Path) -> String {
    if let Ok(machine_id) = machine_uid::get() {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(DEVICE_ID_NAMESPACE);
        hasher.update(machine_id.as_bytes());
        let digest = hasher.finalize();
        let mut bytes = [0u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        // Stamp the RFC 4122 version (5 = name-based) and variant bits so the
        // result is a well-formed UUID. The server's zod regex is case-
        // insensitive and doesn't enforce version, but staying compliant
        // keeps us interoperable with any future UUID-aware tooling.
        bytes[6] = (bytes[6] & 0x0f) | 0x50;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let id = uuid::Uuid::from_bytes(bytes).to_string();
        // Compare-and-write the cache so we don't churn the file's mtime on
        // every launch. If a previous 0.0.5 install left a random UUID in
        // device-id.txt, this overwrite rotates the user's identity exactly
        // once when they upgrade — by design.
        let needs_write = std::fs::read_to_string(cache_path)
            .map(|s| s.trim() != id)
            .unwrap_or(true);
        if needs_write {
            if let Err(err) = std::fs::write(cache_path, &id) {
                log::warn!("device-id cache write failed: {err}");
            } else {
                log::info!("device-id: derived from machine_uid (cached)");
            }
        }
        return id;
    }

    // machine_uid unavailable → fall back to old 0.0.5 behavior: read or
    // generate a random UUID. Log it so we know how often this branch hits.
    log::warn!("device-id: machine_uid unavailable, using random-UUID fallback");
    std::fs::read_to_string(cache_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let id = uuid::Uuid::new_v4().to_string();
            if let Err(err) = std::fs::write(cache_path, &id) {
                log::warn!("device-id.txt write failed: {err}");
            }
            id
        })
}

/// Plugin that gates webview navigation. Without this, a stray `<a href>` to
/// an API endpoint replaces the entire window with the raw JSON response
/// (white background, no close button, no way back) — the user-reported
/// "fullscreen 500 page" bug. Same applies to external http(s) URLs: the
/// shell.open allowlist already routes legitimate external links to the
/// system browser, so any in-webview navigation to a non-loopback host is
/// almost certainly a misclick we want to block.
fn ensemble_nav_guard<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    PluginBuilder::new("ensemble-nav-guard")
        .on_navigation(|_webview, url| {
            // Tauri-internal schemes (asset protocol, devtools, data URIs)
            // bypass any policy — they're never API endpoints.
            let scheme = url.scheme();
            if scheme == "tauri" || scheme == "about" || scheme == "data" || scheme == "blob" {
                return true;
            }
            // Anything that isn't http(s) (file:, custom:, …) — let Tauri's
            // own machinery handle it. Most don't appear in real navigations.
            if scheme != "http" && scheme != "https" {
                return true;
            }
            let host = url.host_str().unwrap_or("");
            let is_loopback = host == "127.0.0.1" || host == "localhost";
            if !is_loopback {
                log::warn!("nav-guard: blocked external navigation to {url}");
                return false;
            }
            // Same-origin to the sidecar: block API paths so they can't
            // replace the window. The SPA itself only ever navigates via
            // history.pushState (client-side router) which doesn't touch
            // these prefixes.
            let path = url.path();
            let is_api = path == "/v1"
                || path.starts_with("/v1/")
                || path == "/api"
                || path.starts_with("/api/")
                || path == "/healthz"
                || path == "/ws"
                || path.starts_with("/ws/")
                || path.starts_with("/download/");
            if is_api {
                log::warn!("nav-guard: blocked in-webview navigation to API path {path}");
                return false;
            }
            true
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance plugin MUST be registered first so its IPC pipe
        // (named on Windows / unix-socket on macOS+Linux) is set up before
        // any other plugin does work that depends on the app being unique.
        // The callback runs in the FIRST instance when a SECOND launch is
        // attempted — we bring the existing main window to the front and
        // discard the duplicate process.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::info!("single-instance: another launch attempted — refocusing main window");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(ensemble_nav_guard())
        .manage(SidecarHandle(Mutex::new(None)))
        .manage(SidecarPort(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![get_sidecar_port])
        .setup(|app| {
            // macOS: force Regular activation policy so the Dock icon shows
            // and the app activates on launch. Tauri 2 sometimes infers
            // Accessory mode when a TrayIcon is attached, which leaves the
            // app menu-bar-only and the main window stuck behind other apps
            // even after window.show() — visible to the user as "I clicked
            // the app and only a tray icon appeared" (the original macOS
            // bug). Regular is the safe default for a windowed desktop app
            // that happens to also have a tray.
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                let _ = app.set_activation_policy(ActivationPolicy::Regular);
            }

            // Log to BOTH stdout (visible in dev console) AND a rotating file
            // under appLogDir. In release builds without this, Rust log::info
            // and the sidecar's stderr passthrough vanish — making
            // production-only crashes (e.g. SDK CLI exit code 1) opaque.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("ensemble".into()),
                        }),
                    ])
                    .build(),
            )?;

            // Resolve the per-OS app data dir and pass it to the sidecar so its
            // SQLite + cache files land at e.g. %APPDATA%\Ensemble\.
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            let data_dir_str = data_dir.to_string_lossy().to_string();
            // Side-channel for the "sidecar is ready" signal. The sidecar
            // writes its bound port into DATA_DIR/.port after listen()
            // succeeds — Rust polls this as a backup for the stdout
            // ENSEMBLE_LISTENING announcement, which can be lost to Node
            // pipe buffering on macOS (the original "window never appears,
            // only tray icon" symptom). Clearing any stale file FIRST so a
            // previous-run port can't be mistaken for the current one.
            let port_sentinel_path = data_dir.join(".port");
            let _ = std::fs::remove_file(&port_sentinel_path);

            // Resolve the static frontend dir. In production it's bundled via
            // tauri.conf.json `bundle.resources` (resource_dir/web). In dev mode
            // (cargo run) Tauri's resource_dir doesn't include built resources,
            // so fall back to the workspace path desktop-ui/static-out.
            let web_root = if cfg!(debug_assertions) {
                let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                manifest_dir
                    .parent()
                    .map(|p| p.join("desktop-ui").join("static-out"))
                    .expect("CARGO_MANIFEST_DIR has no parent")
            } else {
                app.path()
                    .resource_dir()
                    .expect("resource_dir failed")
                    .join("web")
            };
            let web_root_str = web_root.to_string_lossy().to_string();

            // Tokenizer vocab dir. Same dual-mode resolution as web_root.
            // Vocab JSON files (cl100k_base.json / o200k_base.json) live
            // OUTSIDE the SEA blob — bundled here as Tauri resources so the
            // executable stays low-entropy and signature-clean. Without this
            // separation, embedding ~3 MB of high-entropy BPE merge tables
            // inside the stripped-signed node.exe triggers HEUR ransomware
            // false positives (Kaspersky's LockFile.g family, etc.).
            let tokenizer_dir = if cfg!(debug_assertions) {
                let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                manifest_dir
                    .parent()
                    .map(|p| p.join("core").join("dist").join("tokenizer-data"))
                    .expect("CARGO_MANIFEST_DIR has no parent")
            } else {
                app.path()
                    .resource_dir()
                    .expect("resource_dir failed")
                    .join("tokenizer-data")
            };
            let tokenizer_dir_str = tokenizer_dir.to_string_lossy().to_string();

            // Anonymous device id. Goal: SAME install → SAME id, even after
            // uninstall+reinstall; DIFFERENT machine → DIFFERENT id, even when
            // Windows roaming-profile syncs the appdata folder. We derive from
            // the OS-level machine GUID (Cryptography\MachineGuid on Win /
            // IOPlatformUUID on macOS / /etc/machine-id on Linux) hashed under
            // a namespace tag, then formatted as a UUIDv5-shape so the server
            // zod regex still validates. Cached to disk for fast path + as a
            // fallback for the rare case machine_uid() fails (corp policy,
            // unusual container). Not personally identifying.
            let device_id_path = data_dir.join("device-id.txt");
            let device_id = derive_device_id(&device_id_path);
            let platform = if cfg!(target_os = "windows") {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "linux"
            };
            let arch = if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            };
            let app_version = env!("CARGO_PKG_VERSION");

            // Spawn the bundled ensemble-core SEA exe. tauri-plugin-shell wires
            // it as a sidecar (registered in tauri.conf.json `bundle.externalBin`).
            // ENSEMBLE_AUTO_PORT=1 → core picks a free port and prints
            // `ENSEMBLE_LISTENING <port>` on stdout's first line.
            // Reassemble the SEA-blob decryption key at runtime (key is split
            // across two XOR-masked arrays in the Rust binary; see
            // core/scripts/encrypt-blob.mjs). Without this env var the sidecar
            // refuses to start — running ensemble-core.exe standalone yields
            // an immediate exit with no source code recoverable from disk.
            let blob_key = blob_key::blob_key_hex();
            let sidecar = app
                .shell()
                .sidecar("ensemble-core")
                .expect("failed to locate ensemble-core sidecar")
                .env("ENSEMBLE_AUTO_PORT", "1")
                .env("ENSEMBLE_BLOB_KEY", &blob_key)
                .env("AGENTORCH_DATA_DIR", &data_dir_str)
                .env("AGENTORCH_WEB_ROOT", &web_root_str)
                .env("AGENTORCH_TOKENIZER_DIR", &tokenizer_dir_str)
                .env("ENSEMBLE_DEVICE_ID", &device_id)
                .env("ENSEMBLE_PLATFORM", platform)
                .env("ENSEMBLE_ARCH", arch)
                .env("ENSEMBLE_APP_VERSION", app_version);

            let (mut rx, child) = sidecar.spawn().expect("failed to spawn ensemble-core");

            // Save the child so we can kill it on exit.
            app.state::<SidecarHandle>()
                .0
                .lock()
                .unwrap()
                .replace(child);

            // System tray: minimal Show / Quit menu. Per spinoff plan §10 q4
            // we don't minimize-to-tray — closing the window quits the app.
            // The tray is just for "click to bring window forward" + an
            // explicit Quit when the user wants it from the tray.
            let show_item = MenuItem::with_id(app, "show", "Show Ensemble", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Ensemble")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        if let Some(state) = app.try_state::<SidecarHandle>() {
                            if let Some(child) = state.0.lock().unwrap().take() {
                                let _ = child.kill();
                            }
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let app_handle = app.handle().clone();
            // Shared flag so the watchdog below can observe whether the
            // sidecar already announced itself before the deadline.
            let announced_state = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let announced_for_loop = announced_state.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let s = String::from_utf8_lossy(&line);
                            let trimmed = s.trim();
                            if !announced_for_loop.load(std::sync::atomic::Ordering::Acquire) {
                                if let Some(rest) = trimmed.strip_prefix("ENSEMBLE_LISTENING ") {
                                    if let Ok(port) = rest.trim().parse::<u16>() {
                                        announced_for_loop
                                            .store(true, std::sync::atomic::Ordering::Release);
                                        on_sidecar_ready(&app_handle, port);
                                        continue;
                                    }
                                }
                            }
                            log::info!("[ensemble-core stdout] {trimmed}");
                        }
                        CommandEvent::Stderr(line) => {
                            let s = String::from_utf8_lossy(&line);
                            log::info!("[ensemble-core] {}", s.trim_end());
                        }
                        CommandEvent::Error(err) => {
                            log::error!("[ensemble-core error] {err}");
                            let _ = app_handle.emit("sidecar-error", err);
                        }
                        CommandEvent::Terminated(payload) => {
                            log::warn!(
                                "[ensemble-core] terminated code={:?} signal={:?}",
                                payload.code,
                                payload.signal
                            );
                            let _ = app_handle.emit("sidecar-terminated", payload.code);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // Sentinel-file poller. The sidecar writes its bound port to
            // DATA_DIR/.port after listen() succeeds. This is a robust
            // side channel for the "sidecar is ready" signal — independent
            // of Node's stdout buffering, Tauri's shell plugin line
            // parsing, and macOS Gatekeeper output redirection. Polls
            // every 100ms for up to 120 seconds; whichever channel
            // (stdout/sentinel) reports the port first wins via the
            // shared announced_state CAS.
            let sentinel_handle = app.handle().clone();
            let sentinel_announced = announced_state.clone();
            let sentinel_path = port_sentinel_path.clone();
            tauri::async_runtime::spawn(async move {
                for _ in 0..1200 {
                    if sentinel_announced.load(std::sync::atomic::Ordering::Acquire) {
                        return;
                    }
                    if let Ok(bytes) = std::fs::read_to_string(&sentinel_path) {
                        let trimmed = bytes.trim();
                        if let Ok(port) = trimmed.parse::<u16>() {
                            // Race with the stdout reader — first one to
                            // flip the flag wins. If we lost, drop silently.
                            if !sentinel_announced.swap(true, std::sync::atomic::Ordering::AcqRel) {
                                log::info!(
                                    "[ensemble] sidecar ready via .port sentinel (port={port})"
                                );
                                on_sidecar_ready(&sentinel_handle, port);
                            }
                            return;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            });

            // Sidecar-startup watchdog. If the SEA child silently fails to
            // emit `ENSEMBLE_LISTENING <port>` AND fails to write the .port
            // sentinel — codesign issue on macOS, missing binary, permission
            // denied, sandbox eats the output, etc. — the main window
            // otherwise stays hidden forever (the user only sees the tray
            // icon, which is the original macOS bug). 12s after launch we
            // force the window to show with the bundled frontendDist
            // content; without a sidecar port the SPA can't connect to the
            // API, but at least the user sees feedback and a path to the
            // log file instead of a ghost app.
            let watchdog_handle = app.handle().clone();
            let watchdog_announced = announced_state.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(12)).await;
                if watchdog_announced.load(std::sync::atomic::Ordering::Acquire) {
                    return;
                }
                log::error!(
                    "[ensemble] sidecar did not announce ENSEMBLE_LISTENING within 12s — \
                    forcing main window visible so the user has feedback"
                );
                if let Some(window) = watchdog_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                // Notify the renderer too, for any pre-loaded SPA chunk that
                // wants to display a startup-failure banner.
                let _ = watchdog_handle.emit("sidecar-startup-timeout", ());
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // When the user closes the main window, kill the sidecar so the app
            // exits cleanly. Without this, the sidecar would orphan.
            if let WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    if let Some(state) = window.app_handle().try_state::<SidecarHandle>() {
                        if let Some(child) = state.0.lock().unwrap().take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Belt-and-suspenders: also clean up on app exit.
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<SidecarHandle>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}

/// Once we know the sidecar's port, navigate the (still-hidden) main window to
/// `http://127.0.0.1:<port>/` and reveal it.
fn on_sidecar_ready(app: &tauri::AppHandle, port: u16) {
    let url_str = format!("http://127.0.0.1:{port}/");
    log::info!("[ensemble] sidecar ready on port {port}, loading {url_str}");
    if let Some(state) = app.try_state::<SidecarPort>() {
        *state.0.lock().unwrap() = Some(port);
    }

    if let Some(window) = app.get_webview_window("main") {
        match url_str.parse::<tauri::Url>() {
            Ok(url) => {
                if let Err(e) = window.navigate(url) {
                    log::error!("window.navigate failed: {e}");
                }
            }
            Err(e) => log::error!("invalid sidecar URL: {e}"),
        }
        if let Err(e) = window.show() {
            log::error!("window.show failed: {e}");
        }
        if let Err(e) = window.set_focus() {
            log::error!("window.set_focus failed: {e}");
        }
        // macOS: window.show()/set_focus() alone don't reliably bring the
        // app to the foreground when launched cold from Finder/Dock — the
        // window often opens BEHIND other windows and the user only notices
        // the tray icon (the original "click to launch, only tray appears"
        // bug). Tauri 2's ActivationPolicy::Regular set in setup() helps
        // but isn't always enough; the unminimize() nudge + an explicit
        // second set_focus() on the main-thread event loop tick reliably
        // activate the app on the macOS builds we've tested.
        #[cfg(target_os = "macos")]
        {
            let _ = window.unminimize();
            let win = window.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = win.show();
                let _ = win.set_focus();
            });
        }
    } else {
        log::error!("main window not found at sidecar-ready time");
    }
}
