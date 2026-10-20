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
  mode: string;
  body: string;
  createdAt: number;
  files: { id: string; filename: string; mime: string; bytes: number }[];
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
  }> {
    const now = Date.now();
    const rows = this.db
      .prepare(
        "SELECT id, name, commCode, createdAt, lastSeenAt, boundSessionId FROM Mailbox WHERE userId = ? ORDER BY createdAt DESC",
      )
      .all(userId) as Array<
      Pick<MailboxRow, "id" | "name" | "commCode" | "createdAt" | "lastSeenAt" | "boundSessionId">
    >;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      commCode: r.commCode,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      bound: !!(r.boundSessionId && r.lastSeenAt && now - r.lastSeenAt < BIND_STALE_MS),
    }));
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

  whoami(box: MailboxRow): { commCode: string; name: string; unread: number } {
    const unread = (
      this.db.prepare("SELECT COUNT(*) AS c FROM Message WHERE toId = ? AND readAt IS NULL").get(box.id) as {
        c: number;
      }
    ).c;
    return { commCode: box.commCode, name: box.name, unread };
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
