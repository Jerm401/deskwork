import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";
import { testConfig, usd } from "./config.ts";
import { openDb } from "./db.ts";
import { balance, price } from "./billing.ts";
import { mockProvider } from "./llm.ts";
import { bridgeCall, lintPage, savePageDraft, approveVersion } from "./pages.ts";
import { runBuilder, createRequest } from "./agent.ts";
import { FRAME_CSP } from "./frame.ts";

async function setup(over = {}) {
  const db = openDb(":memory:");
  const cfg = testConfig({ adminEmails: ["admin@example.com"], ...over });
  const provider = mockProvider();
  const server = createApp(db, cfg, provider).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function user(email: string) {
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(base + path, {
        method, headers: { "Content-Type": "application/json", "X-Deskwork": "1", cookie, ...headers }, body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, headers: res.headers };
    };
    const r = await call("POST", "/api/auth/signup", { email, password: "correct horse battery", name: email.split("@")[0] });
    assert.equal(r.status, 201);
    const me = await call("GET", "/api/me");
    const ws = (db.prepare("SELECT workspace_id FROM members m JOIN users u ON u.id = m.user_id WHERE u.email = ?").get(email) as { workspace_id: string }).workspace_id;
    return { call, me: me.body, ws };
  }
  return { db, cfg, provider, base, user, close: () => server.close() };
}

test("pricing: markup over provider cost, with a floor", () => {
  const cfg = testConfig({ markup: 1.25, minChargeMicros: 100 });
  const model = { id: "m", label: "m", inputPerM: 0.4, outputPerM: 2 };
  // 1M in, 1M out = $2.40 cost, $3.00 charge
  assert.deepEqual(price(cfg, model, 1_000_000, 1_000_000), { cost: usd(2.4), charge: usd(3) });
  assert.equal(price(cfg, model, 1, 1).charge, 100);
});

test("signup gives free credits and the queue is per workspace", async (t) => {
  const s = await setup();
  t.after(s.close);
  const a = await s.user("a@example.com");
  const b = await s.user("b@example.com");
  assert.equal(a.me.balance_micros, s.cfg.freeCreditsMicros);
  await a.call("POST", "/api/items", { title: "A's secret task" });
  const bItems = await b.call("GET", "/api/items");
  assert.equal(bItems.body.length, 0);
  const aItem = (await a.call("GET", "/api/items")).body[0];
  assert.equal((await b.call("PATCH", `/api/items/${aItem.id}`, { status: "done" })).status, 404);
});

test("mutations need the X-Deskwork header", async (t) => {
  const s = await setup();
  t.after(s.close);
  const a = await s.user("a@example.com");
  const r = await a.call("POST", "/api/items", { title: "x" }, { "X-Deskwork": "" });
  assert.equal(r.status, 403);
});

test("chat is metered, finishes a turn it started, then stops at zero credits", async (t) => {
  const s = await setup({ freeCreditsMicros: usd(0.0002), minChargeMicros: usd(0.0001), minBalanceMicros: 1 });
  t.after(s.close);
  const a = await s.user("a@example.com");
  const first = await a.call("POST", "/api/chat", { text: "add call the plumber" });
  assert.equal(first.status, 200);
  assert.ok(first.body.chargeMicros > 0);
  // The tool ran before the money ran out, and is kept.
  const items = await a.call("GET", "/api/items");
  assert.equal(items.body[0].title, "call the plumber");
  // Overdraft is bounded by one call.
  assert.ok(balance(s.db, a.ws) > -usd(0.01));
  // Now the next call is refused before it reaches the model.
  const second = await a.call("POST", "/api/chat", { text: "hello" });
  assert.equal(second.status, 402);
});

