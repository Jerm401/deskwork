# Billing

## Money model

- **Ledger, not a balance column.** `ledger` is append-only: grants positive, usage
  negative, balance = sum. Amounts are integer micro-dollars (1e-6 USD), so there's
  no float drift. Corrections are new rows (`refund`, `admin_grant`), never edits.
- **Price = provider cost × `MARKUP`**, with a per-call floor (`MIN_CHARGE_USD`) so
  floods of tiny calls still pay. Both numbers sit side by side on every `usage`
  row, so the Admin page shows real margin per workspace.
- **Check before, debit after.** A call is refused (HTTP 402) when the balance is
  under `MIN_BALANCE_USD`. Token counts are only known afterwards, so one call can
  overdraw by at most its own cost; `max_tokens` bounds that. If the money runs out
  partway through an agent turn, what already ran is kept and the agent says it
  stopped.
- **Every path is metered**: chat, page builds (the builder's tokens are charged to
  the customer who asked, and shown on the request), page `desk.ai.ask` calls (with a
  per-page daily cap), and the `/v1` gateway for customers' own tools.
- **No usage figure from the provider = estimate.** If a provider leaves out
  `usage`, it's estimated from the text, never zero.

## Before charging real money

1. **Provider prices and terms.** The default prices in `server/config.ts` are
   placeholders. Check whether the provider allows resale. Ollama Cloud, as far as
   I know, sells subscription plans with usage limits rather than per-token API
   pricing, and a subscription plan usually isn't licensed for reselling to third
   parties. If that's still true, the cost basis for a markup doesn't exist and the
   terms may forbid it. A per-token provider with explicit API terms (DeepSeek's own
   API, OpenRouter, Together, Fireworks, or Anthropic/OpenAI) fits this model
   directly. Switching or mixing providers is a key plus `data/models.json`
   (docs/providers.md).
2. **Stripe.** `POST /api/billing/checkout` returns 501. Wire Stripe Checkout
   there. The `checkout.session.completed` webhook calls
   `grant(db, ws, "purchase", micros, sessionId)`. Make it idempotent on the session
   id (add a unique column) because webhooks retry. Until then, an admin grants
   credits by hand from the Admin page.
3. **Free-credit abuse.** Free credits make sign-ups worth farming. The prototype
   caps sign-ups per IP (5/hour). Add email verification before the grant, and a
   captcha, before launch.
4. **Sales tax / VAT** on prepaid credits: Stripe Tax, or an accountant.
