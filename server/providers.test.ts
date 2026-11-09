import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { grant } from "./billing.ts";
import { makeProvider, meteredComplete } from "./llm.ts";

/** A fake OpenAI-compatible provider that records what it was asked. */
async function fakeProvider(name: string): Promise<{ url: string; seen: { model: string; auth: string }[]; server: Server }> {
  const seen: { model: string; auth: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ model: JSON.parse(body).model, auth: String(req.headers.authorization) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: `from ${name}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
      }));
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, server };
}

function dataDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "dw-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test("each model goes to its own provider, under its upstream id, at its own price", async (t) => {
  const a = await fakeProvider("alpha");
  const b = await fakeProvider("beta");
  t.after(() => { a.server.close(); b.server.close(); });
  const dir = dataDir({
    "providers.json": JSON.stringify({ alpha: { baseURL: a.url }, beta: { baseURL: b.url } }),
    "keys/beta": "beta-key\n",
    "models.json": JSON.stringify([
      { id: "cheap", provider: "alpha", upstream: "alpha/cheap-v2", label: "Cheap", inputPerM: 0.1, outputPerM: 0 },
      { id: "smart", provider: "beta", label: "Smart", inputPerM: 2, outputPerM: 0 },
      { id: "orphan", provider: "nobody", label: "Orphan", inputPerM: 1, outputPerM: 0 },
    ]),
  });
  const cfg = loadConfig({ DATA_DIR: dir, ALPHA_API_KEY: "alpha-key", MARKUP: "1.5", DEFAULT_MODEL: "smart" });
  assert.equal(cfg.provider, "openai-compatible");
  assert.deepEqual(cfg.models.map((m) => m.id), ["cheap", "smart"]);
  assert.deepEqual(cfg.unavailableModels, [{ id: "orphan", reason: 'provider "nobody" has no key' }]);
  assert.equal(cfg.defaultModel, "smart");

  const db = openDb(":memory:");
  db.exec(`INSERT INTO users VALUES ('u1','u@x.co','', 'x', ''); INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('ws','w','u1','')`);
  grant(db, "ws", "admin_grant", 100_000_000);
  const provider = makeProvider(cfg);
  const ask = (model?: string) => meteredComplete(db, cfg, provider, { workspaceId: "ws", source: "api", model, maxTokens: 10, messages: [{ role: "user", content: "hi" }] });

  const r1 = await ask("cheap");
  assert.equal(r1.message.content, "from alpha");
  assert.deepEqual(a.seen, [{ model: "alpha/cheap-v2", auth: "Bearer alpha-key" }]);
  assert.equal(r1.chargeMicros, 150_000); // 1M tokens x $0.10 x 1.5

  const r2 = await ask(); // the default model
  assert.equal(r2.message.content, "from beta");
  assert.deepEqual(b.seen, [{ model: "smart", auth: "Bearer beta-key" }]);
  assert.equal(r2.chargeMicros, 3_000_000);

  await assert.rejects(ask("orphan"), /Unknown model/);
});

test("the single-provider setup still works, and no runnable model is an error at start", () => {
  const legacy = loadConfig({ DATA_DIR: "/nonexistent", LLM_API_KEY: "k", LLM_BASE_URL: "https://example.test/v1/" });
  assert.deepEqual(legacy.providers.default, { baseURL: "https://example.test/v1", apiKey: "k" });
  assert.equal(legacy.models.length, 2);

  const dir = dataDir({ "models.json": JSON.stringify([{ id: "x", provider: "deepseek", label: "x", inputPerM: 1, outputPerM: 1 }]) });
  assert.throws(() => loadConfig({ DATA_DIR: dir, OPENAI_API_KEY: "k" }), /No model can run: x \(provider "deepseek" has no key\)/);
  // No keys at all: mock mode, every model offered.
  assert.equal(loadConfig({ DATA_DIR: dir }).provider, "mock");
});
