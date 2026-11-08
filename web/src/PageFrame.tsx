import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

// Runs one custom page. The frame is sandboxed twice: by the sandbox attribute
// here and by the CSP header on /frame (which also covers the URL opened in a
// tab). This component only relays bridge calls to the server, which decides
// them. It answers only the frame it created. If the page navigates itself
// (a second load event), the frame is killed and nothing more is answered.
// The first document posts before its own load event fires, so "before the
// second load" is the test; a navigated document can slip a call in before
// its load event, which gets it nothing the navigation URL couldn't already
// carry out (docs/security.md, "Self-navigation").
export function PageFrame({ pageId, mode = "live", version, title }: { pageId: string; mode?: "live" | "preview"; version?: number; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [height, setHeight] = useState(200);
  const [error, setError] = useState<string>();
  const [dead, setDead] = useState(false);
  const src = `/frame/pages/${encodeURIComponent(pageId)}${mode === "preview" ? `?mode=preview&v=${version}` : ""}`;

  useEffect(() => {
    loads.current = 0;
    setDead(false);
    setError(undefined);
  }, [src]);

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const frame = ref.current?.contentWindow;
      if (!frame || e.source !== frame || loads.current > 1) return;
      const m = (e.data ?? {}) as { dw?: string; id?: number; method?: string; args?: unknown; h?: number; message?: string };
      if (m.dw === "height" && typeof m.h === "number") setHeight(Math.min(Math.max(m.h, 60), 6000));
      else if (m.dw === "error") setError(m.message);
      else if (m.dw === "call" && typeof m.id === "number" && typeof m.method === "string") {
        try {
          const r = await api.post<{ value: unknown }>(`/pages/${pageId}/bridge`, { mode, version, method: m.method, args: m.args });
          if (loads.current <= 1) frame.postMessage({ dw: "result", id: m.id, ok: true, value: r.value }, "*");
        } catch (err) {
          if (loads.current <= 1) frame.postMessage({ dw: "result", id: m.id, ok: false, error: (err as Error).message }, "*");
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pageId, mode, version]);

  if (dead) return <p className="error">This page tried to leave its sandbox and was stopped. Ask for it to be rebuilt.</p>;
  return (
    <>
      <iframe
        ref={ref}
        src={src}
        title={title}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className="page-frame"
        style={{ height }}
        onLoad={() => {
          loads.current += 1;
          if (loads.current > 1) setDead(true);
        }}
      />
      {error && <p className="error small">Page error: {error}</p>}
    </>
  );
}
