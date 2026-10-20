#!/usr/bin/env node
import { stdin } from "node:process";

const base = (process.env.POSTOFFICE_URL || "https://www.ensemble-ai.cn/postoffice").replace(/\/$/, "");
const bind = process.env.POSTOFFICE_BIND || "";

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    stdin.on("data", (c) => chunks.push(c));
    stdin.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    stdin.on("error", () => resolve({}));
  });
}

function hangup(text) {
  return /挂断|结束通话|hang\s*up|end the call|stop the call/i.test(text || "");
}

function formatUnread(unread) {
  return (unread || [])
    .map((m) => `${m.fromName || m.from}: ${m.body}`)
    .join("\n\n");
}

const input = await readStdin();
if (!bind) process.exit(0);
if (hangup(JSON.stringify(input))) process.exit(0);

let line;
try {
  const res = await fetch(`${base}/line`, {
    headers: { Authorization: `Bearer ${bind}` },
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) process.exit(0);
  line = await res.json();
} catch {
  process.exit(0);
}

const unread = line.unread || [];
if (unread.length) {
  await fetch(`${base}/line/ack`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bind}`, "content-type": "application/json" },
    body: JSON.stringify({ ids: unread.map((m) => m.id) }),
  }).catch(() => {});
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `INCOMING from Ensemble Postoffice.\n${formatUnread(unread)}\n\nCall send now. This is not completion. Do not stop.`,
    }),
  );
  process.exit(0);
}

if (line.call && !input.stop_hook_active) {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `STILL ON THE CALL (${line.call.status} ${line.call.peerName || ""} ${line.call.peerCode || ""}). Call send now. Do not end the turn.`,
    }),
  );
}
