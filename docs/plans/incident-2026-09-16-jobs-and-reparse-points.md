# Incident 2026-09-16 — jobs that "failed", turns that "crashed", and reparse points

Three separate faults surfaced in one afternoon, and only the first was about the
feature we were building. They are written down together because the symptoms
looked like one thing ("job is broken", "model died") and because the second and
third will recur on any machine with the same OS policy.

## 1. Every turn ended with `RUNTIME_CONFIRMED_DEAD (code=0)`

**Symptom.** `error · RUNTIME_CONFIRMED_DEAD · the runtime's child process exited
(code=0, signal=n/a) without producing a result for this run` after every run,
even successful ones.

**Cause.** `evaluateLiveness` treated a raw child exit as death evidence. On
Claude the OS exit event can arrive *before* the SDK iterator yields its terminal
`result`, so a clean `exit(0)` was evaluated as "the process died without
producing a result" and the run — which was one event away from finishing — was
declared dead.

**Fix.** A raw exit is no longer a verdict (`core/src/capability/liveness.ts`).
The runtime classifies its own stream after draining it; `streamClosed(true)`
requires that the iterator *drained naturally*, no result arrived, no error was
captured, and nobody asked for the abort (`core/src/sessions/runtimes/claude.ts`).
A genuinely wedged stream with a dead child is still caught, by the bounded
health-check probe. Gate: `core/src/capability/__tests__/liveness.test.ts`
("does not terminate on a raw child exit before the stream is classified").

## 2. A job failure crashed the *agent turn* that started it

**Symptom.** `pnpm -r typecheck` finished with exit 2 (real failure, see §3);
immediately after, the agent's own turn died with
`error · RUNTIME_STREAM_CLOSED · the runtime's event stream closed abnormally
before this run produced a result`.

**Cause — a sequence race, not a job bug.** The terminal job notice was appended
to the transcript as a `Message`. The running turn holds its own local `seq`
cursor, so the notice took the sequence the turn was about to write, and the
turn's next payload hit `UNIQUE constraint failed: Message.agentId, Message.seq`.
The session consumer then threw, the generator's `finally` ran without draining,
and that was classified as an abnormal stream close — so a *database* error was
reported to the user as a *dead model*.

**Fix.** Three parts:
- A job that settles while its agent owns a turn is shown **live only**
  (`seq: -1`, no transcript row). The durable `Job.transcriptNotifiedAt` marker
  keeps it pending instead of lost (`SessionManager.notifyJobSettled`).
- When the run releases the cursor, `flushSettledJobNotices` appends the notice
  once, inside one transaction with the marker claim, on a sequence computed in
  that same transaction (`persistJobSettledNotice`).
- Persistence failures are their own structured ending
  (`MESSAGE_PERSISTENCE_FAILED`, state `interrupted`) instead of borrowing
  `RUNTIME_STREAM_CLOSED`.

Gate: `core/src/sessions/__tests__/liveness-wiring.test.ts` ("a job that settles
mid-turn does not steal the turn's sequence") — it asserts the notice is absent
during the run, still delivered live, present exactly once afterwards, and that
no sequence in the transcript repeats.

## 3. `pnpm` could not read its own workspace links (host-level, not ours)

**Symptom.** `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` with
`UNKNOWN: unknown error, open '…\core\node_modules\@agentorch\shared\package.json'`.
`shared`'s `typecheck` failed with `TS2307: Cannot find module 'vitest'`, and
`core`'s with a wall of cascading type errors because `@agentorch/shared` did not
resolve.

**Cause.** This Windows host refuses to follow **untrusted reparse points** —
globally. Verified cross-process, not inferred:

| probe | result |
| --- | --- |
| junction created by `cmd /c mklink /J`, read by the same process | fails |
| junction created by `node` `symlinkSync(…, "junction")`, read by `node` | fails (`UNKNOWN`) |
| junction created here, read by a WMI-spawned `cmd` (non-descendant, SYSTEM) | fails: "the mount point is not trusted" |
| system-wide exploit-protection mitigations | all `NOTSET` |
| a *freshly* created `pnpm dlx` cache link, read by the same context that created it | works (this is the one combination that does) |
| `fsutil reparsepoint query` | a normal mount point, correctly formed |

So pnpm's default workspace linking is unusable here: the link is created, then
cannot be read — by pnpm itself, by `tsc`, or by any child process we spawn. The
fix is not in Ensemble, and not in pnpm: this repo must not depend on reparse
points.

**Fix.**
- `.npmrc`: `node-linker=hoisted` + `inject-workspace-packages=true`, so
  third-party packages are materialised as real directories at the root and
  workspace dependencies are copied rather than linked.
- `scripts/fix-workspace-links.mjs` (`pnpm deps:repair`, also root
  `postinstall`): replaces any workspace link that cannot be read through with a
  real copy, derived from `package.json` rather than a hardcoded list, and
  idempotent — on a healthy machine it reports "readable" and does nothing.
- `pnpm install` must not be assumed to self-heal: it fails while trying to read
  the link it just made. Run `pnpm deps:repair` after it.

**Other consequences of the same host policy.** Any tool that resolves modules
through a junction will fail the same way, so a repository keeping the default
pnpm layout cannot be typechecked or tested through Ensemble on this machine. The
job logs, in this case, were correct and complete — the failure predated the job.

## What this incident says about the design

- The job primitive did its job: real exit code, real log, real terminal state.
  What was broken was how a *finished* job hands its news to a *running* turn.
- Liveness must never form a verdict from an event that the runtime itself is
  about to explain.
- A crash whose message names the wrong subsystem is worse than a plain failure:
  both faults here reported "the model died" when the model was fine.
