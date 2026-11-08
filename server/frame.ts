// The document a custom page runs in. Served from /frame/pages/:id with the
// CSP below as an HTTP header, so the sandbox holds even if someone opens the
// frame URL directly in a tab. Move /frame to its own domain in production
// (docs/security.md, "Separate origin").

export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  // No allow-same-origin: the frame gets an opaque origin.
  "sandbox allow-scripts allow-forms",
].join("; ");

export const FRAME_HEADERS: Record<string, string> = {
  "Content-Security-Policy": FRAME_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
};

const BASE_CSS = `
:root{color-scheme:dark;--fg:#ecebe6;--muted:#a3a093;--line:#3f3e39;--soft:rgba(255,255,255,.06);--accent:#7aa7ff;--accent-strong:#3b74e6;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;}
html,body{margin:0;padding:0;background:transparent;color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
body{padding:12px 14px;}*{box-sizing:border-box;}
h1{font-size:19px;margin:0 0 10px;}h2{font-size:15px;margin:16px 0 6px;}
table{border-collapse:collapse;width:100%;}th,td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--line);}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;}
.muted{color:var(--muted);}.small{font-size:12.5px;}
.card{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 10px;}
input,select,textarea,button{font:inherit;color:var(--fg);background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:5px 9px;}
button{cursor:pointer;}button.primary{background:var(--accent-strong);border-color:var(--accent-strong);color:#fff;}
`;

// The `desk` object. Every method is a message to the dashboard, which passes
// it to the server. Nothing here is trusted: the server checks every call.
const BRIDGE = `
(function(){
  var seq = 0, waiting = {}, post = window.parent.postMessage.bind(window.parent);
  function call(method, args) {
    var id = ++seq;
    return new Promise(function (ok, fail) {
      waiting[id] = { ok: ok, fail: fail };
      post({ dw: "call", id: id, method: method, args: args || {} }, "*");
    });
  }
  window.desk = Object.freeze({
    storage: Object.freeze({
      get: function (key) { return call("storage.get", { key: key }); },
      set: function (key, value) { return call("storage.set", { key: key, value: value }); },
      keys: function () { return call("storage.keys"); },
      delete: function (key) { return call("storage.delete", { key: key }); },
    }),
    items: Object.freeze({
      list: function () { return call("items.list"); },
      create: function (title, notes) { return call("items.create", { title: title, notes: notes }); },
      complete: function (id) { return call("items.complete", { id: id }); },
    }),
    ai: Object.freeze({ ask: function (prompt) { return call("ai.ask", { prompt: prompt }).then(function (r) { return r.text; }); } }),
  });
  addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data || {};
    if (m.dw === "result" && waiting[m.id]) {
      var w = waiting[m.id]; delete waiting[m.id];
      m.ok ? w.ok(m.value) : w.fail(new Error(m.error));
    }
  });
  function report(msg) { post({ dw: "error", message: String(msg).slice(0, 500) }, "*"); }
  addEventListener("error", function (e) { report((e.error && e.error.message) || e.message); });
  addEventListener("unhandledrejection", function (e) { report((e.reason && e.reason.message) || e.reason); });
  function size() { post({ dw: "height", h: Math.ceil(document.documentElement.scrollHeight) }, "*"); }
  addEventListener("load", function () { size(); new ResizeObserver(size).observe(document.body); });
})();
`;

export function frameDocument(html: string, title: string): string {
  const safeTitle = title.replace(/[<>&"]/g, "");
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<title>${safeTitle}</title>`,
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<style>${BASE_CSS}</style>`,
    `<script>${BRIDGE}</script>`,
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

/** What the builder model is told about the runtime. Keep in step with BRIDGE and pages.ts. */
export const PAGE_RUNTIME_GUIDE = `
A page is an HTML fragment (no <html>, <head> or <body> tags) with inline <style> and <script>.
It runs in a locked sandbox:
- No network at all: no fetch, XMLHttpRequest, WebSocket, external scripts, images, fonts, or links to load. No URLs in the code.
- No cookies, localStorage, sessionStorage or IndexedDB. No location, window.open, parent, top, eval, new Function, postMessage, atob or escaped/encoded strings.
- Images only as inline SVG or data: URLs.
The page talks to the product only through the global \`desk\` object; every method returns a Promise:
- desk.storage.get(key) / desk.storage.set(key, value) / desk.storage.keys() / desk.storage.delete(key)
  The page's own JSON storage. Always available. Limits: 200 keys, 64 KB per value, 1 MB total.
- desk.items.list() -> open tasks [{id,title,status,priority,due_at,next_action}]   (needs permission "items:read")
- desk.items.create(title, notes?) / desk.items.complete(id)                          (needs "items:write")
- desk.ai.ask(prompt) -> text. Each call costs the customer credits; capped per day.   (needs "ai")
Ask only for the permissions the page really uses; the customer sees and approves the list.
Styling: the page sits on a dark background. CSS variables: --fg --muted --line --soft --accent --accent-strong --ok --warn --bad.
Classes: .card .muted .small, button.primary. Tables, inputs and buttons are pre-styled.
Handle errors from desk calls (show a message), and render something useful when storage is empty.
`.trim();
