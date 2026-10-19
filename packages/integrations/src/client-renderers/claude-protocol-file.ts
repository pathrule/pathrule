// SPDX-License-Identifier: Apache-2.0
// Claude Code's auto-loaded copy of the protocol, and its removal.
//
// `.claude/rules/pathrule-protocol.md` is written by four separate places (CLI
// cloud sync, CLI local sync, the desktop companion writer, the MCP post-write
// hook) and owned by no renderer, so the orphan sweep in `disk-writer.ts` never
// looks at it. That is exactly why turning signature mode on is not enough on its
// own: we stop WRITING the file, nothing removes it, and Claude Code keeps
// auto-loading a copy that drifts further from the protocol the hook injects with
// every release.
//
// So the file is REMOVED rather than left. Removing it is safe by construction:
// the filename is Pathrule's own invention, it can hold no user content, and the
// only thing that ever wrote it is us.
//
// Node-only. One function so all four writers agree; four copies of this
// condition is how one of them would keep writing the file forever.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { renderProtocolRulesFile } from "../pathrule-protocol.js";

/** Workspace-relative path of Claude Code's protocol copy. */
export const CLAUDE_PROTOCOL_FILE = ".claude/rules/pathrule-protocol.md";

export type ClaudeProtocolFileOutcome =
  /** The protocol is on disk, current. */
  | "written"
  /** Already byte-identical on disk — nothing was touched. */
  | "unchanged"
  /** Signature mode: the file existed and is gone. */
  | "removed"
  /** Signature mode: there was nothing to remove. */
  | "absent";

/**
 * Bring Claude Code's protocol copy in line with the channel decision.
 *
 * `signed` means claude-code is in signature mode for this workspace, i.e. the
 * hook delivers the protocol. Anything else keeps the file current.
 */
export async function syncClaudeProtocolFile(
  rootPath: string,
  opts: { signed: boolean },
): Promise<ClaudeProtocolFileOutcome> {
  const target = join(rootPath, CLAUDE_PROTOCOL_FILE);
  if (!opts.signed) {
    const body = renderProtocolRulesFile();
    // Rewriting an identical file is not free here, even though the bytes do not
    // change. This is a TURN-ZERO file: Claude Code loads `.claude/rules/*.md`
    // into the system prompt, so touching it mid-session is a change to the
    // cached prefix's source, and every sync ran this — measured on a real
    // checkout, the file's mtime moved during an active session with no content
    // change behind it. It also shows up as a modified file in the user's tree
    // for no reason, which is the complaint that started this work.
    //
    // Every other writer in this package already compares before writing
    // (disk-writer.ts: "file desired and on-disk content matches → skip"); this
    // one was the exception.
    try {
      if ((await readFile(target, "utf8")) === body) return "unchanged";
    } catch {
      // Missing or unreadable: fall through and write it.
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
    return "written";
  }
  try {
    await unlink(target);
    return "removed";
  } catch {
    // Already gone, or never there. Both are the desired end state, and a sync
    // must not fail because a file it wants absent is absent.
    return "absent";
  }
}
