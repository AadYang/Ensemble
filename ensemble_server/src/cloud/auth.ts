import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

const PASSWORD_PREFIX = "scrypt:v1";
const KEY_LEN = 32;

export interface FixedAccountConfig {
  email: string;
  password: string;
  displayName?: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const key = scryptSync(password, salt, KEY_LEN).toString("hex");
  return `${PASSWORD_PREFIX}:${salt}:${key}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== PASSWORD_PREFIX) return false;
  const [, , salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const got = Buffer.from(scryptSync(password, salt, KEY_LEN).toString("hex"), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseFixedAccounts(raw = process.env.ENSEMBLE_BETA_ACCOUNTS ?? ""): FixedAccountConfig[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const e = entry as Record<string, unknown>;
        if (typeof e.email !== "string" || typeof e.password !== "string") return null;
        return {
          email: normalizeEmail(e.email),
          password: e.password,
          ...(typeof e.displayName === "string" ? { displayName: e.displayName } : {}),
        };
      })
      .filter((entry): entry is FixedAccountConfig => entry !== null);
  }
  return trimmed
    .split(/[;\n]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [email, password, displayName] = line.split(":");
      if (!email || !password) return null;
      return {
        email: normalizeEmail(email),
        password,
        ...(displayName ? { displayName } : {}),
      };
    })
    .filter((entry): entry is FixedAccountConfig => entry !== null);
}

export function fixedAccountMatches(
  fixedAccounts: FixedAccountConfig[],
  email: string,
  password: string,
): FixedAccountConfig | null {
  const normalized = normalizeEmail(email);
  return fixedAccounts.find((entry) => entry.email === normalized && entry.password === password) ?? null;
}

export function inviteCodeMatches(input: string | undefined, expected = process.env.ENSEMBLE_BETA_INVITE_CODE ?? ""): boolean {
  if (!input || !expected) return false;
  const got = Buffer.from(input.trim(), "utf8");
  const want = Buffer.from(expected.trim(), "utf8");
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}
