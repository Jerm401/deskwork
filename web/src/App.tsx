import { type FormEvent, useEffect, useState } from "react";
import { api, type FeatureRequest, type Item, type Me, money, type PageSummary, useGet } from "./api.ts";
import { PageFrame } from "./PageFrame.tsx";

type View = { name: "desk" } | { name: "page"; id: string } | { name: "review"; id: string; version?: number } | { name: "requests" } | { name: "billing" } | { name: "keys" } | { name: "admin" };

export function App() {
  const { data: me, error, reload } = useGet<Me>("/me", 15000);
  if (error && !me) return <Auth onDone={reload} />;
  if (!me) return null;
  return <Shell me={me} reloadMe={reload} />;
}

function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [err, setErr] = useState<string>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.post(`/auth/${mode}`, Object.fromEntries(f));
      location.reload();
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  return (
    <div className="auth">
      <h1>Deskwork</h1>
      <p className="muted">An AI secretary that does the work, and builds the tools you ask for.</p>
      <form onSubmit={submit}>
        {mode === "signup" && <input name="name" placeholder="Your name" />}
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password (10+ characters)" required />
        <button className="primary">{mode === "signup" ? "Create account. Free credits included" : "Sign in"}</button>
        {err && <p className="error">{err}</p>}
      </form>
      <button className="link" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>
        {mode === "signup" ? "Have an account? Sign in" : "New here? Create an account"}
      </button>
    </div>
  );
}

function Shell({ me, reloadMe }: { me: Me; reloadMe: () => void }) {
  const [view, setView] = useState<View>({ name: "desk" });
  const { data: pages, reload: reloadPages } = useGet<PageSummary[]>("/pages", 10000);
  const pending = pages?.filter((p) => p.pending_version) ?? [];
  const live = pages?.filter((p) => p.status === "live") ?? [];
  const refresh = () => { reloadPages(); reloadMe(); };
  return (
    <div className="shell">
      <nav>
        <div className="brand">Deskwork<span className="muted small">{me.workspace}</span></div>
        <button className={view.name === "desk" ? "on" : ""} onClick={() => setView({ name: "desk" })}>🗂️ Desk</button>
        {live.map((p) => (
          <button key={p.id} className={view.name === "page" && view.id === p.id ? "on" : ""} onClick={() => setView({ name: "page", id: p.id })}>
            {p.icon || "▫️"} {p.title}
          </button>
        ))}
        <hr />
        <button className={view.name === "requests" ? "on" : ""} onClick={() => setView({ name: "requests" })}>✨ Ask for a feature</button>
        {pending.map((p) => (
          <button key={p.id} className="review" onClick={() => setView({ name: "review", id: p.id, version: p.pending_version! })}>
            👀 Review: {p.title}
          </button>
        ))}
        <hr />
        <button className={view.name === "billing" ? "on" : ""} onClick={() => setView({ name: "billing" })}>
          💳 Credits <b className={me.balance_micros < 100_000 ? "low" : ""}>{money(me.balance_micros)}</b>
        </button>
        <button className={view.name === "keys" ? "on" : ""} onClick={() => setView({ name: "keys" })}>🔑 API keys</button>
        {me.is_admin && <button className={view.name === "admin" ? "on" : ""} onClick={() => setView({ name: "admin" })}>🛠️ Admin</button>}
        <div className="grow" />
        {me.mock && <p className="small warn">Demo mode: no model key, canned AI replies.</p>}
        <button className="small" onClick={() => api.post("/auth/logout").then(() => location.reload())}>Sign out {me.email}</button>
      </nav>
      <main>
        {view.name === "desk" && <Desk onChange={refresh} />}
        {view.name === "page" && <LivePage id={view.id} onEdit={() => setView({ name: "requests" })} onChange={refresh} />}
        {view.name === "requests" && <Requests pages={pages ?? []} onOpen={(id, version) => setView({ name: "review", id, version })} onChange={refresh} />}
        {view.name === "review" && <Review id={view.id} version={view.version} onDone={(id) => { refresh(); setView(id ? { name: "page", id } : { name: "desk" }); }} />}
        {view.name === "billing" && <Billing />}
        {view.name === "keys" && <Keys />}
        {view.name === "admin" && <Admin />}
      </main>
    </div>
  );
}

