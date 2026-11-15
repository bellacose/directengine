import { useMemo, useState, type FormEvent } from "react";
import { localToday, useApp } from "../context.ts";
import {
  CORE_KEYS, DAYS, FACT_STATE_LABELS, METHOD_LABELS, METHODS, factState, formatValue, inputFromValue,
  type CheckForm as Form, type Day, type DayInput, type FactDef, type FactInput,
} from "../lib/facts.ts";
import type { FactStatusRow } from "../lib/sites.ts";
import { errorText, FieldError, fmtDate, Notice } from "../ui.tsx";

export type SubmitResult = { ok: true; message: string } | { ok: false; errors: Record<string, string> };

interface Props {
  datasetId: string;
  factStatus: FactStatusRow[];
  /** Validate and send; returns form errors or a success message. */
  onSubmit: (form: Form, defs: FactDef[], existing: Set<string>) => Promise<SubmitResult>;
  /** Fix the method (claims are always owner_submitted). */
  fixedMethod?: (typeof METHODS)[number];
  /** Starting values to set, e.g. facts from a claim. Raw values; the reviewer still confirms each. */
  prefill?: Record<string, unknown>;
  submitLabel?: string;
}

/** Record a check: method, who, when, each fact with an input matching its type, note and evidence. */
export function CheckForm({ datasetId, factStatus, onSubmit, fixedMethod, prefill, submitLabel = "Record check" }: Props) {
  const { vocab, email } = useApp();
  const defs = useMemo(() => vocab.factDefs.filter((d) => d.dataset_id === datasetId), [vocab, datasetId]);
  const status = useMemo(() => new Map(factStatus.map((f) => [f.key, f])), [factStatus]);
  const existing = useMemo(() => new Set(factStatus.map((f) => f.key)), [factStatus]);

  const initial = (): Form => ({
    method: fixedMethod ?? "phone_call",
    checkedBy: email,
    checkedAt: localToday(),
    note: "",
    evidenceUrl: "",
    core: [],
    facts: Object.fromEntries(
      defs.map((d) => {
        const fromClaim = prefill && d.key in prefill;
        const input = inputFromValue(d.value_type, fromClaim ? prefill[d.key] : status.get(d.key)?.value);
        return [d.key, fromClaim ? { ...input, action: "set" } : input];
      }),
    ),
  });
  const [form, setForm] = useState<Form>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const setFact = (key: string, patch: Partial<FactInput>) =>
    setForm((f) => ({ ...f, facts: { ...f.facts, [key]: { ...f.facts[key], ...patch } } }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setDone(null);
    try {
      const r = await onSubmit(form, defs, existing);
      if (r.ok) {
        setErrors({});
        setDone(r.message);
      } else setErrors(r.errors);
    } catch (err) {
      setErrors({ form: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const groups = [...new Set(defs.map((d) => d.fact_group))];

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <div className="grid">
        <label>
          Method
          <select value={form.method} disabled={!!fixedMethod} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
          </select>
          <FieldError msg={errors.method} />
        </label>
        <label>
          Checked by
          <input value={form.checkedBy} onChange={(e) => setForm({ ...form, checkedBy: e.target.value })} />
          <FieldError msg={errors.checkedBy} />
        </label>
        <label>
          Date checked
          <input type="date" value={form.checkedAt} max={localToday()} onChange={(e) => setForm({ ...form, checkedAt: e.target.value })} />
          <FieldError msg={errors.checkedAt} />
        </label>
      </div>

      <fieldset className="panel">
        <legend>Core fields confirmed in this check</legend>
        <div className="row">
          {CORE_KEYS.map((k) => (
            <label key={k} className="inline">
              <input
                type="checkbox"
                checked={form.core.includes(k)}
                onChange={(e) => setForm({ ...form, core: e.target.checked ? [...form.core, k] : form.core.filter((x) => x !== k) })}
              />
              {k}
            </label>
          ))}
        </div>
      </fieldset>

      {groups.map((g) => (
        <fieldset key={g} className="panel">
          <legend>{g}</legend>
          {defs.filter((d) => d.fact_group === g).map((d) => (
            <FactRow
              key={d.key}
              def={d}
              input={form.facts[d.key]}
              row={status.get(d.key)}
              error={errors[d.key]}
              onChange={(patch) => setFact(d.key, patch)}
            />
          ))}
        </fieldset>
      ))}

      <label>
        Note
        <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </label>
      <label>
        Evidence URL (optional)
        <input type="url" value={form.evidenceUrl} onChange={(e) => setForm({ ...form, evidenceUrl: e.target.value })} placeholder="https://" />
        <FieldError msg={errors.evidenceUrl} />
      </label>
      {Object.keys(errors).length > 0 && (
        <Notice kind="error">{errors.form ?? "Fix the highlighted fields. Nothing was saved."}</Notice>
      )}
      {done && <Notice kind="ok">{done}</Notice>}
      <div><button type="submit" disabled={busy}>{submitLabel}</button></div>
    </form>
  );
}

function FactRow({ def, input, row, error, onChange }: {
  def: FactDef;
  input: FactInput;
  row: FactStatusRow | undefined;
  error?: string;
  onChange: (patch: Partial<FactInput>) => void;
}) {
  const state = factState(row);
  const has = !!row;
  const set = (patch: Partial<FactInput>) => onChange({ ...patch, action: "set" });
  return (
    <div className="fact">
      <div>
        <div>{def.label}</div>
        <div className="small muted">{def.key} · {def.value_type}</div>
        <div className="small">
          <span className={`badge ${state}`}>{FACT_STATE_LABELS[state]}</span>{" "}
          {row && <span className="muted">{formatValue(def.value_type, row.value)}{row.checked_at ? ` · ${fmtDate(row.checked_at)} ${row.method}` : ""}</span>}
        </div>
      </div>
      <select value={input.action} onChange={(e) => onChange({ action: e.target.value as FactInput["action"] })} aria-label={`${def.label}: action`}>
        <option value="keep">Not in this check</option>
        {has && <option value="confirm">Confirm as is</option>}
        <option value="set">{has ? "New value" : "Set value"}</option>
        {has && <option value="clear">Now unknown (delete)</option>}
      </select>
      <div>
        {(input.action === "set" || input.action === "keep") && <ValueInput def={def} input={input} onChange={set} />}
        <FieldError msg={error} />
      </div>
    </div>
  );
}

function ValueInput({ def, input, onChange }: { def: FactDef; input: FactInput; onChange: (patch: Partial<FactInput>) => void }) {
  const label = `${def.label}: value`;
  switch (def.value_type) {
    case "boolean":
      return (
        <select value={input.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} aria-label={label}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case "number":
      return <input inputMode="decimal" value={input.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} aria-label={label} />;
    case "time":
      return <input type="time" value={input.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} aria-label={label} />;
    case "url":
      return <input type="url" value={input.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} aria-label={label} placeholder="https://" />;
    case "text":
      return <input value={input.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} aria-label={label} />;
    case "hours":
      return <HoursInput days={input.days!} onChange={(days) => onChange({ days })} />;
  }
}

function HoursInput({ days, onChange }: { days: Record<Day, DayInput>; onChange: (d: Record<Day, DayInput>) => void }) {
  const set = (d: Day, patch: Partial<DayInput>) => onChange({ ...days, [d]: { ...days[d], ...patch } });
  return (
    <div className="hours">
      {DAYS.map((d) => (
        <div key={d} style={{ display: "contents" }}>
          <span>{d}</span>
          <select value={days[d].state} onChange={(e) => set(d, { state: e.target.value as DayInput["state"] })} aria-label={`${d} state`}>
            <option value="unknown">Not checked</option>
            <option value="closed">Closed</option>
            <option value="open">Open</option>
          </select>
          {days[d].state === "open" ? (
            <>
              <input type="time" value={days[d].open} onChange={(e) => set(d, { open: e.target.value })} aria-label={`${d} opens`} />
              <input type="time" value={days[d].close} onChange={(e) => set(d, { close: e.target.value })} aria-label={`${d} closes`} />
            </>
          ) : <span style={{ gridColumn: "span 2" }} />}
        </div>
      ))}
    </div>
  );
}
