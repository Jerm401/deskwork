# Deskwork

Multi-tenant AI secretary product, prototype stage. README.md explains it;
docs/security.md and docs/billing.md hold the reasoning that the code can't.

Non-negotiables when changing code:

- Every query on tenant data filters on the session's `workspaceId`. Never
  accept a workspace id from the client.
- Every model call goes through `meteredComplete` (server/llm.ts). No direct
  provider calls anywhere else.
- The ledger is append-only. Corrections are new rows.
- What a custom page can do is decided only in `bridgeCall` (server/pages.ts),
  against the approved version's permissions. Never loosen the frame CSP or add
  `allow-same-origin` to the sandbox. A new capability follows the checklist at
  the end of docs/security.md.
- Run `npm test` and `npm run typecheck` before committing.
