// SQLite storage (node:sqlite). One file, one writer: this server.
//
// Every tenant-owned row carries workspace_id, and every query that reads or
// writes tenant data filters on it. That filter is the tenant boundary; there
// is no row-level security underneath it, so a query without it is a data leak.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Each entry runs once, in order. PRAGMA user_version records how many ran.
// Never edit a shipped entry; add a new one.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   TEXT NOT NULL REFERENCES users(id),
    status     TEXT NOT NULL DEFAULT 'active',          -- active | suspended
    created_at TEXT NOT NULL
  );

  CREATE TABLE members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'owner',         -- owner | member
    PRIMARY KEY (workspace_id, user_id)
  );

  -- Browser sessions. The cookie holds the raw token; only its hash is stored.
  CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    expires_at   TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  -- Customer API keys for the metered model gateway (/v1). Hash only; the
  -- prefix is kept so the customer can tell keys apart.
  CREATE TABLE api_keys (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    last_used_at TEXT,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL
  );

  -- The money. Append-only: a balance is SUM(amount_micros). Amounts are in
  -- millionths of a US dollar so rounding never drifts. Grants are positive,
  -- usage is negative. Never UPDATE or DELETE a row; correct with a new one.
  CREATE TABLE ledger (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,                          -- free_grant | purchase | admin_grant | usage | refund
    amount_micros INTEGER NOT NULL,
    usage_id     TEXT,
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL
  );
  CREATE INDEX ledger_ws ON ledger(workspace_id);

  -- One row per model call: what it cost us and what we charged.
  CREATE TABLE usage (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source         TEXT NOT NULL,                        -- chat | builder | page_ai | api
    source_ref     TEXT,                                 -- chat id, request id, page id, api key id
    model          TEXT NOT NULL,
    input_tokens   INTEGER NOT NULL,
    output_tokens  INTEGER NOT NULL,
    cost_micros    INTEGER NOT NULL,                     -- what the provider charges us
    charge_micros  INTEGER NOT NULL,                     -- what we charge the customer
    created_at     TEXT NOT NULL
  );
  CREATE INDEX usage_ws ON usage(workspace_id, created_at);

  -- The secretary's queue, as in Jeremy's Desk, scoped to a workspace.
  CREATE TABLE items (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'open',           -- open | waiting | done
    priority     INTEGER NOT NULL DEFAULT 3,             -- 1 urgent .. 4 low
    due_at       TEXT,
    next_action  TEXT NOT NULL DEFAULT '',
    created_by   TEXT NOT NULL DEFAULT 'user',           -- user | agent | page:<id>
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX items_ws ON items(workspace_id, status);

  -- Custom pages: AI-written code, run in a sandbox. The page row is the
  -- identity; its code lives in page_versions so every change can be reviewed
  -- and rolled back. live_version is what the dashboard runs, and only an
  -- approval by a person moves it.
  CREATE TABLE pages (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    slug         TEXT NOT NULL,
    title        TEXT NOT NULL,
    icon         TEXT NOT NULL DEFAULT '',
    live_version INTEGER,
    status       TEXT NOT NULL DEFAULT 'draft',           -- draft | live | disabled
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE (workspace_id, slug)
  );

  CREATE TABLE page_versions (
    page_id      TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    html         TEXT NOT NULL,
    permissions  TEXT NOT NULL DEFAULT '[]',              -- JSON array of capability names
    summary      TEXT NOT NULL DEFAULT '',                -- what changed, written by the builder
    request_id   TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',         -- pending | approved | rejected
    approved_by  TEXT,
    approved_at  TEXT,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (page_id, version)
  );

  -- A page's own storage. namespace 'live' is real; 'preview' is what a draft
  -- writes while someone reviews it, so a preview can't touch real data.
  CREATE TABLE page_data (
    page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    namespace  TEXT NOT NULL DEFAULT 'live',
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (page_id, namespace, key)
  );

  CREATE TABLE feature_requests (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id),
    text         TEXT NOT NULL,
    page_id      TEXT REFERENCES pages(id) ON DELETE SET NULL,  -- set for "change this page"
    status       TEXT NOT NULL DEFAULT 'queued',          -- queued | building | review | done | failed | rejected
    result       TEXT NOT NULL DEFAULT '',                -- builder's note, or the error
    cost_micros  INTEGER NOT NULL DEFAULT 0,              -- what the build charged
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE chat_messages (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL,                           -- user | assistant | tool
    content      TEXT NOT NULL,                           -- JSON of the provider message
    created_at   TEXT NOT NULL
  );
  CREATE INDEX chat_ws ON chat_messages(workspace_id, user_id, seq);
  `,
];

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

export const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/** Runs fn in a transaction. node:sqlite has no helper for it. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