function Desk({ onChange }: { onChange: () => void }) {
  const { data: items, reload } = useGet<Item[]>("/items", 10000);
  const [title, setTitle] = useState("");
  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await api.post("/items", { title });
    setTitle("");
    reload();
  }
  return (
    <div className="desk">
      <section>
        <h1>Your desk</h1>
        <form onSubmit={add} className="row">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" />
          <button className="primary">Add</button>
        </form>
        <ul className="items">
          {items?.map((i) => (
            <li key={i.id} className={i.status}>
              <input type="checkbox" checked={i.status === "done"} onChange={() => api.patch(`/items/${i.id}`, { status: i.status === "done" ? "open" : "done" }).then(reload)} />
              <span className={`p${i.priority}`}>{i.title}</span>
              {i.next_action && <span className="muted small"> · {i.next_action}</span>}
              {i.created_by !== "user" && <span className="tag">{i.created_by.startsWith("page:") ? "page" : "AI"}</span>}
            </li>
          ))}
          {items?.length === 0 && <li className="muted">Nothing on your desk.</li>}
        </ul>
      </section>
      <Chat onChange={() => { reload(); onChange(); }} />
    </div>
  );
}

function Chat({ onChange }: { onChange: () => void }) {
  const { data, reload } = useGet<{ role: string; content: string }[]>("/chat");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.post("/chat", { text });
      setText("");
    } catch (x) {
      setErr((x as Error).message);
    }
    setBusy(false);
    reload();
    onChange();
  }
  return (
    <section className="chat">
      <h2>Secretary</h2>
      <div className="log">
        {data?.map((m, i) => <p key={i} className={m.role}>{m.content}</p>)}
        {busy && <p className="assistant muted">Working…</p>}
      </div>
      <form onSubmit={send} className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask your secretary…" disabled={busy} />
        <button className="primary" disabled={busy}>Send</button>
      </form>
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function LivePage({ id, onEdit, onChange }: { id: string; onEdit: () => void; onChange: () => void }) {
  const { data: page } = useGet<PageSummary & { versions: { version: number; status: string; summary: string; approved_at: string }[] }>(`/pages/${id}`);
  if (!page) return null;
  return (
    <div>
      <div className="page-head">
        <h1>{page.icon} {page.title}</h1>
        <span className="muted small">v{page.live_version}</span>
        <div className="grow" />
        <button onClick={onEdit}>Ask for a change</button>
        <button onClick={() => confirm("Turn this page off? Its data is kept.") && api.post(`/pages/${id}/disable`).then(onChange)}>Turn off</button>
      </div>
      <PageFrame key={`${id}:${page.live_version}`} pageId={id} title={page.title} />
    </div>
  );
}

function Requests({ pages, onOpen, onChange }: { pages: PageSummary[]; onOpen: (id: string, v?: number) => void; onChange: () => void }) {
  const { data: reqs, reload } = useGet<FeatureRequest[]>("/requests", 3000);
  const [text, setText] = useState("");
  const [pageId, setPageId] = useState("");
  const [err, setErr] = useState<string>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(undefined);
    try {
      await api.post("/requests", { text, page_id: pageId || undefined });
      setText("");
      reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  useEffect(onChange, [reqs?.map((r) => r.status).join()]); // a finished build adds a review link
  return (
    <div className="narrow">
      <h1>Ask for a feature</h1>
      <p className="muted">Describe a page you'd like on your dashboard: a tracker, a log, a calculator, a view of your tasks. The AI builds it, and you review it before it goes live. Building uses credits.</p>
      <form onSubmit={submit} className="stack">
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. A mileage log for client visits, with a monthly total and a button to add a reimbursement task." />
        <div className="row">
          <select value={pageId} onChange={(e) => setPageId(e.target.value)}>
            <option value="">A new page</option>
            {pages.map((p) => <option key={p.id} value={p.id}>Change "{p.title}"</option>)}
          </select>
          <button className="primary" disabled={!text.trim()}>Build it</button>
        </div>
        {err && <p className="error">{err}</p>}
      </form>
      <h2>Requests</h2>
      <table>
        <tbody>
          {reqs?.map((r) => (
            <tr key={r.id}>
              <td>{r.text}<div className="muted small">{r.result}</div></td>
              <td><span className={`status ${r.status}`}>{r.status}</span></td>
              <td className="num">{money(r.cost_micros)}</td>
              <td>{r.page_id && r.version && <button onClick={() => onOpen(r.page_id!, r.version!)}>Open</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Review({ id, version, onDone }: { id: string; version?: number; onDone: (liveId?: string) => void }) {
  const { data: page } = useGet<PageSummary & { versions: { version: number; status: string; summary: string }[] }>(`/pages/${id}`);
  const v = version ?? page?.versions[0]?.version;
  const { data: ver } = useGet<{ version: number; html: string; permissions: string[]; summary: string; status: string }>(v ? `/pages/${id}/versions/${v}` : null);
  const { data: labels } = useGet<Record<string, string>>("/permissions");
  const [showCode, setShowCode] = useState(false);
  const [err, setErr] = useState<string>();
  if (!page || !ver) return null;
  const act = (what: "approve" | "reject" | "rollback") =>
    api.post(`/pages/${id}/versions/${ver.version}/${what}`).then(() => onDone(what === "reject" ? undefined : id), (e: Error) => setErr(e.message));
  return (
    <div>
      <div className="page-head">
        <h1>Review: {page.icon} {page.title}</h1>
        <span className="muted small">version {ver.version} · {ver.status}</span>
      </div>
      <div className="review-box">
        <p>{ver.summary}</p>
        <p><b>This page asks to:</b></p>
        <ul>
          <li>Keep its own data</li>
          {ver.permissions.map((p) => <li key={p}>{labels?.[p] ?? p}</li>)}
        </ul>
        <p className="muted small">It can't reach the internet, your email, or other pages. The preview below uses throwaway data and can't change your tasks.</p>
        <div className="row">
          {ver.status === "pending" && <button className="primary" onClick={() => act("approve")}>Approve and go live</button>}
          {ver.status === "pending" && <button onClick={() => act("reject")}>Reject</button>}
          {ver.status === "approved" && page.live_version !== ver.version && <button onClick={() => act("rollback")}>Roll back to this version</button>}
          <button onClick={() => setShowCode(!showCode)}>{showCode ? "Hide" : "Show"} code</button>
        </div>
        {err && <p className="error">{err}</p>}
      </div>
      {showCode && <pre className="code">{ver.html}</pre>}
      <h2>Preview</h2>
      <PageFrame key={`${id}:${ver.version}`} pageId={id} mode="preview" version={ver.version} title={page.title} />
      <h2>History</h2>
      <ul className="small">
        {page.versions.map((x) => <li key={x.version}>v{x.version} · {x.status}{x.version === page.live_version ? " (live)" : ""} · {x.summary}</li>)}
      </ul>
    </div>
  );
}

function Billing() {
  const { data } = useGet<{ balance_micros: number; by_source: { source: string; calls: number; charge_micros: number }[]; recent: { id: string; source: string; model: string; input_tokens: number; output_tokens: number; charge_micros: number; created_at: string }[]; ledger: { kind: string; amount_micros: number; note: string; created_at: string }[] }>("/billing");
  const { data: pricing } = useGet<{ models: { id: string; label: string; inputPerM: number; outputPerM: number }[] }>("/pricing");
  const [msg, setMsg] = useState<string>();
  if (!data) return null;
  return (
    <div className="narrow">
      <h1>Credits</h1>
      <p className="big">{money(data.balance_micros)}</p>
      <button className="primary" onClick={() => api.post("/billing/checkout").catch((e: Error) => setMsg(e.message))}>Add credits</button>
      {msg && <p className="muted">{msg}</p>}
      <h2>Last 30 days</h2>
      <table><tbody>{data.by_source.map((s) => <tr key={s.source}><td>{s.source}</td><td className="num">{s.calls} calls</td><td className="num">{money(s.charge_micros)}</td></tr>)}</tbody></table>
      <h2>Prices</h2>
      <table>
        <thead><tr><th>Model</th><th className="num">Input / 1M tokens</th><th className="num">Output / 1M tokens</th></tr></thead>
        <tbody>{pricing?.models.map((m) => <tr key={m.id}><td>{m.label}</td><td className="num">${m.inputPerM}</td><td className="num">${m.outputPerM}</td></tr>)}</tbody>
      </table>
      <h2>Recent calls</h2>
      <table>
        <tbody>{data.recent.map((u) => <tr key={u.id}><td className="small">{new Date(u.created_at).toLocaleString()}</td><td>{u.source}</td><td className="small">{u.model}</td><td className="num small">{u.input_tokens}/{u.output_tokens}</td><td className="num">{money(u.charge_micros)}</td></tr>)}</tbody>
      </table>
      <h2>Credits added</h2>
      <table><tbody>{data.ledger.map((l, i) => <tr key={i}><td className="small">{new Date(l.created_at).toLocaleDateString()}</td><td>{l.kind}</td><td>{l.note}</td><td className="num">{money(l.amount_micros)}</td></tr>)}</tbody></table>
    </div>
  );
}

function Keys() {
  const { data: keys, reload } = useGet<{ id: string; name: string; prefix: string; last_used_at: string | null; revoked_at: string | null }[]>("/keys");
  const [fresh, setFresh] = useState<string>();
  const [name, setName] = useState("");
  return (
    <div className="narrow">
      <h1>API keys</h1>
      <p className="muted">Use your credits from your own tools. The endpoint is OpenAI-compatible: base URL <code>{location.origin}/v1</code>. Calls are charged at the prices on the Credits page.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); api.post<{ key: string }>("/keys", { name }).then((k) => { setFresh(k.key); setName(""); reload(); }); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. laptop" />
        <button className="primary">Create key</button>
      </form>
      {fresh && <p className="review-box">Copy this now; it won't be shown again:<br /><code>{fresh}</code></p>}
      <table><tbody>{keys?.map((k) => (
        <tr key={k.id}><td>{k.name}</td><td><code>{k.prefix}…</code></td><td className="small muted">{k.revoked_at ? "revoked" : k.last_used_at ? `used ${new Date(k.last_used_at).toLocaleDateString()}` : "never used"}</td>
          <td>{!k.revoked_at && <button onClick={() => api.del(`/keys/${k.id}`).then(reload)}>Revoke</button>}</td></tr>
      ))}</tbody></table>
    </div>
  );
}

function Admin() {
  const { data, reload } = useGet<{ id: string; name: string; owner_email: string; balance_micros: number; revenue_micros: number; cost_micros: number }[]>("/admin/workspaces");
  return (
    <div>
      <h1>Admin</h1>
      <table>
        <thead><tr><th>Workspace</th><th>Owner</th><th className="num">Balance</th><th className="num">Charged</th><th className="num">Our cost</th><th className="num">Margin</th><th /></tr></thead>
        <tbody>{data?.map((w) => (
          <tr key={w.id}><td>{w.name}</td><td>{w.owner_email}</td><td className="num">{money(w.balance_micros)}</td><td className="num">{money(w.revenue_micros)}</td><td className="num">{money(w.cost_micros)}</td><td className="num">{money(w.revenue_micros - w.cost_micros)}</td>
            <td><button onClick={() => { const usd = prompt("Grant how many dollars of credit?"); if (usd) api.post(`/admin/workspaces/${w.id}/grant`, { usd: Number(usd), note: "manual" }).then(reload, (e: Error) => alert(e.message)); }}>Grant</button></td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}
