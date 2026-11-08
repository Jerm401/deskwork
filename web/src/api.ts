import { useCallback, useEffect, useState } from "react";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Deskwork": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data as T;
}

export const api = {
  get: <T,>(p: string) => request<T>("GET", p),
  post: <T,>(p: string, b: unknown = {}) => request<T>("POST", p, b),
  patch: <T,>(p: string, b: unknown) => request<T>("PATCH", p, b),
  del: <T,>(p: string) => request<T>("DELETE", p),
};

/** GET with reload, and optional polling. */
export function useGet<T>(path: string | null, pollMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    if (!path) return;
    api.get<T>(path).then(setData, (e: Error) => setError(e.message));
  }, [path]);
  useEffect(() => {
    reload();
    if (!pollMs) return;
    const t = setInterval(reload, pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs]);
  return { data, error, reload };
}

export const money = (micros: number) => {
  const usd = micros / 1e6;
  return Math.abs(usd) < 0.01 && usd !== 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
};

export interface Me { email: string; name: string; workspace: string; is_admin: boolean; balance_micros: number; mock: boolean }
export interface Item { id: string; title: string; status: string; priority: number; due_at: string | null; next_action: string; created_by: string }
export interface PageSummary { id: string; slug: string; title: string; icon: string; status: string; live_version: number | null; pending_version: number | null }
export interface FeatureRequest { id: string; text: string; page_id: string | null; status: string; result: string; cost_micros: number; created_at: string; version: number | null }
