import { useState, type FormEvent } from "react";
import { buildCore, CORE_FIELDS, CORE_LABELS, slugify, type CoreField, type CoreInput, type CorePatch } from "../lib/listing.ts";
import { errorText, FieldError, Notice } from "../ui.tsx";

/** Core listing fields. `slugLocked` once the listing has been published (the database refuses changes). */
export function CoreForm({ initial, slugLocked, autoSlug, submitLabel, onSave }: {
  initial: CoreInput;
  slugLocked?: boolean;
  /** Fill the slug from the name while the slug hasn't been edited (new drafts). */
  autoSlug?: boolean;
  submitLabel: string;
  onSave: (row: CorePatch) => Promise<string | void>;
}) {
  const [v, setV] = useState<CoreInput>(initial);
  const [slugTouched, setSlugTouched] = useState(!autoSlug);
  const [errors, setErrors] = useState<Partial<Record<CoreField, string>>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (f: CoreField, value: string) =>
    setV((x) => ({ ...x, [f]: value, ...(f === "name" && !slugTouched ? { slug: slugify(value) } : {}) }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const built = buildCore(v);
    if (!built.ok) {
      setErrors(built.errors);
      setMsg({ kind: "error", text: "Fix the highlighted fields. Nothing was saved." });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const text = await onSave(built.row);
      if (text) setMsg({ kind: "ok", text });
    } catch (err) {
      setMsg({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <div className="grid">
        {CORE_FIELDS.filter((f) => f !== "description").map((f) => (
          <label key={f}>
            {CORE_LABELS[f]}
            <input
              value={v[f]}
              disabled={f === "slug" && slugLocked}
              onChange={(e) => {
                if (f === "slug") setSlugTouched(true);
                set(f, e.target.value);
              }}
            />
            {f === "slug" && slugLocked && <span className="small muted">Fixed after publishing.</span>}
            {f === "place_id" && <span className="small muted">The only value ever taken from Google.</span>}
            <FieldError msg={errors[f]} />
          </label>
        ))}
      </div>
      <label>
        {CORE_LABELS.description} ({v.description.length}/500)
        <textarea value={v.description} onChange={(e) => set("description", e.target.value)} />
        <FieldError msg={errors.description} />
      </label>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div><button type="submit" disabled={busy}>{submitLabel}</button></div>
    </form>
  );
}
