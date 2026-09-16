// Constructing the two kinds of artifact mark a turn can write.
//
// A mark is what lets a reading be attributed to a turn: the judge in
// `run-plan.ts` either finds a mark that covers the artifact an event came
// from, or rejects the event. So the builders here are the other half of that
// contract, and they enforce the same rules the judge does — a session id that
// could not be a file name is refused at CONSTRUCTION, so an unusable mark is
// never written and never silently matches everything in a directory.
//
// The two shapes exist because the artifact does not always exist yet:
//
//   `file`         — resume. The rollout is already on disk, and its byte
//                    length at turn start is what proves which part of it is
//                    this turn's.
//   `session-file` — a fresh thread. The CLI creates the rollout during the
//                    turn and names it after the thread id, which we only
//                    learn from `thread.started`; the mark therefore names the
//                    directory and the session, not a path we could not know.

import { statSync } from "node:fs";
import type { ArtifactMark } from "./types.js";

/** A mark for a file we already know, taken from its CURRENT size. Null when
 *  the file cannot be measured — an unmeasurable artifact cannot be vouched
 *  for, and a mark with a fabricated size would vouch for the wrong bytes. */
export function fileMark(path: string): ArtifactMark | null {
  try {
    const size = statSync(path).size;
    return { kind: "file", path, size };
  } catch {
    return null;
  }
}

/** A mark for a file the runtime is about to create, named after its session.
 *
 *  An empty or separator-bearing session id identifies no artifact — the judge
 *  refuses such a mark, so it is refused here: a mark that covers nothing is
 *  better than one that covers everything. */
export function sessionFileMark(directory: string, sessionId: string): ArtifactMark | null {
  const id = sessionId.trim();
  if (id.length === 0) return null;
  if (id.includes("/") || id.includes("\\")) return null;
  return { kind: "session-file", directory, sessionId: id };
}
