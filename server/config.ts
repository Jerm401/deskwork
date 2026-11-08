// Everything a deployment sets. Read once at start.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A model we resell, with what the provider charges us for it. */
export interface ModelPrice {
  /** The id customers and the agent use. */
  id: string;
  /** The provider's id, if it differs. */
  upstream?: string;
  label: string;
  /** Provider cost in USD per million tokens. */
  inputPerM: number;
  outputPerM: number;
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** "mock" runs with no provider at all: canned replies, real metering. */
  provider: "openai-compatible" | "mock";
  baseURL: string;
  apiKey: string | null;
  models: ModelPrice[];
  defaultModel: string;
  /** Customer price = provider cost x markup. 1.25 is a 25% margin on cost. */
  markup: number;
  /** Every call is charged at least this, so a flood of tiny calls still pays. */
  minChargeMicros: number;
  freeCreditsMicros: number;
  /** A call is refused when the balance is below this. */
  minBalanceMicros: number;
  adminEmails: string[];
  secureCookies: boolean;
  /** Each page's ai capability: max charge per page per day. */
  pageAiDailyCapMicros: number;
}

// Placeholder prices. Set real ones in data/models.json from the provider's
// price page before charging anyone; the margin is only as right as these.
const DEFAULT_MODELS: ModelPrice[] = [
  { id: "deepseek-v4.1-flash", label: "DeepSeek Flash (fast, cheap)", inputPerM: 0.3, outputPerM: 1.2 },
  { id: "qwen3-coder", label: "Qwen3 Coder (page builder)", inputPerM: 0.5, outputPerM: 2.0 },
];

export const usd = (n: number) => Math.round(n * 1_000_000);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DATA_DIR || join(process.cwd(), "data");
  const modelsFile = join(dataDir, "models.json");
  const models: ModelPrice[] = existsSync(modelsFile) ? JSON.parse(readFileSync(modelsFile, "utf8")) : DEFAULT_MODELS;
  const keyFile = join(dataDir, "llm-key");
  const apiKey = env.LLM_API_KEY?.trim() || (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "") || null;
  const provider = (env.LLM_PROVIDER as Config["provider"]) || (apiKey ? "openai-compatible" : "mock");
  return {
    port: Number(env.PORT) || 4400,
    host: env.HOST || "127.0.0.1",
    dataDir,
    provider,
    baseURL: (env.LLM_BASE_URL || "https://ollama.com/v1").replace(/\/+$/, ""),
    apiKey,
    models,
    defaultModel: env.DEFAULT_MODEL || models[0].id,
    markup: Number(env.MARKUP) || 1.25,
    minChargeMicros: usd(Number(env.MIN_CHARGE_USD ?? 0.0001)),
    freeCreditsMicros: usd(Number(env.FREE_CREDITS_USD ?? 2)),
    minBalanceMicros: usd(Number(env.MIN_BALANCE_USD ?? 0.01)),
    adminEmails: (env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    secureCookies: env.SECURE_COOKIES === "1",
    pageAiDailyCapMicros: usd(Number(env.PAGE_AI_DAILY_CAP_USD ?? 0.25)),
  };
}

export function testConfig(over: Partial<Config> = {}): Config {
  return { ...loadConfig({ DATA_DIR: "/nonexistent", LLM_PROVIDER: "mock" }), ...over };
}
