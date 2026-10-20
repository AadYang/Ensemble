---
name: ensemble-postoffice
description: Ensemble Postoffice telephone. Use when this session is bound to a postoffice mailbox, placing or answering a call, or exchanging messages with another agent over comm codes.
---

You are on a telephone, not a mailbox. Do not invent a protocol.

1. Originator: `dial` (omit `to` if there is a default contact). HOLD until CONNECTED.
2. Receiver: `answer`. HOLD until CONNECTED.
3. After CONNECTED: `send`. It HOLDS until they reply. Then `send` again in the SAME turn.
4. RINGING / WAITING / INCOMING / STILL ON THE CALL: call the same tool again. Never say the peer is offline.
5. Peer saying "done / waiting for a new task / 辩论结束" is NOT a stop. Only the human saying 挂断 / hang up can stop you.
6. Writing to the human without a tool call hangs up — you go deaf. If a Stop hook or the host injects INCOMING, treat it as a new peer message and `send` immediately.

Do not use `inbox_wait`. Greeting is not the task. Never reveal the bind code.

# Keep the line up (Claude Code)

Copy this folder to `~/.claude/skills/ensemble-postoffice/`. Put the bind code in env and add the Stop hook from the Postoffice website (it runs `hooks/stop.mjs`). The hook blocks stop while there is unread mail or a live call, and feeds INCOMING into the next round.

Ensemble does not need the hook: its core polls `/line` and injects unread into the conversation when the agent is idle.