test("lint rejects network, storage, navigation and obfuscation", () => {
  assert.deepEqual(lintPage("<h1>Hi</h1><script>desk.storage.get('x')</script>"), []);
  for (const bad of [
    "<script>fetch('/api/items')</script>",
    "<script src='https://evil.example/x.js'></script>",
    "<img src='https://evil.example/p.gif'>",
    "<script>location.href='//x.y'</script>",
    "<script>document.cookie</script>",
    "<script>parent.postMessage(1,'*')</script>",
    "<script>window['fe'+'tch']('x')</script>",
    "<script>eval('1')</script>",
    "<meta http-equiv='refresh' content='0'>",
    "<iframe srcdoc='x'></iframe>",
    "<script>'\\x66etch'</script>",
  ]) assert.ok(lintPage(bad).length > 0, bad);
});

test("bridge enforces the approved version's permissions, not the draft's", async () => {
  const db = openDb(":memory:");
  const cfg = testConfig();
  const ws = "ws_1";
  db.exec(`INSERT INTO users VALUES ('u1','u@x.co','', 'x', '');
           INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('ws_1','w','u1','');
           INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('ws_2','w2','u1','');
           INSERT INTO items (id, workspace_id, title, created_at, updated_at) VALUES ('i1','ws_1','mine','',''), ('i2','ws_2','theirs','','')`);
  const ctx = (mode: "live" | "preview", version?: number) => ({ db, cfg, provider: mockProvider(), workspaceId: ws, pageId: "", mode, version });

  const { page_id } = savePageDraft(db, ws, { title: "P", permissions: [], html: "<p>v1</p>" });
  await assert.rejects(bridgeCall({ ...ctx("live"), pageId: page_id }, "storage.get", { key: "k" }), /isn't live/);
  approveVersion(db, ws, page_id, 1, "u1");
  await assert.rejects(bridgeCall({ ...ctx("live"), pageId: page_id }, "items.list"), /items:read/);

  // A draft asks for items:read. Until approved, live still runs v1 without it.
  savePageDraft(db, ws, { page_id, title: "P", permissions: ["items:read", "items:write"], html: "<p>v2</p>" });
  await assert.rejects(bridgeCall({ ...ctx("live"), pageId: page_id }, "items.list"), /items:read/);
  // Preview may read, but writes are fake and storage is separate.
  const preview = { ...ctx("preview", 2), pageId: page_id };
  assert.deepEqual((await bridgeCall(preview, "items.list") as { title: string }[]).map((i) => i.title), ["mine"]);
  assert.equal((await bridgeCall(preview, "items.create", { title: "x" }) as { preview: boolean }).preview, true);
  await bridgeCall(preview, "storage.set", { key: "k", value: "preview" });
  approveVersion(db, ws, page_id, 2, "u1");
  assert.equal(await bridgeCall({ ...ctx("live"), pageId: page_id }, "storage.get", { key: "k" }), null);
  // Only this workspace's items, and complete can't reach another workspace's.
  await assert.rejects(bridgeCall({ ...ctx("live"), pageId: page_id }, "items.complete", { id: "i2" }), /No such task/);
  // Another workspace can't run this page at all.
  await assert.rejects(bridgeCall({ ...ctx("live"), workspaceId: "ws_2", pageId: page_id }, "storage.get", { key: "k" }), /No such page/);
});

test("storage quotas hold", async () => {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO users VALUES ('u1','u@x.co','', 'x', ''); INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('ws_1','w','u1','')`);
  const { page_id } = savePageDraft(db, "ws_1", { title: "P", permissions: [], html: "<p></p>" });
  approveVersion(db, "ws_1", page_id, 1, "u1");
  const ctx = { db, cfg: testConfig(), provider: mockProvider(), workspaceId: "ws_1", pageId: page_id, mode: "live" as const };
  await assert.rejects(bridgeCall(ctx, "storage.set", { key: "big", value: "x".repeat(70_000) }), /64 KB/);
});

test("feature request -> builder -> review -> approve -> live frame", async (t) => {
  const s = await setup();
  t.after(s.close);
  const a = await s.user("a@example.com");
  const b = await s.user("b@example.com");
  const req = await a.call("POST", "/api/requests", { text: "I need a mileage log" });
  assert.equal(req.status, 202);
  await new Promise((r) => setTimeout(r, 50));
  const [r] = (await a.call("GET", "/api/requests")).body;
  assert.equal(r.status, "review", r.result);
  assert.ok(r.cost_micros > 0);
  const pageId = r.page_id;

  // Not live yet: the live frame refuses, preview works.
  assert.equal((await a.call("GET", `/frame/pages/${pageId}`)).status, 403);
  const preview = await a.call("GET", `/frame/pages/${pageId}?mode=preview&v=1`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-security-policy"), FRAME_CSP);
  assert.match(FRAME_CSP, /sandbox allow-scripts allow-forms$/);
  assert.doesNotMatch(FRAME_CSP, /allow-same-origin/);

  // Another customer can't see, preview, or approve it.
  assert.equal((await b.call("GET", `/frame/pages/${pageId}?mode=preview&v=1`)).status, 404);
  assert.equal((await b.call("POST", `/api/pages/${pageId}/versions/1/approve`)).status, 404);

  assert.equal((await a.call("POST", `/api/pages/${pageId}/versions/1/approve`)).status, 200);
  assert.equal((await a.call("GET", `/frame/pages/${pageId}`)).status, 200);
  assert.equal((await a.call("GET", "/api/requests")).body[0].status, "done");
  const bridge = await a.call("POST", `/api/pages/${pageId}/bridge`, { method: "items.list" });
  assert.equal(bridge.status, 200);
});

test("builder output that breaks the rules is never saved", async () => {
  const db = openDb(":memory:");
  const cfg = testConfig();
  db.exec(`INSERT INTO users VALUES ('u1','u@x.co','', 'x', ''); INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('ws_1','w','u1','')`);
  db.prepare("INSERT INTO ledger (workspace_id, kind, amount_micros, created_at) VALUES ('ws_1','free_grant',1000000,'')").run();
  // A model that always writes a page that phones home.
  const evil = {
    async complete() {
      return {
        message: { role: "assistant" as const, content: null, tool_calls: [{ id: "c", type: "function" as const, function: { name: "save_page", arguments: JSON.stringify({ title: "x", permissions: [], summary: "", html: "<script>fetch('//evil.example')</script>" }) } }] },
        finishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  };
  const id = createRequest(db, "ws_1", "u1", "make a page");
  await runBuilder(db, cfg, evil, "ws_1", id);
  const r = db.prepare("SELECT status FROM feature_requests WHERE id = ?").get(id) as { status: string };
  assert.equal(r.status, "failed");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number }).n, 0);
});

test("API keys: metered gateway, revocation, and admin grants", async (t) => {
  const s = await setup();
  t.after(s.close);
  const a = await s.user("a@example.com");
  const key = (await a.call("POST", "/api/keys", { name: "laptop" })).body;
  assert.match(key.key, /^dw_live_/);
  const before = balance(s.db, a.ws);
  const v1 = (body: unknown, k = key.key) => fetch(`${s.base}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` }, body: JSON.stringify(body),
  });
  const res = await v1({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  const body = await res.json() as { usage: { prompt_tokens: number } };
  assert.ok(body.usage.prompt_tokens > 0);
  assert.ok(balance(s.db, a.ws) < before);
  assert.equal((await v1({ model: "gpt-nope", messages: [{ role: "user", content: "hi" }] })).status, 400);
  assert.equal((await v1({ messages: [] }, "dw_live_wrong")).status, 401);
  await a.call("DELETE", `/api/keys/${key.id}`);
  assert.equal((await v1({ messages: [{ role: "user", content: "hi" }] })).status, 401);

  assert.equal((await a.call("POST", `/api/admin/workspaces/${a.ws}/grant`, { usd: 5 })).status, 403);
  const admin = await s.user("admin@example.com");
  const g = await admin.call("POST", `/api/admin/workspaces/${a.ws}/grant`, { usd: 5, note: "test" });
  assert.equal(g.status, 200);
});
