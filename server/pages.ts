// Custom pages: dashboard sections the AI writes for a customer.
//
// The security model, layer by layer (docs/security.md has the reasoning):
//  1. The code runs in an iframe served by /frame/... with a CSP header that
//     includes `sandbox allow-scripts allow-forms`. No allow-same-origin, so
//     the frame has an opaque origin: no cookies, no localStorage, no reading
//     the dashboard, no same-origin API calls.
//  2. The same CSP sets connect-src/img-src/etc. to 'none' or data:, so the
//     code can't fetch, beacon, or load anything from the network.
//  3. Its only way to do anything is the postMessage bridge. The dashboard
//     forwards bridge calls to POST /api/pages/:id/bridge, and THIS file decides
//     them, against the permissions of the version a person approved. The
//     browser side is a convenience, never the check.
//  4. Capabilities are few and narrow: the page's own storage, the queue
//     (read or write), and metered AI with a daily cap. No network, no email,
//     no other pages' data.
//  5. Nothing runs live until a person approves that exact version and its
//     permission list. Drafts run in preview, with throwaway storage and no
//     writes to real data.
//  6. A lint pass rejects obviously hostile code. It's a tripwire for prompt
//     injection, not the boundary; layers 1-3 are.
import { type DB, newId, now, tx } from "./db.ts";
import type { Config } from "./config.ts";
import { pageAiSpentToday, PaymentRequired } from "./billing.ts";
import { meteredComplete, type Provider } from "./llm.ts";

export const PERMISSIONS = {
  "items:read": "Read the tasks on your desk",
  "items:write": "Add tasks and mark them done",
  ai: "Ask the AI questions (charged to your credits, capped per day)",
} as const;
export type Permission = keyof typeof PERMISSIONS;

export const LIMITS = {
  htmlBytes: 200_000,
  storageKeys: 200,
  storageValueBytes: 64_000,
  storageTotalBytes: 1_000_000,
  pagesPerWorkspace: 30,
  bridgeCallsPerMinute: 120,
  aiPromptChars: 8_000,
  aiMaxTokens: 800,
};

export class PageError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---- Lint ------------------------------------------------------------------

