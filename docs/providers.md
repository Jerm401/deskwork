# Model providers

Deskwork doesn't run models; it resells them. Any provider with an
OpenAI-compatible chat completions API works, and several can run at once.

## Switching a provider on

Give it a key, either as `<NAME>_API_KEY` in the environment or as a file
`data/keys/<name>`. Built-in names (`KNOWN_PROVIDERS` in `server/config.ts`):
`ollama`, `deepseek`, `openrouter`, `together`, `fireworks`, `groq`, `openai`.
Add any other provider in `data/providers.json`:

    { "acme": { "baseURL": "https://api.acme.example/v1" } }

then `ACME_API_KEY=...`. The old single-provider settings (`LLM_API_KEY`,
`LLM_BASE_URL`) still work as a provider named `default`.

## Choosing what to sell

`data/models.json` is the price list. Each entry names its provider, the
provider's own model id (`upstream`) and **what that provider charges us**. See
`models.example.json`. A model whose provider has no key is left out at
start, and the start log and the Admin page say so. With no keys at all, the
server runs the mock model.

A model belongs to exactly one provider, on purpose. The customer's price is
cost × markup, so if a call silently went to a different provider at a
different cost, the margin on it could go negative. To offer the same model
from two providers, list it twice under two ids.

## Before selling a provider's models

- **Terms:** does the provider allow resale or "building a product on top"? Most
  pay-per-token APIs do. Consumer subscriptions (Ollama Cloud's plans, as far as
  we know) usually don't. Check the current terms; don't rely on this note.
- **Prices:** copy them from the provider's pricing page into `models.json`. The
  numbers in `models.example.json` are placeholders.
- **Usage reporting:** billing reads the `usage` field of each response. A
  provider that leaves it out is charged on an estimate (`estimateTokens`); prefer
  ones that report it.
- **Data:** customer email and tasks go to the provider. Check its retention and
  training terms, and say which providers you use in the privacy policy.
- **Tool calling:** the secretary and the page builder need models that support
  `tools`. Check a model with a real chat and a feature request before listing it.
