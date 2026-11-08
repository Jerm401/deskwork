# Deskwork

AI secretaries that do real work, sold on prepaid, metered credits. Each
customer gets a desk: a task queue, a secretary they chat with, and pages the AI
builds for them on request: "I need a mileage log", "show my overdue tasks by
client", "a calculator for my quotes". The customer reviews each page before it
goes live, and it runs in a sandbox that can't reach the network or anything
outside its own data.

It grew out of Jeremy's Desk (a single-user secretary dashboard) and keeps its
ideas: the priority queue, the agent with tools, sandboxed widgets. It's a new
codebase because a business needs things that the Desk was built without: accounts,
tenants, money, and code from untrusted sources.

**Status: prototype.** Everything below works and is tested, but see
[docs/roadmap.md](docs/roadmap.md) before anyone pays for it.

## How it makes money

Every model call (chat, page builds, a page's own AI calls, and customers' own
tools through the API) goes through one function, `meteredComplete`. It refuses
the call if the balance is too low, then debits **provider cost × markup**
(default 1.25) from an append-only ledger. New accounts get free credits
(`FREE_CREDITS_USD`, default $2). There's no code path that spends provider
money without charging for it. See [docs/billing.md](docs/billing.md).

## Run it

Node 24 (for `node:sqlite` and `.ts` type stripping).

    npm install
    npm run build
    npm start                     # http://127.0.0.1:4400

With no model key it runs in **demo mode**: a mock model gives canned
answers and builds a sample page, and metering still runs. That's enough to
click through the whole product. For real models:

    LLM_API_KEY=...  LLM_BASE_URL=https://ollama.com/v1  npm start

Any OpenAI-compatible provider works. Put real prices in `data/models.json`
first (the format is `ModelPrice` in `server/config.ts`); the built-in prices
are placeholders.

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `4400`, `127.0.0.1` | |
| `DATA_DIR` | `./data` | SQLite db, `models.json`, `llm-key` |
| `LLM_PROVIDER` | `mock` without a key | `openai-compatible` or `mock` |
| `LLM_BASE_URL`, `LLM_API_KEY` | Ollama Cloud | or `data/llm-key` |
| `MARKUP` | `1.25` | customer price = cost × markup |
| `FREE_CREDITS_USD` | `2` | per new account |
| `PAGE_AI_DAILY_CAP_USD` | `0.25` | per page, per day |
| `ADMIN_EMAILS` | | comma-separated; these accounts see the Admin page |
| `SECURE_COOKIES` | | `1` behind HTTPS |

`npm test` runs the server tests, including tenant isolation, the credit cutoff,
and the bridge's permission checks. `npm run typecheck` checks types.

## The pieces

| | |
|---|---|
| `server/billing.ts` | Ledger, pricing, the credit check |
| `server/llm.ts` | Provider adapter, mock model, `meteredComplete` |
| `server/agent.ts` | Secretary chat and the page builder (tool loops) |
| `server/pages.ts` | Pages, versions, approval, lint, **the bridge** (what pages may do) |
| `server/frame.ts` | The sandboxed document a page runs in, and the builder's runtime guide |
| `server/auth.ts` | Accounts, sessions, customer API keys |
| `server/app.ts` | HTTP routes, including the OpenAI-compatible `/v1` gateway |
| `web/src/PageFrame.tsx` | Runs a page and relays its bridge calls |

## Custom pages, in one paragraph

A customer asks for a feature. The builder agent writes one HTML page and
saves it as a **pending version**, with a list of permissions it needs
(`items:read`, `items:write`, `ai`). The customer previews it, using throwaway storage
and with no writes to real data, sees the permission list, and approves or rejects.
Only an approved version runs live, with exactly the permissions it was approved
with. The page runs in an opaque-origin sandboxed iframe with a CSP that blocks all
network access. Its only channel is a `desk` object whose calls the server checks.
Every version is kept, so a change can be rolled back. Full model and known gaps:
[docs/security.md](docs/security.md).
