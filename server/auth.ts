// Accounts, sessions and customer API keys.
//
// Passwords: scrypt with a per-user salt. Sessions: a random token in an
// HttpOnly, SameSite=Lax cookie; the db stores only its SHA-256, so a leaked
// db can't be replayed as logins. State-changing API calls also need the
// X-Deskwork header, which a cross-site form post can't set.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { type DB, newId, now, tx } from "./db.ts";
import { grant } from "./billing.ts";
import type { Config } from "./config.ts";

const SESSION_DAYS = 30;
export const SESSION_COOKIE = "dw_session";

export interface Account {
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  role: string;
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: Account;
      apiKeyId?: string;
    }
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = scryptSync(password, Buffer.from(salt, "base64"), want.length);
  return timingSafeEqual(want, got);
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A new user with their own workspace and the free starting credits. */
export function signup(db: DB, cfg: Config, input: { email: string; password: string; name?: string }): { userId: string; workspaceId: string } {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("That email address doesn't look right.");
  if (input.password.length < 10) throw new AuthError("Use a password of at least 10 characters.");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new AuthError("An account with that email already exists.", 409);
  const userId = newId("usr");
  const workspaceId = newId("ws");
  const at = now();
  tx(db, () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, email, input.name?.trim() ?? "", hashPassword(input.password), at);
    db.prepare("INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)")
      .run(workspaceId, input.name?.trim() ? `${input.name.trim()}'s desk` : "My desk", userId, at);
    db.prepare("INSERT INTO members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(workspaceId, userId);
    if (cfg.freeCreditsMicros > 0) grant(db, workspaceId, "free_grant", cfg.freeCreditsMicros, "Welcome credits");
  });
  return { userId, workspaceId };
}

export function login(db: DB, email: string, password: string): { userId: string; workspaceId: string } {
  const user = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email.trim().toLowerCase()) as
    | { id: string; password_hash: string }
    | undefined;
  // Hash anyway on a miss, so response time doesn't reveal which emails exist.
  const ok = user ? checkPassword(password, user.password_hash) : (checkPassword(password, "scrypt$AAAA$AAAA"), false);
  if (!user || !ok) throw new AuthError("Wrong email or password.", 401);
  const ws = db.prepare("SELECT workspace_id FROM members WHERE user_id = ? ORDER BY rowid LIMIT 1").get(user.id) as { workspace_id: string };
  return { userId: user.id, workspaceId: ws.workspace_id };
}

export function createSession(db: DB, userId: string, workspaceId: string): string {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, workspace_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(sha256(token), userId, workspaceId, expires, now());
  return token;
}

export function endSession(db: DB, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function accountForSession(db: DB, cfg: Config, token: string): Account | null {
  const row = db.prepare(`
    SELECT u.id AS user_id, u.email, u.name, s.workspace_id, m.role, w.status
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN members m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now()) as
    | { user_id: string; email: string; name: string; workspace_id: string; role: string; status: string }
    | undefined;
  if (!row || row.status !== "active") return null;
  return {
    userId: row.user_id, email: row.email, name: row.name, workspaceId: row.workspace_id, role: row.role,
    isAdmin: cfg.adminEmails.includes(row.email.toLowerCase()),
  };
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}

/** Middleware: a signed-in browser. Mutations must also carry X-Deskwork: 1. */
export function requireSession(db: DB, cfg: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    const account = token ? accountForSession(db, cfg, token) : null;
    if (!account) return void res.status(401).json({ error: "Sign in first." });
    if (req.method !== "GET" && req.method !== "HEAD" && req.get("X-Deskwork") !== "1") {
      return void res.status(403).json({ error: "Missing X-Deskwork header." });
    }
    req.account = account;
    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.account?.isAdmin) return void res.status(403).json({ error: "Admins only." });
  next();
}

// ---- Customer API keys ----------------------------------------------------

export function createApiKey(db: DB, workspaceId: string, name: string): { id: string; key: string; prefix: string } {
  const key = `dw_live_${randomBytes(24).toString("base64url")}`;
  const id = newId("key");
  const prefix = key.slice(0, 12);
  db.prepare("INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, workspaceId, name.trim() || "API key", prefix, sha256(key), now());
  return { id, key, prefix };
}

export function listApiKeys(db: DB, workspaceId: string) {
  return db.prepare("SELECT id, name, prefix, last_used_at, revoked_at, created_at FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC")
    .all(workspaceId);
}

export function revokeApiKey(db: DB, workspaceId: string, id: string): boolean {
  return db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL")
    .run(now(), id, workspaceId).changes > 0;
}

/** Middleware for /v1: Authorization: Bearer dw_live_... */
export function requireApiKey(db: DB) {
  return (req: Request, res: Response, next: NextFunction) => {
    const m = /^Bearer\s+(dw_live_\S+)$/.exec(req.get("Authorization") ?? "");
    const row = m
      ? (db.prepare(`SELECT k.id, k.workspace_id FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
                     WHERE k.key_hash = ? AND k.revoked_at IS NULL AND w.status = 'active'`).get(sha256(m[1])) as
          | { id: string; workspace_id: string }
          | undefined)
      : undefined;
    if (!row) return void res.status(401).json({ error: { message: "Invalid API key.", type: "invalid_request_error" } });
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), row.id);
    req.apiKeyId = row.id;
    req.account = { userId: "", email: "", name: "", workspaceId: row.workspace_id, role: "api", isAdmin: false };
    next();
  };
}
