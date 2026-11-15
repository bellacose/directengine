import { useCallback, useEffect, useState, type ReactNode } from "react";

/** Load async data with loading and error state; `reload` runs it again. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    fn().then((d) => live && setData(d), (e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, reload };
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Loading({ error }: { error?: string | null }) {
  return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>;
}

export function FieldError({ msg }: { msg?: string }) {
  return msg ? <span className="field-error" role="alert">{msg}</span> : null;
}

export function Notice({ kind, children }: { kind: "ok" | "error"; children: ReactNode }) {
  return <p className={kind === "ok" ? "ok" : "error"} role={kind === "error" ? "alert" : "status"}>{children}</p>;
}

/** Run an async action with a busy flag and a message. */
export function useAction(): {
  busy: boolean;
  msg: { kind: "ok" | "error"; text: string } | null;
  run: (fn: () => Promise<string | void>) => Promise<void>;
  setMsg: (m: { kind: "ok" | "error"; text: string } | null) => void;
} {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ kind: "ok", text });
    } catch (e) {
      setMsg({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, run, setMsg };
}

export const fmtDate = (d: string | null | undefined) => (d ? String(d).slice(0, 10) : "—");
