# From prototype to product

Done in the prototype: accounts and workspaces, the credit ledger and metering,
the secretary chat with queue tools, the feature-request → builder → review →
approve → live loop, versioning and rollback, the page sandbox and bridge, the
customer API keys and `/v1` gateway, and an admin page with margin per workspace.

## Must have before real customers

- Stripe top-ups (docs/billing.md), email verification, password reset.
- Real provider prices and a provider whose terms allow resale (docs/billing.md).
- Serve `/frame` from a separate domain (docs/security.md).
- Decide on self-navigation (docs/security.md, "Known gaps").
- Streaming chat replies (today a turn returns when it's done), and builds in a
  job queue that survives restarts (today a restart marks running builds failed).
- Backups of the SQLite db, or a move to Postgres once there's more than one server.
- Terms of service and a privacy policy. Customer data goes to the model provider.

## The Desk features to bring over

These made Jeremy's Desk useful, and each is a capability decision here, not a
copy-paste:

- Gmail and Calendar sync (OAuth per customer). Google requires app verification
  for restricted Gmail scopes, which includes a security assessment. Plan for weeks.
- Playbooks and knowledge (the agent's procedures and wiki), per workspace.
- Notifications (Web Push).
- A headless browser for the agent. Expensive and risky in multi-tenant; meter it
  separately.

## Ideas that fit the model

- A second-model review of each page version, charged as part of the build.
- Page templates: popular pages offered to new customers for free (no build cost).
- Team workspaces (`members` already supports more than one user).
