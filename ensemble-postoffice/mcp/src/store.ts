import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BIND_STALE_MS,
  FILE_TTL_MS,
  MAX_BODY_CHARS,
  MAX_FILE_BYTES,
  MAX_MAILBOXES,
  SESSION_DAYS,
} from "./config.js";

const COMM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type MailboxRow = {
  id: string;
  userId: string;
  name: string;
  commCode: string;
  bindHash: string;
  createdAt: number;
  lastSeenAt: number | null;
  boundSessionId: string | null;
};

export type MessageRow = {
  id: string;
  fromId: string;
  toId: string;
  mode: string;
  body: string;
  createdAt: number;
  readAt: number | null;
};

export type FileRow = {
  id: string;
  messageId: string;
  filename: string;
  mime: string;
  byteSize: number;
  expiresAt: number;
};

export type InboxItem = {
  id: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  mode: string;
  body: string;
  createdAt: number;
  files: { id: string; filename: string; mime: string; bytes: number }[];
};

export type ContactView = {
  commCode: string;
  name: string;
  alias: string;
  isDefault: boolean;
  source: "saved" | "account" | "thread";
};

export type CallStatus = "ringing" | "incoming" | "waiting" | "connected";

export type CallView = {
  status: CallStatus;
  peerName: string;
  peerCode: string;
  at: number;
};

type CallWaiter = {
  fromId: string;
  toId: string;
  resolve: (ok: boolean) => void;
};

