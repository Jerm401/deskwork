// The one way anything in Deskwork calls a model. Every call goes through
// meteredComplete, which checks the balance first and debits after, so there
// is no code path that spends our provider money without charging for it.
//
// The wire format is OpenAI chat completions, which Ollama Cloud, DeepSeek,
// OpenRouter, Together and most others speak. Switching provider is a config
// change (LLM_BASE_URL + key + models.json prices).
import type { DB } from "./db.ts";
import type { Config, ModelPrice } from "./config.ts";
import { assertCanSpend, findModel, recordUsage, type UsageInput } from "./billing.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionRequest {
  model: ModelPrice;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens: number;
  temperature?: number;
}

export interface CompletionResult {
  message: Extract<Message, { role: "assistant" }>;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Provider {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  status = 502;
  name = "ProviderError";
}

/** Any OpenAI-compatible chat completions endpoint. Non-streaming. */
export function openAICompatible(baseURL: string, apiKey: string): Provider {
  return {
    async complete(req) {
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: req.model.upstream ?? req.model.id,
          messages: req.messages,
          tools: req.tools?.length ? req.tools : undefined,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          stream: false,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) throw new ProviderError(`Model provider answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as {
        choices: { message: CompletionResult["message"]; finish_reason: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = body.choices?.[0];
      if (!choice) throw new ProviderError("Model provider sent no choices.");
      // A provider that leaves out usage would make the call free. Estimate instead.
      const usage = body.usage?.prompt_tokens != null
        ? { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens ?? 0 }
        : { inputTokens: estimateTokens(JSON.stringify(req.messages)), outputTokens: estimateTokens(JSON.stringify(choice.message)) };
      return { message: { role: "assistant", content: choice.message.content ?? null, tool_calls: choice.message.tool_calls }, finishReason: choice.finish_reason, usage };
    },
  };
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

/**
 * No provider at all: deterministic replies, so the whole product (metering,
 * the builder, the sandbox) runs in a demo or a test without a key. It follows
 * the tools it is given the way a real model would: the builder gets a page.
 */
export function mockProvider(): Provider {
  return {
    async complete(req) {
      const last = req.messages[req.messages.length - 1];
      const input = estimateTokens(JSON.stringify(req.messages) + JSON.stringify(req.tools ?? []));
      const tools = new Set(req.tools?.map((t) => t.function.name));
      const userText = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      let message: CompletionResult["message"];
      if (last.role === "tool") {
        message = { role: "assistant", content: tools.has("save_page") ? "Built the page. It's waiting for your review." : "Done." };
      } else if (tools.has("save_page")) {
        message = { role: "assistant", content: null, tool_calls: [call("save_page", mockPage(String(userText)))] };
      } else if (tools.has("save_item") && /^(add|remind|todo)\b/i.test(String(userText))) {
        const title = String(userText).replace(/^(add|remind me to|remind|todo)\s*:?\s*/i, "");
        message = { role: "assistant", content: null, tool_calls: [call("save_item", { title })] };
      } else {
        message = { role: "assistant", content: `(mock model) You said: ${String(userText).slice(0, 200)}` };
      }
      return { message, finishReason: message.tool_calls ? "tool_calls" : "stop", usage: { inputTokens: input, outputTokens: estimateTokens(JSON.stringify(message)) } };
    },
  };
}

function call(name: string, args: unknown): ToolCall {
  return { id: `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function mockPage(request: string) {
  const slugMatch = /page id: (\S+)/.exec(request);
  return {
    slug: slugMatch ? undefined : "tracker",
    page_id: slugMatch?.[1],
    title: "Tracker",
    icon: "📋",
    permissions: ["items:read"],
    summary: "A simple list with a counter of open tasks (mock builder).",
    html: `<h1>Tracker</h1>
<p class="muted">Built for: ${request.replace(/[<>&]/g, "").slice(0, 120)}</p>
<form id="f"><input id="t" placeholder="Add an entry"> <button class="primary">Add</button></form>
<ul id="list"></ul>
<p class="small muted" id="open"></p>
<script>
(async function () {
  var list = (await desk.storage.get("entries")) || [];
  function draw() {
    document.getElementById("list").innerHTML = "";
    list.forEach(function (e) { var li = document.createElement("li"); li.textContent = e; document.getElementById("list").appendChild(li); });
  }
  document.getElementById("f").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var v = document.getElementById("t").value.trim(); if (!v) return;
    list.push(v); document.getElementById("t").value = ""; draw();
    await desk.storage.set("entries", list);
  });
  draw();
  var items = await desk.items.list();
  document.getElementById("open").textContent = items.length + " open tasks on your desk.";
})();
</script>`,
  };
}

export function makeProvider(cfg: Config): Provider {
  if (cfg.provider === "mock") return mockProvider();
  if (!cfg.apiKey) throw new Error("LLM_PROVIDER is openai-compatible but no key is set (LLM_API_KEY or data/llm-key).");
  return openAICompatible(cfg.baseURL, cfg.apiKey);
}

export interface MeteredRequest extends Omit<CompletionRequest, "model"> {
  workspaceId: string;
  source: UsageInput["source"];
  sourceRef?: string;
  model?: string;
}

export async function meteredComplete(db: DB, cfg: Config, provider: Provider, req: MeteredRequest): Promise<CompletionResult & { chargeMicros: number }> {
  const model = findModel(cfg, req.model);
  assertCanSpend(db, cfg, req.workspaceId);
  const result = await provider.complete({ model, messages: req.messages, tools: req.tools, maxTokens: req.maxTokens, temperature: req.temperature });
  const chargeMicros = recordUsage(db, cfg, {
    workspaceId: req.workspaceId, source: req.source, sourceRef: req.sourceRef, model,
    inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
  });
  return { ...result, chargeMicros };
}
