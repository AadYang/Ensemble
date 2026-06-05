; W18: kill the ensemble-core sidecar before NSIS overwrites files.
;
; Tauri's default installer template runs CheckIfAppIsRunning on the main
; binary only (ensemble.exe). When users upgrade with Ensemble still open,
; NSIS hard-kills the Tauri shell — that doesn't give Rust's
; WindowEvent::CloseRequested / RunEvent::Exit handlers a chance to run, so
; the child sidecar `ensemble-core.exe` is orphaned and keeps an exclusive
; lock on its own EXE file, blocking the File overwrite step downstream.
;
; This hook fires at NSIS_HOOK_PREINSTALL (before the main-binary check and
; before File copies) and at NSIS_HOOK_PREUNINSTALL (before the file-delete
; loop). taskkill /T walks the process tree so any spawned claude CLI child
; goes with it. /F is force-terminate. Exit code 128 means "process not
; found" — silently fine — so we discard $0 unconditionally. Sleep 500 ms
; gives Windows time to release handles on the killed EXE before NSIS tries
; to overwrite it.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Terminating any running ensemble-core sidecar..."
  nsExec::Exec 'taskkill /F /IM ensemble-core.exe /T'
  Pop $0
  ; W20: codex CLI subprocess (spawned by @openai/codex-sdk for openai-codex
  ; providers). taskkill /T on ensemble-core should reach it via process tree
  ; but an active codex turn at upgrade time can race the parent's death and
  ; outlive the tree walk. Belt-and-braces kill any orphaned codex.exe too.
  nsExec::Exec 'taskkill /F /IM codex.exe /T'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Terminating any running ensemble-core sidecar..."
  nsExec::Exec 'taskkill /F /IM ensemble-core.exe /T'
  Pop $0
  ; W20: codex CLI subprocess (spawned by @openai/codex-sdk for openai-codex
  ; providers). taskkill /T on ensemble-core should reach it via process tree
  ; but an active codex turn at upgrade time can race the parent's death and
  ; outlive the tree walk. Belt-and-braces kill any orphaned codex.exe too.
  nsExec::Exec 'taskkill /F /IM codex.exe /T'
  Pop $0
  Sleep 500
!macroend
