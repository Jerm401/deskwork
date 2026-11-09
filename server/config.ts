// Everything a deployment sets. Read once at start.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A model we resell, with what the provider charges us for it. */
export interface ModelPrice {
  /** The id customers and the agent use. */
  id: string;
  /** Which provider serves it (a key of Config.providers). Default "default". */
  provider?: string;
  /** The provider's id for the model, if it differs from ours. */
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
  /** Every provider that has a key. Models whose provider isn't here are left out. */
  providers: Record<string, ProviderConfig>;
  /** Models sold right now: only those whose provider has a key (all of them in mock mode). */
  models: ModelPrice[];
  /** Models in models.json that were left out, and why. For the admin page and the start log. */
  unavailableModels: { id: string; reason: string }[];
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

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
}

/**
 * OpenAI-compatible endpoints we know. A provider is switched on by giving it a
 * key: <NAME>_API_KEY in the environment (e.g. DEEPSEEK_API_KEY) or a file
 * data/keys/<name>. Others can be added in data/providers.json as
 * {"name": {"baseURL": "https://..."}}. "default" is LLM_BASE_URL + LLM_API_KEY.
 * Check each provider's terms allow resale before selling its models.
 */
export const KNOWN_PROVIDERS: Record<string, string> = {
  ollama: "https://ollama.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
};

function loadProviders(env: NodeJS.ProcessEnv, dataDir: string): Record<string, ProviderConfig> {
  const readKey = (name: string, envName: string) => {
    const file = join(dataDir, "keys", name);
    return env[envName]?.trim() || (existsSync(file) ? readFileSync(file, "utf8").trim() : "") || null;
  };
  const extraFile = join(dataDir, "providers.json");
  const extra: Record<string, { baseURL: string }> = existsSync(extraFile) ? JSON.parse(readFileSync(extraFile, "utf8")) : {};
  const urls: Record<string, string> = { ...KNOWN_PROVIDERS };
  for (const [name, p] of Object.entries(extra)) urls[name] = p.baseURL;
  const out: Record<string, ProviderConfig> = {};
  for (const [name, url] of Object.entries(urls)) {
    const key = readKey(name, `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`);
    if (key) out[name] = { baseURL: url.replace(/\/+$/, ""), apiKey: key };
  }
  // The single-provider setup from before: LLM_API_KEY or data/llm-key.
  const legacyFile = join(dataDir, "llm-key");
  const legacy = env.LLM_API_KEY?.trim() || (existsSync(legacyFile) ? readFileSync(legacyFile, "utf8").trim() : "") || null;
  if (legacy) out.default = { baseURL: (env.LLM_BASE_URL || KNOWN_PROVIDERS.ollama).replace(/\/+$/, ""), apiKey: legacy };
  return out;
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
  const allModels: ModelPrice[] = existsSync(modelsFile) ? JSON.parse(readFileSync(modelsFile, "utf8")) : DEFAULT_MODELS;
  const providers = loadProviders(env, dataDir);
  const provider = (env.LLM_PROVIDER as Config["provider"]) || (Object.keys(providers).length ? "openai-compatible" : "mock");
  const unavailableModels: Config["unavailableModels"] = [];
  const models = provider === "mock" ? allModels : allModels.filter((m) => {
    const p = m.provider ?? "default";
    if (providers[p]) return true;
    unavailableModels.push({ id: m.id, reason: `provider "${p}" has no key` });
    return false;
  });
  if (!models.length) throw new Error(`No model can run: ${unavailableModels.map((m) => `${m.id} (${m.reason})`).join(", ")}. Set a provider key or LLM_PROVIDER=mock.`);
  const defaultModel = env.DEFAULT_MODEL && models.some((m) => m.id === env.DEFAULT_MODEL) ? env.DEFAULT_MODEL : models[0].id;
  return {
    port: Number(env.PORT) || 4400,
    host: env.HOST || "127.0.0.1",
    dataDir,
    provider,
    providers,
    models,
    unavailableModels,
    defaultModel,
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
