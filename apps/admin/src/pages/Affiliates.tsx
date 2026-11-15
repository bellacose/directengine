import { useState } from "react";
import { localToday, useApp } from "../context.ts";
import {
  AFFILIATE_STATUSES, loadAffiliates, siteAffiliateErrors, supplierNoteErrors, updateSiteAffiliate, updateSupplierNotes,
  type ProgramRow, type SiteAffiliateRow, type SiteRow,
} from "../lib/api.ts";
import { FieldError, fmtDate, Loading, Notice, useAction, useLoad } from "../ui.tsx";

/**
 * Per-site approval status and tracking link (networks approve each website separately), and each
 * supplier's cutoff and price notes, read off its own site, with the date they were read.
 * Rows appear here once `sync-sites` has created them from sites/*.json.
 */
export function Affiliates() {
  const { db } = useApp();
  const { data, error, reload } = useLoad(() => loadAffiliates(db), [db]);
  if (!data) return <Loading error={error} />;
  const program = new Map(data.programs.map((p) => [p.id, p]));

  return (
    <>
      <h1>Affiliates</h1>
      {!data.sites.length && <p className="muted">No sites in the database yet. Run <code>npm run sync-sites</code>.</p>}
      {data.sites.map((s) => (
        <section key={s.id}>
          <h2>{s.name} <span className="muted small">{s.domain ?? "no domain yet"}</span></h2>
          {!data.links.some((l) => l.site_id === s.id) ? <p className="muted">No affiliate programs in this site's config.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Program</th><th>Placements</th><th>Status</th><th>Tracking link</th><th /></tr></thead>
              <tbody>
                {data.links
                  .filter((l) => l.site_id === s.id)
                  .sort((a, b) => (program.get(a.program_id)?.name ?? "").localeCompare(program.get(b.program_id)?.name ?? ""))
                  .map((l) => <LinkRow key={l.program_id} site={s} link={l} program={program.get(l.program_id)!} onSaved={reload} />)}
              </tbody>
            </table>
          </div>
          )}
        </section>
      ))}

      <h2>Supplier notes (ship-to-you pages)</h2>
      <p className="small muted">Read the cutoff and price off the supplier's own site, and enter the date you read them.</p>
      {data.programs.map((p) => <SupplierNotes key={p.id} program={p} onSaved={reload} />)}
    </>
  );
}

function LinkRow({ site, link, program, onSaved }: { site: SiteRow; link: SiteAffiliateRow; program: ProgramRow; onSaved: () => void }) {
  const { db } = useApp();
  const [status, setStatus] = useState<string>(link.status);
  const [url, setUrl] = useState(link.url ?? "");
  const action = useAction();
  const errs = siteAffiliateErrors(status, url);
  const changed = status !== link.status || url !== (link.url ?? "");

  return (
    <tr>
      <td>
        {program.name}
        {program.program_url && <div className="small"><a href={program.program_url} target="_blank" rel="noreferrer noopener">program page</a></div>}
        {program.commission_note && <div className="small muted">{program.commission_note}</div>}
      </td>
      <td className="small">{link.placements.join(", ") || "—"}</td>
      <td>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={`${program.name} status on ${site.name}`}>
          {AFFILIATE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </td>
      <td>
        <input type="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} aria-label={`${program.name} link on ${site.name}`} />
        {changed && <FieldError msg={errs.join(" ")} />}
        {action.msg && <Notice kind={action.msg.kind}>{action.msg.text}</Notice>}
      </td>
      <td>
        <button
          disabled={!changed || errs.length > 0 || action.busy}
          onClick={() => action.run(async () => {
            await updateSiteAffiliate(db, site.id, program.id, status, url);
            onSaved();
            return "Saved.";
          })}
        >
          Save
        </button>
      </td>
    </tr>
  );
}

function SupplierNotes({ program, onSaved }: { program: ProgramRow; onSaved: () => void }) {
  const { db } = useApp();
  const [cutoff, setCutoff] = useState(program.cutoff_note ?? "");
  const [price, setPrice] = useState(program.price_note ?? "");
  const [checkedAt, setCheckedAt] = useState(program.facts_checked_at ? String(program.facts_checked_at).slice(0, 10) : "");
  const action = useAction();
  const errs = supplierNoteErrors(cutoff, price, checkedAt, localToday());

  return (
    <div className="panel">
      <strong>{program.name}</strong> <span className="small muted">checked {fmtDate(program.facts_checked_at)}</span>
      <div className="grid">
        <label>Cutoff note<input value={cutoff} onChange={(e) => setCutoff(e.target.value)} /></label>
        <label>Price note<input value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label>Date read<input type="date" max={localToday()} value={checkedAt} onChange={(e) => setCheckedAt(e.target.value)} /></label>
      </div>
      <FieldError msg={errs.join(" ")} />
      {action.msg && <Notice kind={action.msg.kind}>{action.msg.text}</Notice>}
      <button
        disabled={errs.length > 0 || action.busy}
        onClick={() => action.run(async () => {
          await updateSupplierNotes(db, program.id, cutoff, price, checkedAt, localToday());
          onSaved();
          return "Saved.";
        })}
      >
        Save notes
      </button>
    </div>
  );
}