const BANNED: [RegExp, string][] = [
  [/<script[^>]*\bsrc\s*=/i, "external scripts (<script src>)"],
  [/<(link|iframe|frame|object|embed|base|meta|portal)\b/i, "<link>, <iframe>, <object>, <embed>, <base> and <meta> tags"],
  [/\b(location|document\.domain|document\.cookie|localStorage|sessionStorage|indexedDB)\b/, "location, cookies, and browser storage (use desk.storage)"],
  [/\b(top|parent|opener)\s*[.[]/, "top, parent and opener (use the desk object)"],
  [/\bwindow\s*\.\s*open\b|\bwindow\s*\[/, "window.open and window[...] lookups"],
  [/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|Worker|SharedWorker)\b/, "network calls and workers (pages have no network)"],
  [/\b(eval|Function)\s*\(|\bimport\s*\(/, "eval, new Function and dynamic import"],
  [/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i, "URLs (pages can't load anything from the network)"],
  [/\bpostMessage\b/, "postMessage (use the desk object)"],
  [/\\u00?[0-9a-f]{2,4}|\\x[0-9a-f]{2}|\batob\b|String\.fromCharCode/i, "escaped or encoded strings, which hide what code does"],
];

/** Problems with a page's code, as sentences a model can act on. Empty = ok. */
export function lintPage(html: string): string[] {
  const problems: string[] = [];
  if (Buffer.byteLength(html, "utf8") > LIMITS.htmlBytes) problems.push(`The page is over ${LIMITS.htmlBytes / 1000} KB.`);
  for (const [re, what] of BANNED) if (re.test(html)) problems.push(`Pages may not use ${what}.`);
  return problems;
}

export function checkPermissions(list: unknown): Permission[] {
  if (!Array.isArray(list)) throw new PageError("permissions must be a list.");
  const out = new Set<Permission>();
  for (const p of list) {
    if (!(p in PERMISSIONS)) throw new PageError(`Unknown permission "${p}". Allowed: ${Object.keys(PERMISSIONS).join(", ")}.`);
    out.add(p as Permission);
  }
  return [...out].sort();
}

// ---- Pages and versions -------------------------------------------------------

export interface PageRow {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  icon: string;
  live_version: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  page_id: string;
  version: number;
  html: string;
  permissions: string;
  summary: string;
  request_id: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

export function getPage(db: DB, workspaceId: string, pageId: string): PageRow {
  const page = db.prepare("SELECT * FROM pages WHERE id = ? AND workspace_id = ?").get(pageId, workspaceId) as PageRow | undefined;
  if (!page) throw new PageError("No such page.", 404);
  return page;
}

export function getVersion(db: DB, workspaceId: string, pageId: string, version: number): VersionRow {
  getPage(db, workspaceId, pageId);
  const v = db.prepare("SELECT * FROM page_versions WHERE page_id = ? AND version = ?").get(pageId, version) as VersionRow | undefined;
  if (!v) throw new PageError("No such version.", 404);
  return v;
}

export function listPages(db: DB, workspaceId: string) {
  return db.prepare(`
    SELECT p.id, p.slug, p.title, p.icon, p.status, p.live_version, p.updated_at,
      (SELECT MAX(version) FROM page_versions v WHERE v.page_id = p.id AND v.status = 'pending') AS pending_version
    FROM pages p WHERE p.workspace_id = ? ORDER BY p.title`).all(workspaceId);
}

export function listVersions(db: DB, workspaceId: string, pageId: string) {
  getPage(db, workspaceId, pageId);
  return db.prepare(`SELECT version, permissions, summary, request_id, status, approved_at, created_at
                     FROM page_versions WHERE page_id = ? ORDER BY version DESC`).all(pageId);
}

export interface SavePageInput {
  page_id?: string;
  slug?: string;
  title: string;
  icon?: string;
  permissions: unknown;
  html: string;
  summary?: string;
  request_id?: string;
}

/** Saves code as a new pending version. Never changes what's live. */
export function savePageDraft(db: DB, workspaceId: string, input: SavePageInput): { page_id: string; version: number } {
  const problems = lintPage(input.html);
  if (problems.length) throw new PageError(`The page was not saved. ${problems.join(" ")}`);
  const permissions = checkPermissions(input.permissions);
  const title = String(input.title ?? "").trim().slice(0, 60);
  if (!title) throw new PageError("A page needs a title.");
  const at = now();
  return tx(db, () => {
    let pageId = input.page_id;
    if (pageId) {
      getPage(db, workspaceId, pageId);
      db.prepare("UPDATE pages SET title = ?, icon = ?, updated_at = ? WHERE id = ?").run(title, (input.icon ?? "").slice(0, 4), at, pageId);
    } else {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM pages WHERE workspace_id = ?").get(workspaceId) as { n: number }).n;
      if (count >= LIMITS.pagesPerWorkspace) throw new PageError(`A workspace can have ${LIMITS.pagesPerWorkspace} pages.`);
      const base = (input.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "page";
      let slug = base;
      for (let i = 2; db.prepare("SELECT 1 FROM pages WHERE workspace_id = ? AND slug = ?").get(workspaceId, slug); i++) slug = `${base}-${i}`;
      pageId = newId("pg");
      db.prepare("INSERT INTO pages (id, workspace_id, slug, title, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(pageId, workspaceId, slug, title, (input.icon ?? "").slice(0, 4), at, at);
    }
    const { v } = db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM page_versions WHERE page_id = ?").get(pageId) as { v: number };
    // A newer draft replaces an older unreviewed one.
    db.prepare("UPDATE page_versions SET status = 'rejected' WHERE page_id = ? AND status = 'pending'").run(pageId);
    db.prepare(`INSERT INTO page_versions (page_id, version, html, permissions, summary, request_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(pageId, v, input.html, JSON.stringify(permissions), String(input.summary ?? "").slice(0, 500), input.request_id ?? null, at);
    return { page_id: pageId, version: v };
  });
}

/** A person approves a version: it goes live with exactly the permissions listed on it. */
export function approveVersion(db: DB, workspaceId: string, pageId: string, version: number, userId: string): void {
  const v = getVersion(db, workspaceId, pageId, version);
  // Re-lint at approval, in case the rules got stricter since it was saved.
  const problems = lintPage(v.html);
  if (problems.length) throw new PageError(`This version can't go live: ${problems.join(" ")}`);
  const at = now();
  tx(db, () => {
    db.prepare("UPDATE page_versions SET status = 'approved', approved_by = ?, approved_at = ? WHERE page_id = ? AND version = ?")
      .run(userId, at, pageId, version);
    db.prepare("UPDATE pages SET live_version = ?, status = 'live', updated_at = ? WHERE id = ?").run(version, at, pageId);
    if (v.request_id) db.prepare("UPDATE feature_requests SET status = 'done', updated_at = ? WHERE id = ? AND workspace_id = ?").run(at, v.request_id, workspaceId);
  });
}

export function rejectVersion(db: DB, workspaceId: string, pageId: string, version: number): void {
  const v = getVersion(db, workspaceId, pageId, version);
  if (v.status !== "pending") throw new PageError("Only a version waiting for review can be rejected.");
  const at = now();
  db.prepare("UPDATE page_versions SET status = 'rejected' WHERE page_id = ? AND version = ?").run(pageId, version);
  if (v.request_id) db.prepare("UPDATE feature_requests SET status = 'rejected', updated_at = ? WHERE id = ? AND workspace_id = ?").run(at, v.request_id, workspaceId);
  // A page that never went live has nothing left once its only draft is rejected.
  const page = getPage(db, workspaceId, pageId);
  if (page.live_version == null && !db.prepare("SELECT 1 FROM page_versions WHERE page_id = ? AND status = 'pending'").get(pageId)) {
    db.prepare("DELETE FROM pages WHERE id = ?").run(pageId);
  }
}

export function setPageDisabled(db: DB, workspaceId: string, pageId: string, disabled: boolean): void {
  const page = getPage(db, workspaceId, pageId);
  if (page.live_version == null) throw new PageError("This page has never been approved.");
  db.prepare("UPDATE pages SET status = ?, updated_at = ? WHERE id = ?").run(disabled ? "disabled" : "live", now(), pageId);
}

export function deletePage(db: DB, workspaceId: string, pageId: string): void {
  getPage(db, workspaceId, pageId);
  db.prepare("DELETE FROM pages WHERE id = ? AND workspace_id = ?").run(pageId, workspaceId);
}

/** Which version a frame runs, and in which mode. Throws if it may not run. */
export function runnableVersion(db: DB, workspaceId: string, pageId: string, mode: "live" | "preview", version?: number): VersionRow {
  const page = getPage(db, workspaceId, pageId);
  if (mode === "live") {
    if (page.status !== "live" || page.live_version == null) throw new PageError("This page isn't live.", 403);
    return getVersion(db, workspaceId, pageId, page.live_version);
  }
  if (!version) throw new PageError("Preview needs a version.");
  return getVersion(db, workspaceId, pageId, version);
}

// ---- The bridge ------------------------------------------------------------------

const buckets = new Map<string, { tokens: number; at: number }>();
function rateLimit(key: string): void {
  const t = Date.now();
  const b = buckets.get(key) ?? { tokens: LIMITS.bridgeCallsPerMinute, at: t };
  b.tokens = Math.min(LIMITS.bridgeCallsPerMinute, b.tokens + ((t - b.at) / 60_000) * LIMITS.bridgeCallsPerMinute);
  b.at = t;
  if (b.tokens < 1) throw new PageError("This page is making too many requests. Wait a moment.", 429);
  b.tokens -= 1;
  buckets.set(key, b);
}

export interface BridgeContext {
  db: DB;
  cfg: Config;
  provider: Provider;
  workspaceId: string;
  pageId: string;
  mode: "live" | "preview";
  version?: number;
}

const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new PageError(`${what} must be text.`);
  if (v.length > max) throw new PageError(`${what} is too long.`);
  return v;
};

/** One call from a page. Everything a page can do is in this switch. */
export async function bridgeCall(ctx: BridgeContext, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const { db, workspaceId, pageId, mode } = ctx;
  const v = runnableVersion(db, workspaceId, pageId, mode, ctx.version);
  const perms = new Set(JSON.parse(v.permissions) as Permission[]);
  const need = (p: Permission) => {
    if (!perms.has(p)) throw new PageError(`This page wasn't given the "${p}" permission.`, 403);
  };
  rateLimit(`${pageId}:${mode}`);
  const ns = mode === "live" ? "live" : `preview:${v.version}`;

  switch (method) {
    case "storage.get": {
      const key = str(args.key, 100, "key");
      const row = db.prepare("SELECT value FROM page_data WHERE page_id = ? AND namespace = ? AND key = ?").get(pageId, ns, key) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : null;
    }
    case "storage.keys":
      return (db.prepare("SELECT key FROM page_data WHERE page_id = ? AND namespace = ? ORDER BY key").all(pageId, ns) as { key: string }[]).map((r) => r.key);
    case "storage.set": {
      const key = str(args.key, 100, "key");
      const value = JSON.stringify(args.value ?? null);
      if (value.length > LIMITS.storageValueBytes) throw new PageError(`A stored value can be at most ${LIMITS.storageValueBytes / 1000} KB.`, 413);
      const totals = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM page_data
                                 WHERE page_id = ? AND namespace = ? AND key != ?`).get(pageId, ns, key) as { n: number; bytes: number };
      if (totals.n + 1 > LIMITS.storageKeys) throw new PageError(`A page can store at most ${LIMITS.storageKeys} keys.`, 413);
      if (totals.bytes + value.length > LIMITS.storageTotalBytes) throw new PageError(`A page can store at most ${LIMITS.storageTotalBytes / 1_000_000} MB.`, 413);
      db.prepare(`INSERT INTO page_data (page_id, namespace, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT (page_id, namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(pageId, ns, key, value, now());
      return true;
    }
    case "storage.delete":
      db.prepare("DELETE FROM page_data WHERE page_id = ? AND namespace = ? AND key = ?").run(pageId, ns, str(args.key, 100, "key"));
      return true;

    case "items.list":
      need("items:read");
      return db.prepare(`SELECT id, title, status, priority, due_at, next_action FROM items
                         WHERE workspace_id = ? AND status != 'done' ORDER BY priority, due_at IS NULL, due_at LIMIT 200`).all(workspaceId);
    case "items.create": {
      need("items:write");
      const title = str(args.title, 200, "title");
      if (mode === "preview") return { id: "preview", title, preview: true };
      const id = newId("itm");
      const at = now();
      db.prepare("INSERT INTO items (id, workspace_id, title, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, workspaceId, title, typeof args.notes === "string" ? args.notes.slice(0, 4000) : "", `page:${pageId}`, at, at);
      return { id, title };
    }
    case "items.complete": {
      need("items:write");
      const id = str(args.id, 40, "id");
      if (mode === "preview") return { preview: true };
      const n = db.prepare("UPDATE items SET status = 'done', updated_at = ? WHERE id = ? AND workspace_id = ?").run(now(), id, workspaceId).changes;
      if (!n) throw new PageError("No such task.", 404);
      return true;
    }

    case "ai.ask": {
      need("ai");
      const prompt = str(args.prompt, LIMITS.aiPromptChars, "prompt");
      if (pageAiSpentToday(db, workspaceId, pageId) >= ctx.cfg.pageAiDailyCapMicros) {
        throw new PaymentRequired("This page has reached its AI spending cap for today.");
      }
      const result = await meteredComplete(db, ctx.cfg, ctx.provider, {
        workspaceId, source: "page_ai", sourceRef: pageId, maxTokens: LIMITS.aiMaxTokens,
        messages: [
          { role: "system", content: "You answer questions from a small app on a customer's dashboard. Reply in plain text, briefly." },
          { role: "user", content: prompt },
        ],
      });
      return { text: result.message.content ?? "" };
    }
    default:
      throw new PageError(`Unknown bridge method "${method}".`, 404);
  }
}
