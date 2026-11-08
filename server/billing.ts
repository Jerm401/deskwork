// Credits: the whole business model in one file.
//
// Customers prepay credits (or get free ones). Every model call is priced at
// provider cost x markup and debited from the workspace's ledger. A call is
// refused before it starts if the balance is under the floor. A call can
// overshoot the balance by at most one call's cost, because the price is
// only known after the provider reports token usage; max_tokens caps that.
import { type DB, newId, now, tx } from "./db.ts";
import type { Config, ModelPrice } from "./config.ts";

export class PaymentRequired extends Error {
  status = 402;
  constructor(message = "Out of credits. Add credits to keep going.") {
    super(message);
  }
}

export function grant(db: DB, workspaceId: string, kind: "free_grant" | "purchase" | "admin_grant" | "refund", micros: number, note = ""): void {
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error("A grant must be a positive whole number of micro-dollars.");
  db.prepare("INSERT INTO ledger (workspace_id, kind, amount_micros, note, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(workspaceId, kind, micros, note, now());
}

export function balance(db: DB, workspaceId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount_micros), 0) AS b FROM ledger WHERE workspace_id = ?").get(workspaceId) as { b: number };
  return row.b;
}

export function assertCanSpend(db: DB, cfg: Config, workspaceId: string): void {
  if (balance(db, workspaceId) < cfg.minBalanceMicros) throw new PaymentRequired();
}

export function findModel(cfg: Config, id: string | undefined): ModelPrice {
  const m = cfg.models.find((x) => x.id === (id || cfg.defaultModel));
  if (!m) throw Object.assign(new Error(`Unknown model "${id}". Available: ${cfg.models.map((x) => x.id).join(", ")}`), { status: 400 });
  return m;
}

/** Provider cost and customer charge for one call, in micro-dollars. */
export function price(cfg: Config, model: ModelPrice, inputTokens: number, outputTokens: number): { cost: number; charge: number } {
  // per-million price in USD == micro-dollars per token
  const cost = Math.ceil(inputTokens * model.inputPerM + outputTokens * model.outputPerM);
  const charge = Math.max(cfg.minChargeMicros, Math.ceil(cost * cfg.markup));
  return { cost, charge };
}

/** Customer-facing price per million tokens, for the pricing table. */
export function listPrice(cfg: Config, model: ModelPrice) {
  return { id: model.id, label: model.label, inputPerM: +(model.inputPerM * cfg.markup).toFixed(4), outputPerM: +(model.outputPerM * cfg.markup).toFixed(4) };
}

export interface UsageInput {
  workspaceId: string;
  source: "chat" | "builder" | "page_ai" | "api";
  sourceRef?: string;
  model: ModelPrice;
  inputTokens: number;
  outputTokens: number;
}

/** Records a finished call and debits it. Returns the charge. */
export function recordUsage(db: DB, cfg: Config, u: UsageInput): number {
  const { cost, charge } = price(cfg, u.model, u.inputTokens, u.outputTokens);
  const id = newId("use");
  const at = now();
  tx(db, () => {
    db.prepare(`INSERT INTO usage (id, workspace_id, source, source_ref, model, input_tokens, output_tokens, cost_micros, charge_micros, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, u.workspaceId, u.source, u.sourceRef ?? null, u.model.id, u.inputTokens, u.outputTokens, cost, charge, at);
    db.prepare("INSERT INTO ledger (workspace_id, kind, amount_micros, usage_id, created_at) VALUES (?, 'usage', ?, ?, ?)")
      .run(u.workspaceId, -charge, id, at);
  });
  return charge;
}

/** What a page has spent on ai today, for its daily cap. */
export function pageAiSpentToday(db: DB, workspaceId: string, pageId: string): number {
  const since = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`SELECT COALESCE(SUM(charge_micros), 0) AS s FROM usage
                          WHERE workspace_id = ? AND source = 'page_ai' AND source_ref = ? AND created_at >= ?`).get(workspaceId, pageId, since) as { s: number };
  return row.s;
}

export function usageSummary(db: DB, workspaceId: string) {
  return {
    balance_micros: balance(db, workspaceId),
    by_source: db.prepare(`SELECT source, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                                  SUM(charge_micros) AS charge_micros
                           FROM usage WHERE workspace_id = ? AND created_at >= date('now', '-30 days') GROUP BY source`).all(workspaceId),
    recent: db.prepare(`SELECT id, source, source_ref, model, input_tokens, output_tokens, charge_micros, created_at
                        FROM usage WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50`).all(workspaceId),
    ledger: db.prepare(`SELECT kind, amount_micros, note, created_at FROM ledger
                        WHERE workspace_id = ? AND kind != 'usage' ORDER BY seq DESC LIMIT 20`).all(workspaceId),
  };
}

/** Admin view: every workspace, its balance, and our margin on it. */
export function adminOverview(db: DB) {
  return db.prepare(`
    SELECT w.id, w.name, w.status, u.email AS owner_email, w.created_at,
      (SELECT COALESCE(SUM(amount_micros), 0) FROM ledger l WHERE l.workspace_id = w.id) AS balance_micros,
      (SELECT COALESCE(SUM(charge_micros), 0) FROM usage x WHERE x.workspace_id = w.id) AS revenue_micros,
      (SELECT COALESCE(SUM(cost_micros), 0) FROM usage x WHERE x.workspace_id = w.id) AS cost_micros
    FROM workspaces w JOIN users u ON u.id = w.owner_id ORDER BY w.created_at DESC`).all();
}
