// The HTTP surface. Every /api route below requireSession reads and writes
// only req.account.workspaceId; nothing takes a workspace id from the client.
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import type { Config } from "./config.ts";
import {
  accountForSession, AuthError, createApiKey, createSession, endSession, listApiKeys, login, readCookie,
  requireAdmin, requireApiKey, requireSession, revokeApiKey, SESSION_COOKIE, sessionCookie, signup,
} from "./auth.ts";
import { adminOverview, balance, findModel, grant, listPrice, usageSummary } from "./billing.ts";
import { meteredComplete, type Message, type Provider } from "./llm.ts";
import {
  approveVersion, bridgeCall, deletePage, getPage, getVersion, listPages, listVersions, PERMISSIONS, rejectVersion,
  runnableVersion, setPageDisabled,
} from "./pages.ts";
import { frameDocument, FRAME_HEADERS } from "./frame.ts";
import { chat, chatHistory, createRequest, listRequests, runBuilder } from "./agent.ts";

const APP_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "connect-src 'self'", "frame-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");

type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve().then(() => fn(req, res)).catch(next);
};

export function createApp(db: DB, cfg: Config, provider: Provider, distDir?: string) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "1mb" }));
  const auth = requireSession(db, cfg);
  // Free credits make sign-ups worth farming. In production add email
  // verification and a captcha; this per-IP cap is only the first line.
  const signupHits = new Map<string, number[]>();
  const signupLimit = (ip: string) => {
    const t = Date.now();
    const hits = (signupHits.get(ip) ?? []).filter((x) => t - x < 3_600_000);
    if (hits.length >= 5) throw new AuthError("Too many sign-ups from this address. Try again later.", 429);
    hits.push(t);
    signupHits.set(ip, hits);
  };
  const ws = (req: Request) => req.account!.workspaceId;

  app.get("/healthz", (_req, res) => void res.json({ ok: true }));

  // ---- Auth ----
  app.post("/api/auth/signup", h((req, res) => {
    signupLimit(req.ip ?? "?");
    const { userId, workspaceId } = signup(db, cfg, req.body ?? {});
    res.setHeader("Set-Cookie", sessionCookie(createSession(db, userId, workspaceId), cfg.secureCookies));
    res.status(201).json({ ok: true });
  }));
  app.post("/api/auth/login", h((req, res) => {
    const { userId, workspaceId } = login(db, String(req.body?.email ?? ""), String(req.body?.password ?? ""));
    res.setHeader("Set-Cookie", sessionCookie(createSession(db, userId, workspaceId), cfg.secureCookies));
    res.json({ ok: true });
  }));
  app.post("/api/auth/logout", h((req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) endSession(db, token);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  }));
  app.get("/api/me", auth, h((req, res) => {
    const a = req.account!;
    const w = db.prepare("SELECT name FROM workspaces WHERE id = ?").get(a.workspaceId) as { name: string };
    res.json({ email: a.email, name: a.name, workspace: w.name, is_admin: a.isAdmin, balance_micros: balance(db, a.workspaceId), mock: cfg.provider === "mock" });
  }));

  // ---- Queue ----
  app.get("/api/items", auth, h((req, res) => {
    res.json(db.prepare(`SELECT * FROM items WHERE workspace_id = ? AND (status != 'done' OR updated_at > datetime('now','-1 day'))
                         ORDER BY status = 'done', priority, due_at IS NULL, due_at`).all(ws(req)));
  }));
  app.post("/api/items", auth, h((req, res) => {
    const title = String(req.body?.title ?? "").trim().slice(0, 200);
    if (!title) throw new AuthError("A task needs a title.");
    const id = newId("itm");
    const at = now();
    db.prepare("INSERT INTO items (id, workspace_id, title, priority, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, ws(req), title, Number(req.body?.priority) || 3, req.body?.due_at || null, at, at);
    res.status(201).json({ id });
  }));
  app.patch("/api/items/:id", auth, h((req, res) => {
    const status = String(req.body?.status ?? "");
    if (!["open", "waiting", "done"].includes(status)) throw new AuthError("Bad status.");
    const n = db.prepare("UPDATE items SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").run(status, now(), String(req.params.id), ws(req)).changes;
    res.status(n ? 200 : 404).json({ ok: n > 0 });
  }));

  // ---- Chat ----
  app.get("/api/chat", auth, h((req, res) => {
    const msgs = chatHistory(db, ws(req), req.account!.userId, 100);
    res.json(msgs.filter((m) => (m.role === "user" || m.role === "assistant") && m.content).map((m) => ({ role: m.role, content: m.content })));
  }));
  app.post("/api/chat", auth, h(async (req, res) => {
    res.json(await chat(db, cfg, provider, ws(req), req.account!.userId, String(req.body?.text ?? "")));
  }));

  // ---- Feature requests ----
  app.get("/api/requests", auth, h((req, res) => void res.json(listRequests(db, ws(req)))));
  app.post("/api/requests", auth, h((req, res) => {
    const id = createRequest(db, ws(req), req.account!.userId, String(req.body?.text ?? ""), req.body?.page_id || undefined);
    void runBuilder(db, cfg, provider, ws(req), id);
    res.status(202).json({ id });
  }));

  // ---- Pages ----
  app.get("/api/permissions", (_req, res) => void res.json(PERMISSIONS));
  app.get("/api/pages", auth, h((req, res) => void res.json(listPages(db, ws(req)))));
  app.get("/api/pages/:id", auth, h((req, res) => {
    const page = getPage(db, ws(req), String(req.params.id));
    res.json({ ...page, versions: listVersions(db, ws(req), page.id) });
  }));
  app.get("/api/pages/:id/versions/:v", auth, h((req, res) => {
    const v = getVersion(db, ws(req), String(req.params.id), Number(req.params.v));
    res.json({ ...v, permissions: JSON.parse(v.permissions) });
  }));
  app.post("/api/pages/:id/versions/:v/approve", auth, h((req, res) => {
    approveVersion(db, ws(req), String(req.params.id), Number(req.params.v), req.account!.userId);
    res.json({ ok: true });
  }));
  app.post("/api/pages/:id/versions/:v/reject", auth, h((req, res) => {
    rejectVersion(db, ws(req), String(req.params.id), Number(req.params.v));
    res.json({ ok: true });
  }));
  app.post("/api/pages/:id/versions/:v/rollback", auth, h((req, res) => {
    // Rolling back = approving an older version again.
    const v = getVersion(db, ws(req), String(req.params.id), Number(req.params.v));
    if (v.status !== "approved") throw new AuthError("Only a version that was live before can be rolled back to.");
    approveVersion(db, ws(req), v.page_id, v.version, req.account!.userId);
    res.json({ ok: true });
  }));
  app.post("/api/pages/:id/disable", auth, h((req, res) => void (setPageDisabled(db, ws(req), String(req.params.id), true), res.json({ ok: true }))));
  app.post("/api/pages/:id/enable", auth, h((req, res) => void (setPageDisabled(db, ws(req), String(req.params.id), false), res.json({ ok: true }))));
  app.delete("/api/pages/:id", auth, h((req, res) => void (deletePage(db, ws(req), String(req.params.id)), res.json({ ok: true }))));

  app.post("/api/pages/:id/bridge", auth, h(async (req, res) => {
    const b = req.body ?? {};
    const mode = b.mode === "preview" ? "preview" : "live";
    try {
      const value = await bridgeCall(
        { db, cfg, provider, workspaceId: ws(req), pageId: String(req.params.id), mode, version: Number(b.version) || undefined },
        String(b.method ?? ""), typeof b.args === "object" && b.args ? b.args : {},
      );
      res.json({ ok: true, value });
    } catch (e) {
      const err = e as Error & { status?: number };
      res.status(err.status ?? 500).json({ ok: false, error: err.status ? err.message : "Something went wrong." });
    }
  }));

  // The sandboxed document. Same session check as the API, so one customer
  // can't load another's page code; the CSP header does the sandboxing.
  app.get("/frame/pages/:id", (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    const account = token ? accountForSession(db, cfg, token) : null;
    for (const [k, v] of Object.entries(FRAME_HEADERS)) res.setHeader(k, v);
    if (!account) return void res.status(401).type("text/plain").send("Sign in first.");
    try {
      const mode = req.query.mode === "preview" ? "preview" : "live";
      const v = runnableVersion(db, account.workspaceId, String(req.params.id), mode, Number(req.query.v) || undefined);
      const page = getPage(db, account.workspaceId, v.page_id);
      res.type("html").send(frameDocument(v.html, page.title));
    } catch (e) {
      const err = e as Error & { status?: number };
      res.status(err.status ?? 500).type("text/plain").send(err.message);
    }
  });

  // ---- Billing ----
  app.get("/api/pricing", (_req, res) => void res.json({ markup: cfg.markup, models: cfg.models.map((m) => listPrice(cfg, m)) }));
  app.get("/api/billing", auth, h((req, res) => void res.json(usageSummary(db, ws(req)))));
  app.post("/api/billing/checkout", auth, h((_req, res) => {
    // Stripe Checkout goes here; its webhook calls grant(..., "purchase", ...). See docs/billing.md.
    res.status(501).json({ error: "Card payments aren't connected yet. Ask us for credits." });
  }));

  // ---- API keys ----
  app.get("/api/keys", auth, h((req, res) => void res.json(listApiKeys(db, ws(req)))));
  app.post("/api/keys", auth, h((req, res) => void res.status(201).json(createApiKey(db, ws(req), String(req.body?.name ?? "")))));
  app.delete("/api/keys/:id", auth, h((req, res) => {
    const ok = revokeApiKey(db, ws(req), String(req.params.id));
    res.status(ok ? 200 : 404).json({ ok });
  }));

  // ---- Admin (us, not customers) ----
  app.get("/api/admin/workspaces", auth, requireAdmin, h((_req, res) => void res.json(adminOverview(db))));
  app.get("/api/admin/providers", auth, requireAdmin, h((_req, res) => {
    // Names and URLs only; keys never leave the server.
    res.json({
      mode: cfg.provider,
      providers: Object.entries(cfg.providers).map(([name, p]) => ({ name, baseURL: p.baseURL })),
      models: cfg.models.map((m) => {
        const sell = listPrice(cfg, m);
        return { id: m.id, provider: m.provider ?? "default", upstream: m.upstream ?? m.id, cost: { inputPerM: m.inputPerM, outputPerM: m.outputPerM }, price: { inputPerM: sell.inputPerM, outputPerM: sell.outputPerM } };
      }),
      unavailable: cfg.unavailableModels,
      markup: cfg.markup,
    });
  }));
  app.post("/api/admin/workspaces/:id/grant", auth, requireAdmin, h((req, res) => {
    const usdAmount = Number(req.body?.usd);
    if (!(usdAmount > 0 && usdAmount <= 1000)) throw new AuthError("Grant between $0 and $1000.");
    if (!db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(String(req.params.id))) throw new AuthError("No such workspace.", 404);
    grant(db, String(req.params.id), "admin_grant", Math.round(usdAmount * 1e6), `By ${req.account!.email}: ${String(req.body?.note ?? "")}`.slice(0, 200));
    res.json({ ok: true, balance_micros: balance(db, String(req.params.id)) });
  }));

  // ---- Metered, OpenAI-compatible gateway for customers' own tools ----
  const v1 = express.Router();
  v1.use(requireApiKey(db));
  v1.get("/models", (_req, res) => void res.json({ object: "list", data: cfg.models.map((m) => ({ id: m.id, object: "model", owned_by: "deskwork" })) }));
  v1.post("/chat/completions", h(async (req, res) => {
    const b = req.body ?? {};
    if (b.stream) return void res.status(400).json({ error: { message: "Streaming isn't supported yet.", type: "invalid_request_error" } });
    if (!Array.isArray(b.messages) || !b.messages.length) return void res.status(400).json({ error: { message: "messages is required.", type: "invalid_request_error" } });
    const model = findModel(cfg, b.model);
    const result = await meteredComplete(db, cfg, provider, {
      workspaceId: ws(req), source: "api", sourceRef: req.apiKeyId, model: model.id,
      messages: b.messages as Message[], tools: b.tools, temperature: b.temperature,
      maxTokens: Math.min(Number(b.max_tokens) || 4096, 16_384),
    });
    res.json({
      id: newId("chatcmpl"), object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model.id,
      choices: [{ index: 0, message: result.message, finish_reason: result.finishReason }],
      usage: { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens, total_tokens: result.usage.inputTokens + result.usage.outputTokens },
    });
  }));
  app.use("/v1", v1);

  // ---- The dashboard ----
  if (distDir && existsSync(join(distDir, "index.html"))) {
    const index = readFileSync(join(distDir, "index.html"), "utf8");
    app.use((req, res, next) => {
      res.setHeader("Content-Security-Policy", APP_CSP);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "same-origin");
      next();
    });
    app.use(express.static(distDir, { index: false }));
    app.get(/^\/(?!api\/|v1\/|frame\/).*/, (_req, res) => void res.type("html").send(index));
  }

  app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? (err instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(err);
    const message = status >= 500 && !(err.name === "ProviderError") ? "Something went wrong." : err.message;
    if (req.path.startsWith("/v1/")) return void res.status(status).json({ error: { message, type: status === 402 ? "insufficient_quota" : "api_error" } });
    res.status(status).json({ error: message });
  });
  return app;
}
