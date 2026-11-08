import { join } from "node:path";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { makeProvider } from "./llm.ts";

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, "deskwork.db"));
const provider = makeProvider(cfg);
const app = createApp(db, cfg, provider, join(import.meta.dirname, "..", "dist"));

// Builds that were running when the server stopped will never finish.
db.prepare("UPDATE feature_requests SET status = 'failed', result = 'Interrupted by a restart. Send the request again.' WHERE status IN ('queued','building')").run();

app.listen(cfg.port, cfg.host, () => {
  console.log(`deskwork on http://${cfg.host}:${cfg.port} (provider: ${cfg.provider}${cfg.provider === "mock" ? ", no model key: canned replies" : ""})`);
});