function hashBind(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), 32);
  const expected = Buffer.from(hashHex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function randomComm(): string {
  let out = "";
  const bytes = randomBytes(8);
  for (let i = 0; i < 8; i++) out += COMM_ALPHABET[bytes[i]! % COMM_ALPHABET.length];
  return out;
}

export class Store {
  readonly db: DatabaseSync;
  readonly filesDir: string;
  readonly inviteCode: string;
  private readonly waiters = new Map<string, Set<(items: InboxItem[]) => void>>();
  private readonly callWaiters = new Map<string, Set<CallWaiter>>();
  private readonly answerWaiters = new Map<string, Set<() => void>>();
  private readonly callState = new Map<string, CallView & { peerId: string }>();
  private readonly onLine = new Set<string>();

  constructor(dbPath: string, filesDir: string, inviteCode: string) {
    this.filesDir = filesDir;
    this.inviteCode = inviteCode;
    mkdirSync(filesDir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 2000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS User (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        passwordHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS Session (
        token TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS Mailbox (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        commCode TEXT NOT NULL UNIQUE,
        bindHash TEXT NOT NULL UNIQUE,
        createdAt INTEGER NOT NULL,
        lastSeenAt INTEGER,
        boundSessionId TEXT
      );
      CREATE TABLE IF NOT EXISTS Message (
        id TEXT PRIMARY KEY,
        fromId TEXT NOT NULL REFERENCES Mailbox(id) ON DELETE CASCADE,
        toId TEXT NOT NULL REFERENCES Mailbox(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        body TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        readAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS msg_to_unread ON Message(toId, readAt, createdAt);
      CREATE INDEX IF NOT EXISTS msg_pair ON Message(fromId, toId, createdAt);
      CREATE TABLE IF NOT EXISTS FileBlob (
        id TEXT PRIMARY KEY,
        messageId TEXT NOT NULL REFERENCES Message(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        byteSize INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS Contact (
        mailboxId TEXT NOT NULL REFERENCES Mailbox(id) ON DELETE CASCADE,
        peerId TEXT NOT NULL REFERENCES Mailbox(id) ON DELETE CASCADE,
        alias TEXT NOT NULL DEFAULT '',
        isDefault INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (mailboxId, peerId)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  register(username: string, password: string, inviteCode: string): { id: string; username: string } {
    if (inviteCode.trim() !== this.inviteCode) throw Object.assign(new Error("邀请码无效"), { status: 403 });
    const name = username.trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,32}$/.test(name)) {
      throw Object.assign(new Error("用户名须为 3–32 位字母数字或 _-"), { status: 400 });
    }
    if (password.length < 8 || password.length > 128) {
      throw Object.assign(new Error("密码须为 8–128 位"), { status: 400 });
    }
    const existing = this.db.prepare("SELECT id FROM User WHERE username = ?").get(name);
    if (existing) throw Object.assign(new Error("用户名已被占用"), { status: 409 });
    const id = randomUUID();
    this.db.prepare("INSERT INTO User (id, username, passwordHash, createdAt) VALUES (?, ?, ?, ?)").run(
      id,
      name,
      hashPassword(password),
      Date.now(),
    );
    return { id, username: name };
  }

  login(username: string, password: string): { token: string; username: string } {
    const row = this.db
      .prepare("SELECT id, username, passwordHash FROM User WHERE username = ?")
      .get(username.trim().toLowerCase()) as
      | { id: string; username: string; passwordHash: string }
      | undefined;
    if (!row || !verifyPassword(password, row.passwordHash)) {
      throw Object.assign(new Error("用户名或密码错误"), { status: 401 });
    }
    const token = randomBytes(24).toString("hex");
    const now = Date.now();
    this.db.prepare("INSERT INTO Session (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)").run(
      token,
      row.id,
      now,
      now + SESSION_DAYS * 86400_000,
    );
    return { token, username: row.username };
  }

  logout(token: string): void {
    this.db.prepare("DELETE FROM Session WHERE token = ?").run(token);
  }

  userByToken(token: string | undefined): { id: string; username: string } | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.username FROM Session s JOIN User u ON u.id = s.userId
         WHERE s.token = ? AND s.expiresAt > ?`,
      )
      .get(token, Date.now()) as { id: string; username: string } | undefined;
    return row ?? null;
  }

  listMailboxes(userId: string): Array<{
    id: string;
    name: string;
    commCode: string;
    createdAt: number;
    bound: boolean;
    lastSeenAt: number | null;
    unread: number;
    listening: boolean;
    call: CallView | null;
  }> {
    const now = Date.now();
    const rows = this.db
      .prepare(
        "SELECT id, name, commCode, createdAt, lastSeenAt, boundSessionId FROM Mailbox WHERE userId = ? ORDER BY createdAt DESC",
      )
      .all(userId) as Array<
      Pick<MailboxRow, "id" | "name" | "commCode" | "createdAt" | "lastSeenAt" | "boundSessionId">
    >;
    return rows.map((r) => {
      const unread = (
        this.db.prepare("SELECT COUNT(*) AS c FROM Message WHERE toId = ? AND readAt IS NULL").get(r.id) as {
          c: number;
        }
      ).c;
      return {
        id: r.id,
        name: r.name,
        commCode: r.commCode,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        bound: !!(r.boundSessionId && r.lastSeenAt && now - r.lastSeenAt < BIND_STALE_MS),
        unread,
        listening: this.isListening(r.id),
        call: this.callView(r.id),
      };
    });
  }

  createMailbox(userId: string, name: string): { id: string; name: string; commCode: string; bindCode: string } {
    const n = name.trim().slice(0, 40);
    if (!n) throw Object.assign(new Error("请填写信箱名称"), { status: 400 });
    const count = (
      this.db.prepare("SELECT COUNT(*) AS c FROM Mailbox WHERE userId = ?").get(userId) as { c: number }
    ).c;
    if (count >= MAX_MAILBOXES) throw Object.assign(new Error(`每账号最多 ${MAX_MAILBOXES} 只信箱`), { status: 400 });
    const id = randomUUID();
    const bindCode = `po_${randomBytes(24).toString("hex")}`;
    let comm = randomComm();
    for (let i = 0; i < 8; i++) {
      const clash = this.db.prepare("SELECT id FROM Mailbox WHERE commCode = ?").get(comm);
      if (!clash) break;
      comm = randomComm();
    }
    this.db
      .prepare(
        "INSERT INTO Mailbox (id, userId, name, commCode, bindHash, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, userId, n, comm, hashBind(bindCode), Date.now());
    return { id, name: n, commCode: comm, bindCode };
  }

  resetBind(userId: string, mailboxId: string): { bindCode: string } {
    const box = this.mailbox(mailboxId);
    if (!box || box.userId !== userId) throw Object.assign(new Error("信箱不存在"), { status: 404 });
    const bindCode = `po_${randomBytes(24).toString("hex")}`;
    this.db
      .prepare("UPDATE Mailbox SET bindHash = ?, boundSessionId = NULL, lastSeenAt = NULL WHERE id = ?")
      .run(hashBind(bindCode), mailboxId);
    return { bindCode };
  }

  deleteMailbox(userId: string, mailboxId: string): void {
    const box = this.mailbox(mailboxId);
    if (!box || box.userId !== userId) throw Object.assign(new Error("信箱不存在"), { status: 404 });
    this.db.prepare("DELETE FROM Mailbox WHERE id = ?").run(mailboxId);
  }

  mailbox(id: string): MailboxRow | undefined {
    return this.db.prepare("SELECT * FROM Mailbox WHERE id = ?").get(id) as MailboxRow | undefined;
  }

  mailboxByComm(code: string): MailboxRow | undefined {
    return this.db.prepare("SELECT * FROM Mailbox WHERE commCode = ?").get(code.trim().toUpperCase()) as
      | MailboxRow
      | undefined;
  }

  mailboxByBind(code: string): MailboxRow | undefined {
    return this.db.prepare("SELECT * FROM Mailbox WHERE bindHash = ?").get(hashBind(code)) as
      | MailboxRow
      | undefined;
  }

  bindSession(bindCode: string, sessionId: string): MailboxRow {
    const box = this.mailboxByBind(bindCode);
    if (!box) throw Object.assign(new Error("绑定码无效"), { status: 401 });
    const now = Date.now();
    this.db
      .prepare("UPDATE Mailbox SET boundSessionId = ?, lastSeenAt = ? WHERE id = ?")
      .run(sessionId, now, box.id);
    return { ...box, boundSessionId: sessionId, lastSeenAt: now };
  }

  heartbeat(mailboxId: string, sessionId: string): void {
    this.db
      .prepare("UPDATE Mailbox SET lastSeenAt = ?, boundSessionId = ? WHERE id = ?")
      .run(Date.now(), sessionId, mailboxId);
  }

  send(fromId: string, toComm: string, body: string, mode: string): InboxItem {
    const { id, toId } = this.insertMessage(fromId, toComm, body, mode);
    this.rememberPeer(fromId, toId);
    this.notify(toId);
    return this.hydrate([this.message(id)!])[0]!;
  }

  sendFile(
    fromId: string,
    toComm: string,
    filename: string,
    data: Buffer,
    mime: string,
    message: string,
  ): InboxItem {
    if (data.length === 0) throw Object.assign(new Error("文件为空"), { status: 400 });
    if (data.length > MAX_FILE_BYTES) {
      throw Object.assign(new Error(`附件不能超过 ${MAX_FILE_BYTES} 字节`), { status: 400 });
    }
    const safeName = filename.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180) || "file.bin";
    const { id: messageId, toId } = this.insertMessage(
      fromId,
      toComm,
      message.trim() || `[file] ${safeName}`,
      "message",
    );
    const fileId = randomUUID();
    writeFileSync(join(this.filesDir, fileId), data);
    this.db
      .prepare(
        "INSERT INTO FileBlob (id, messageId, filename, mime, byteSize, expiresAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        fileId,
        messageId,
        safeName,
        mime.slice(0, 120) || "application/octet-stream",
        data.length,
        Date.now() + FILE_TTL_MS,
      );
    this.rememberPeer(fromId, toId);
    this.notify(toId);
    return this.hydrate([this.message(messageId)!])[0]!;
  }

  getFile(mailboxId: string, fileId: string): { filename: string; mime: string; data: Buffer } {
    const row = this.db
      .prepare(
        `SELECT f.id, f.filename, f.mime, f.expiresAt, m.fromId, m.toId
         FROM FileBlob f JOIN Message m ON m.id = f.messageId WHERE f.id = ?`,
      )
      .get(fileId) as
      | { id: string; filename: string; mime: string; expiresAt: number; fromId: string; toId: string }
      | undefined;
    if (!row) throw Object.assign(new Error("文件不存在"), { status: 404 });
    if (row.fromId !== mailboxId && row.toId !== mailboxId) {
      throw Object.assign(new Error("无权读取该文件"), { status: 403 });
    }
    if (row.expiresAt < Date.now()) throw Object.assign(new Error("文件已过期"), { status: 410 });
    const path = join(this.filesDir, row.id);
    if (!existsSync(path)) throw Object.assign(new Error("文件已丢失"), { status: 404 });
    return { filename: row.filename, mime: row.mime, data: readFileSync(path) };
  }

  unread(mailboxId: string): InboxItem[] {
    const rows = this.db
      .prepare("SELECT * FROM Message WHERE toId = ? AND readAt IS NULL ORDER BY createdAt ASC")
      .all(mailboxId) as MessageRow[];
    return this.hydrate(rows);
  }

  markRead(ids: string[], mailboxId: string): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare("UPDATE Message SET readAt = ? WHERE id = ? AND toId = ? AND readAt IS NULL");
    for (const id of ids) stmt.run(now, id, mailboxId);
  }

  query(mailboxId: string, otherComm: string, limit: number): InboxItem[] {
    const other = this.mailboxByComm(otherComm);
    if (!other) throw Object.assign(new Error(`找不到通讯码 ${otherComm}`), { status: 404 });
    const n = Math.min(50, Math.max(1, limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM Message
         WHERE (fromId = ? AND toId = ?) OR (fromId = ? AND toId = ?)
         ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(mailboxId, other.id, other.id, mailboxId, n) as MessageRow[];
    return this.hydrate(rows.reverse());
  }

  thread(mailboxId: string, limit = 50): InboxItem[] {
    const n = Math.min(100, Math.max(1, limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM Message WHERE fromId = ? OR toId = ? ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(mailboxId, mailboxId, n) as MessageRow[];
    return this.hydrate(rows.reverse());
  }

  contacts(mailboxId: string): ContactView[] {
    const box = this.mailbox(mailboxId);
    if (!box) throw Object.assign(new Error("信箱不存在"), { status: 404 });
    const byId = new Map<string, ContactView & { peerId: string }>();

    const siblings = this.db
      .prepare("SELECT id, name, commCode FROM Mailbox WHERE userId = ? AND id != ?")
      .all(box.userId, box.id) as Array<{ id: string; name: string; commCode: string }>;
    for (const s of siblings) {
      byId.set(s.id, {
        peerId: s.id,
        commCode: s.commCode,
        name: s.name,
        alias: "",
        isDefault: false,
        source: "account",
      });
    }

    const peers = this.db
      .prepare(
        `SELECT m.id, m.name, m.commCode FROM Mailbox m
         WHERE m.id IN (
           SELECT toId FROM Message WHERE fromId = ?
           UNION
           SELECT fromId FROM Message WHERE toId = ?
         ) AND m.id != ?`,
      )
      .all(mailboxId, mailboxId, mailboxId) as Array<{ id: string; name: string; commCode: string }>;
    for (const p of peers) {
      if (!byId.has(p.id)) {
        byId.set(p.id, {
          peerId: p.id,
          commCode: p.commCode,
          name: p.name,
          alias: "",
          isDefault: false,
          source: "thread",
        });
      }
    }

    const saved = this.db
      .prepare(
        `SELECT c.peerId, c.alias, c.isDefault, m.name, m.commCode
         FROM Contact c JOIN Mailbox m ON m.id = c.peerId WHERE c.mailboxId = ?`,
      )
      .all(mailboxId) as Array<{
      peerId: string;
      alias: string;
      isDefault: number;
      name: string;
      commCode: string;
    }>;
    for (const s of saved) {
      byId.set(s.peerId, {
        peerId: s.peerId,
        commCode: s.commCode,
        name: s.name,
        alias: s.alias,
        isDefault: s.isDefault === 1,
        source: "saved",
      });
    }

    const list = [...byId.values()];
    if (!list.some((c) => c.isDefault) && list.length === 1) list[0]!.isDefault = true;
    return list
      .sort((a, b) => a.name.localeCompare(b.name) || a.commCode.localeCompare(b.commCode))
      .map(({ peerId: _peerId, ...row }) => row);
  }

  resolveRecipient(mailboxId: string, hint: string): string {
    const q = hint.trim();
    const list = this.contacts(mailboxId);
    if (!q) {
      const d = list.find((c) => c.isDefault);
      if (d) return d.commCode;
      if (list.length === 0) {
        throw Object.assign(new Error("没有联系人。在网站添加通讯码，或 dial/send 时传入 to"), { status: 400 });
      }
      const names = list.map((c) => `${c.name} ${c.commCode}`).join("；");
      throw Object.assign(new Error(`有多个联系人，请指定 to（通讯码 / 别名 / 名称）：${names}`), { status: 400 });
    }
    const upper = q.toUpperCase();
    const byCode = list.find((c) => c.commCode === upper);
    if (byCode) return byCode.commCode;
    const direct = this.mailboxByComm(upper);
    if (direct && direct.id !== mailboxId) return direct.commCode;

    const lower = q.toLowerCase();
    const byAlias = list.filter((c) => c.alias && c.alias.toLowerCase() === lower);
    if (byAlias.length === 1) return byAlias[0]!.commCode;
    if (byAlias.length > 1) throw Object.assign(new Error(`别名 ${q} 对应多个联系人，请用通讯码`), { status: 400 });
    const byName = list.filter((c) => c.name.toLowerCase() === lower);
    if (byName.length === 1) return byName[0]!.commCode;
    if (byName.length > 1) throw Object.assign(new Error(`名称 ${q} 对应多个联系人，请用通讯码`), { status: 400 });
    throw Object.assign(new Error(`找不到联系人 ${q}`), { status: 404 });
  }

  addContact(mailboxId: string, commCode: string, alias = "", makeDefault = false): ContactView {
    const peer = this.mailboxByComm(commCode);
    if (!peer) throw Object.assign(new Error(`找不到通讯码 ${commCode.trim().toUpperCase()}`), { status: 404 });
    if (peer.id === mailboxId) throw Object.assign(new Error("不能添加自己"), { status: 400 });
    const label = alias.trim().slice(0, 40);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO Contact (mailboxId, peerId, alias, isDefault, createdAt) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(mailboxId, peerId) DO UPDATE SET alias = excluded.alias`,
      )
      .run(mailboxId, peer.id, label, now);
    if (makeDefault || !this.contacts(mailboxId).some((c) => c.isDefault)) this.setDefault(mailboxId, peer.commCode);
    return this.contacts(mailboxId).find((c) => c.commCode === peer.commCode)!;
  }

  removeContact(mailboxId: string, commCode: string): void {
    const peer = this.mailboxByComm(commCode);
    if (!peer) throw Object.assign(new Error("联系人不存在"), { status: 404 });
    const info = this.db.prepare("DELETE FROM Contact WHERE mailboxId = ? AND peerId = ?").run(mailboxId, peer.id);
    if (info.changes === 0) throw Object.assign(new Error("联系人不存在"), { status: 404 });
  }

  setDefault(mailboxId: string, commCode: string): ContactView {
    const peer = this.mailboxByComm(commCode);
    if (!peer || peer.id === mailboxId) throw Object.assign(new Error("联系人不存在"), { status: 404 });
    this.db.prepare("UPDATE Contact SET isDefault = 0 WHERE mailboxId = ?").run(mailboxId);
    this.db
      .prepare(
        `INSERT INTO Contact (mailboxId, peerId, alias, isDefault, createdAt) VALUES (?, ?, '', 1, ?)
         ON CONFLICT(mailboxId, peerId) DO UPDATE SET isDefault = 1`,
      )
      .run(mailboxId, peer.id, Date.now());
    return this.contacts(mailboxId).find((c) => c.commCode === peer.commCode)!;
  }

  private markCall(
    mailboxId: string,
    peerId: string,
    peer: { commCode: string; name: string },
    status: CallStatus,
  ): void {
    this.callState.set(mailboxId, {
      peerId,
      status,
      peerName: peer.name,
      peerCode: peer.commCode,
      at: Date.now(),
    });
  }

  enterLine(mailboxId: string): void {
    this.onLine.add(mailboxId);
    this.nudgeCallersOf(mailboxId);
  }

  leaveLine(mailboxId: string): void {
    this.onLine.delete(mailboxId);
  }

  private isListening(mailboxId: string): boolean {
    return (
      (this.waiters.get(mailboxId)?.size ?? 0) > 0 ||
      this.onLine.has(mailboxId) ||
      (this.answerWaiters.get(mailboxId)?.size ?? 0) > 0
    );
  }

  findCallerOf(mailboxId: string): MailboxRow | null {
    const seen = this.callState.get(mailboxId);
    if (seen?.status === "incoming" && seen.peerId) {
      const row = this.mailbox(seen.peerId);
      if (row) return row;
    }
    for (const [fromId, set] of this.callWaiters) {
      for (const w of set) {
        if (w.toId === mailboxId) {
          const row = this.mailbox(fromId);
          if (row) return row;
        }
      }
    }
    for (const [id, state] of this.callState) {
      if (id !== mailboxId && state.peerId === mailboxId && state.status === "ringing") {
        const row = this.mailbox(id);
        if (row) return row;
      }
    }
    return null;
  }

  private wakeAnswerers(mailboxId: string): void {
    const set = this.answerWaiters.get(mailboxId);
    if (!set) return;
    for (const fn of [...set]) fn();
  }

  private peerWaitingFor(fromId: string, toId: string): boolean {
    const theirs = this.callWaiters.get(toId);
    if (!theirs) return false;
    for (const w of theirs) if (w.toId === fromId) return true;
    return false;
  }

  private peerAtPhone(fromId: string, toId: string): boolean {
    return this.isListening(toId) || this.peerWaitingFor(fromId, toId);
  }

  private wakeCallers(a: string, b: string): void {
    const wake = (fromId: string, toId: string) => {
      const set = this.callWaiters.get(fromId);
      if (!set) return;
      for (const w of [...set]) if (w.toId === toId) w.resolve(true);
    };
    wake(a, b);
    wake(b, a);
  }

  private nudgeCallersOf(mailboxId: string): void {
    for (const set of this.callWaiters.values()) {
      for (const w of [...set]) if (w.toId === mailboxId) w.resolve(true);
    }
  }

  private rememberPeer(fromId: string, toId: string): void {
    const hadDefault = this.contacts(fromId).some((c) => c.isDefault);
    this.db
      .prepare(
        `INSERT INTO Contact (mailboxId, peerId, alias, isDefault, createdAt) VALUES (?, ?, '', ?, ?)
         ON CONFLICT(mailboxId, peerId) DO NOTHING`,
      )
      .run(fromId, toId, hadDefault ? 0 : 1, Date.now());
  }

  whoami(box: MailboxRow): {
    commCode: string;
    name: string;
    unread: number;
    contacts: ContactView[];
    defaultTo: string | null;
    call: CallView | null;
  } {
    const unread = (
      this.db.prepare("SELECT COUNT(*) AS c FROM Message WHERE toId = ? AND readAt IS NULL").get(box.id) as {
        c: number;
      }
    ).c;
    const contacts = this.contacts(box.id);
    return {
      commCode: box.commCode,
      name: box.name,
      unread,
      contacts,
      defaultTo: contacts.find((c) => c.isDefault)?.commCode ?? null,
      call: this.callView(box.id),
    };
  }

  callView(mailboxId: string): CallView | null {
    const row = this.callState.get(mailboxId);
    if (!row) return null;
    const { peerId: _peerId, ...view } = row;
    return view;
  }

  atPhone(mailboxId: string): boolean {
    return this.isListening(mailboxId);
  }

  connect(
    fromId: string,
    toComm: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ connected: boolean; timed_out: boolean; peer: { commCode: string; name: string } }> {
    const to = this.mailboxByComm(toComm);
    if (!to) throw Object.assign(new Error(`找不到通讯码 ${toComm}`), { status: 404 });
    if (to.id === fromId) throw Object.assign(new Error("不能呼叫自己"), { status: 400 });
    const from = this.mailbox(fromId);
    if (!from) throw Object.assign(new Error("信箱不存在"), { status: 404 });
    const peer = { commCode: to.commCode, name: to.name };
    const self = { commCode: from.commCode, name: from.name };

    const pickup = () => {
      this.markCall(fromId, to.id, peer, "connected");
      this.markCall(to.id, fromId, self, "connected");
    };

    if (this.peerAtPhone(fromId, to.id)) {
      this.wakeCallers(fromId, to.id);
      pickup();
      return Promise.resolve({ connected: true, timed_out: false, peer });
    }

    if (timeoutMs <= 0 || signal?.aborted) {
      return Promise.resolve({ connected: false, timed_out: true, peer });
    }

    this.markCall(fromId, to.id, peer, "ringing");
    const peerCall = this.callState.get(to.id);
    if (!peerCall || peerCall.status === "waiting" || peerCall.status === "incoming") {
      this.markCall(to.id, fromId, self, "incoming");
    }
    return new Promise((resolve) => {
      const bucket = this.callWaiters.get(fromId) ?? new Set<CallWaiter>();
      this.callWaiters.set(fromId, bucket);
      let settled = false;
      const waiter: CallWaiter = {
        fromId,
        toId: to.id,
        resolve: (ok) => finish(ok),
      };
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        bucket.delete(waiter);
        if (ok) pickup();
        else if (this.callState.get(fromId)?.status === "ringing") {
          this.callState.delete(fromId);
          const theirs = this.callState.get(to.id);
          if (theirs?.status === "incoming" && theirs.peerId === fromId) this.callState.delete(to.id);
        }
        resolve({ connected: ok, timed_out: !ok, peer });
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      bucket.add(waiter);
      this.wakeAnswerers(to.id);
      if (this.callState.get(fromId)?.status === "connected") {
        finish(true);
        return;
      }
      if (this.peerWaitingFor(fromId, to.id) || this.peerAtPhone(fromId, to.id)) {
        this.wakeCallers(fromId, to.id);
        if (!settled) finish(true);
      }
    });
  }

  answer(
    mailboxId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ connected: boolean; timed_out: boolean; peer: { commCode: string; name: string } | null }> {
    const existing = this.callState.get(mailboxId);
    if (existing?.status === "connected") {
      const peer = this.mailbox(existing.peerId);
      if (peer) {
        return Promise.resolve({
          connected: true,
          timed_out: false,
          peer: { commCode: peer.commCode, name: peer.name },
        });
      }
    }
    const callerNow = this.findCallerOf(mailboxId);
    if (callerNow) return this.connect(mailboxId, callerNow.commCode, Math.max(timeoutMs, 1), signal);
    if (timeoutMs <= 0 || signal?.aborted) {
      return Promise.resolve({ connected: false, timed_out: true, peer: null });
    }

    this.callState.set(mailboxId, {
      peerId: "",
      status: "waiting",
      peerName: "",
      peerCode: "",
      at: Date.now(),
    });
    return new Promise((resolve) => {
      const bucket = this.answerWaiters.get(mailboxId) ?? new Set<() => void>();
      this.answerWaiters.set(mailboxId, bucket);
      let settled = false;
      const finishMiss = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        bucket.delete(onRing);
        if (this.callState.get(mailboxId)?.status === "waiting") this.callState.delete(mailboxId);
        resolve({ connected: false, timed_out: true, peer: null });
      };
      const onRing = () => {
        if (settled) return;
        const caller = this.findCallerOf(mailboxId);
        if (!caller) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        bucket.delete(onRing);
        void this.connect(mailboxId, caller.commCode, Math.max(timeoutMs, 1), signal).then(resolve);
      };
      const onAbort = () => finishMiss();
      const timer = setTimeout(finishMiss, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      bucket.add(onRing);
      onRing();
    });
  }

  waitInbox(mailboxId: string, timeoutMs: number, signal?: AbortSignal): Promise<InboxItem[]> {
    const existing = this.unread(mailboxId);
    if (existing.length > 0) return Promise.resolve(existing);
    if (signal?.aborted) return Promise.resolve([]);
    return new Promise((resolve) => {
      const bucket = this.waiters.get(mailboxId) ?? new Set<(items: InboxItem[]) => void>();
      this.waiters.set(mailboxId, bucket);
      const finish = (items: InboxItem[]) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        bucket.delete(finish);
        resolve(items);
      };
      const onAbort = () => finish([]);
      const timer = setTimeout(() => finish([]), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      bucket.add(finish);
      this.nudgeCallersOf(mailboxId);
    });
  }

  sweepExpiredFiles(): number {
    const now = Date.now();
    const rows = this.db.prepare("SELECT id FROM FileBlob WHERE expiresAt < ?").all(now) as { id: string }[];
    for (const r of rows) {
      try {
        unlinkSync(join(this.filesDir, r.id));
      } catch {
        /* gone */
      }
    }
    this.db.prepare("DELETE FROM FileBlob WHERE expiresAt < ?").run(now);
    return rows.length;
  }

  private insertMessage(fromId: string, toComm: string, body: string, mode: string): { id: string; toId: string } {
    const to = this.mailboxByComm(toComm);
    if (!to) throw Object.assign(new Error(`找不到通讯码 ${toComm}`), { status: 404 });
    if (to.id === fromId) throw Object.assign(new Error("不能寄给自己"), { status: 400 });
    const text = body.trim();
    if (!text) throw Object.assign(new Error("message 不能为空"), { status: 400 });
    if (text.length > MAX_BODY_CHARS) throw Object.assign(new Error("正文过长"), { status: 400 });
    const m = mode === "task" ? "task" : "message";
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO Message (id, fromId, toId, mode, body, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, fromId, to.id, m, text, Date.now());
    return { id, toId: to.id };
  }

  private message(id: string): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM Message WHERE id = ?").get(id) as MessageRow | undefined;
  }

  private hydrate(rows: MessageRow[]): InboxItem[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const files = this.db
      .prepare(`SELECT * FROM FileBlob WHERE messageId IN (${placeholders})`)
      .all(...ids) as FileRow[];
    const byMsg = new Map<string, FileRow[]>();
    for (const f of files) {
      const list = byMsg.get(f.messageId) ?? [];
      list.push(f);
      byMsg.set(f.messageId, list);
    }
    const names = new Map<string, string>();
    const comms = new Map<string, string>();
    const boxIds = [...new Set(rows.flatMap((r) => [r.fromId, r.toId]))];
    for (const id of boxIds) {
      const b = this.mailbox(id);
      if (b) {
        names.set(id, b.name);
        comms.set(id, b.commCode);
      }
    }
    return rows.map((r) => ({
      id: r.id,
      from: comms.get(r.fromId) ?? r.fromId,
      fromName: names.get(r.fromId) ?? "",
      to: comms.get(r.toId) ?? r.toId,
      toName: names.get(r.toId) ?? "",
      mode: r.mode,
      body: r.body,
      createdAt: r.createdAt,
      files: (byMsg.get(r.id) ?? []).map((f) => ({
        id: f.id,
        filename: f.filename,
        mime: f.mime,
        bytes: f.byteSize,
      })),
    }));
  }

  private notify(toId: string): void {
    const bucket = this.waiters.get(toId);
    if (!bucket || bucket.size === 0) return;
    const items = this.unread(toId);
    if (items.length === 0) return;
    for (const fn of [...bucket]) fn(items);
  }
}
