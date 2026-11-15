import { useState } from "react";
import { localToday, useApp } from "../context.ts";
import {
  asCoreListing, createDraft, getListing, recordCheck, setCapabilities, setListingStatus, setMetros, updateListing,
  type ListingDetail,
} from "../lib/api.ts";
import { FACT_STATE_LABELS, METHOD_LABELS, factState, formatValue, type Method } from "../lib/facts.ts";
import { coreFromRow, emptyCore, type ListingRow } from "../lib/listing.ts";
import { siteCoverage } from "../lib/sites.ts";
import { SITE_CONFIGS } from "../siteConfigs.ts";
import { fmtDate, Loading, Notice, useAction, useLoad } from "../ui.tsx";
import { CheckForm } from "./CheckForm.tsx";
import { CoreForm } from "./CoreForm.tsx";

export function ListingPage({ id }: { id: string | null }) {
  return id ? <EditListing id={id} /> : <NewListing />;
}

function NewListing() {
  const { db, vocab } = useApp();
  const [dataset, setDataset] = useState(vocab.datasets[0]?.id ?? "");
  return (
    <>
      <h1>New draft listing</h1>
      <p className="muted">Fill this from the shop's own website or a call. Never copy details from Google Maps.</p>
      {vocab.datasets.length > 1 && (
        <label>
          Dataset
          <select value={dataset} onChange={(e) => setDataset(e.target.value)}>
            {vocab.datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      )}
      <CoreForm
        initial={emptyCore()}
        autoSlug
        submitLabel="Create draft"
        onSave={async (row) => {
          const l = await createDraft(db, dataset, row);
          window.location.hash = `#/listing/${l.id}`;
        }}
      />
    </>
  );
}

function EditListing({ id }: { id: string }) {
  const { db } = useApp();
  const { data, error, reload } = useLoad(async () => ({ d: await getListing(db, id) }), [db, id]);
  if (!data) return <Loading error={error} />;
  if (!data.d) return <p className="error">Listing not found.</p>;
  return <ListingView d={data.d} reload={reload} />;
}

function ListingView({ d, reload }: { d: ListingDetail; reload: () => void }) {
  const { db, vocab } = useApp();
  const l = d.listing;
  const status = useAction();
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const dataset = vocab.datasets.find((x) => x.id === l.dataset_id);
  const defs = vocab.factDefs.filter((f) => f.dataset_id === l.dataset_id);

  const changeStatus = (to: ListingRow["status"], done: string) =>
    status.run(async () => {
      await setListingStatus(db, l.id, to);
      reload();
      return done;
    });

  return (
    <>
      <p><a href="#/listings">← Listings</a></p>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{l.name} <span className={`badge ${l.status}`}>{l.status}</span></h1>
        <div className="row">
          {l.status !== "published" && (
            <button disabled={status.busy} onClick={() => changeStatus("published", "Published. Sites pick it up on their next build.")}>Publish</button>
          )}
          {l.status === "published" && (
            <button className="secondary" disabled={status.busy} onClick={() => changeStatus("draft", "Unpublished: back to draft.")}>Unpublish</button>
          )}
          {l.status === "removed" && (
            <button className="secondary" disabled={status.busy} onClick={() => changeStatus("draft", "Restored as a draft.")}>Restore as draft</button>
          )}
          {l.status !== "removed" && (
            <button className="danger" disabled={status.busy} onClick={() => changeStatus("removed", "Marked removed. It disappears from every site.")}>Mark removed</button>
          )}
        </div>
      </div>
      <p className="muted small">
        {dataset?.name} · slug {l.slug} · last checked {fmtDate(l.last_verified_at)} · updated {fmtDate(l.updated_at)}
        {l.claimed_email && <> · claimed by {l.claimed_email} on {fmtDate(l.claimed_at)}</>}
      </p>
      {status.msg && <Notice kind={status.msg.kind}>{status.msg.text}</Notice>}

      <h2>On sites</h2>
      <Coverage d={d} />

      <h2>Facts</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Fact</th><th>Value</th><th>State</th><th>Checked</th></tr></thead>
          <tbody>
            {defs.map((def) => {
              const row = d.factStatus.find((f) => f.key === def.key);
              const st = factState(row);
              return (
                <tr key={def.key}>
                  <td>{def.label}<div className="small muted">{def.fact_group}</div></td>
                  <td>{row ? formatValue(def.value_type, row.value) : ""}</td>
                  <td><span className={`badge ${st}`}>{FACT_STATE_LABELS[st]}</span></td>
                  <td>{row?.checked_at ? `${fmtDate(row.checked_at)} · ${METHOD_LABELS[row.method as Method] ?? row.method}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Core fields last confirmed:{" "}
        {["name", "address", "phone", "website", "capabilities", "metros"]
          .map((k) => `${k} ${fmtDate(d.keyChecks.find((c) => c.key === k)?.checked_at)}`)
          .join(" · ")}
      </p>

      <h2>Record a check</h2>
      <div className="panel">
        {checkMsg && <Notice kind="ok">{checkMsg}</Notice>}
        <CheckForm
          key={d.checks.length}
          datasetId={l.dataset_id}
          factStatus={d.factStatus}
          onSubmit={async (form, defs, existing) => {
            const r = await recordCheck(db, l.id, form, defs, existing, localToday());
            if (!r.ok) return r;
            setCheckMsg(`Check recorded on ${form.checkedAt}.`);
            reload();
            return { ok: true, message: "Check recorded." };
          }}
        />
      </div>

      <h2>Details</h2>
      <div className="panel">
        <CoreForm
          key={l.updated_at}
          initial={coreFromRow(l)}
          slugLocked={!!l.published_at}
          submitLabel="Save details"
          onSave={async (row) => {
            await updateListing(db, l.id, row);
            reload();
            return "Saved. Confirm changed details in your next check.";
          }}
        />
      </div>

      <h2>Capabilities and metros</h2>
      <TagsForm d={d} reload={reload} />

      <h2>Check history</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Method</th><th>By</th><th>Keys</th><th>Note</th></tr></thead>
          <tbody>
            {d.checks.map((c) => (
              <tr key={c.id}>
                <td>{fmtDate(c.checked_at)}</td>
                <td>{METHOD_LABELS[c.method as Method] ?? c.method}</td>
                <td>{c.checked_by}</td>
                <td className="small">{c.fact_keys.join(", ")}</td>
                <td className="small">
                  {c.note}
                  {c.evidence_url && <> <a href={c.evidence_url} target="_blank" rel="noreferrer noopener">evidence</a></>}
                </td>
              </tr>
            ))}
            {!d.checks.length && <tr><td colSpan={5} className="muted">No checks yet. A listing needs one before it can be published.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Coverage({ d }: { d: ListingDetail }) {
  const { vocab } = useApp();
  const dataset = vocab.datasets.find((x) => x.id === d.listing.dataset_id)?.slug ?? "";
  const cov = siteCoverage(SITE_CONFIGS, dataset, asCoreListing(d, vocab));
  if (!cov.length) return <p className="muted">No site uses this dataset.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Site</th><th>Includes it</th><th>Own shop page</th><th>Verified angle facts</th></tr></thead>
        <tbody>
          {cov.map((c) => (
            <tr key={c.slug}>
              <td>{c.name}<div className="small muted">{c.slug} · {c.status}</div></td>
              <td>
                {c.included ? <span className="badge yes">Yes</span>
                  : c.matchesFilter ? <span className="badge draft">Once published</span>
                  : <span className="muted">No (outside its filter)</span>}
              </td>
              <td>
                {c.detailPage ? <span className="badge yes">{c.included ? "Yes" : "Once published"}</span>
                  : c.matchesFilter ? <span className="muted">No, lists only</span> : "—"}
              </td>
              <td>{c.matchesFilter ? `${c.angleFactCount} of ${c.minFacts} needed` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TagsForm({ d, reload }: { d: ListingDetail; reload: () => void }) {
  const { db, vocab } = useApp();
  const l = d.listing;
  const caps = vocab.capabilities.filter((c) => c.dataset_id === l.dataset_id);
  const metros = vocab.metros.filter((m) => m.dataset_id === l.dataset_id);
  const [capIds, setCapIds] = useState(d.capabilityIds);
  const [metroIds, setMetroIds] = useState(d.metros.map((m) => m.metro_id));
  const [primary, setPrimary] = useState<string | null>(d.metros.find((m) => m.is_primary)?.metro_id ?? null);
  const action = useAction();
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));

  return (
    <div className="panel stack">
      <fieldset>
        <legend>Capabilities</legend>
        <div className="row">
          {caps.map((c) => (
            <label key={c.id} className="inline">
              <input type="checkbox" checked={capIds.includes(c.id)} onChange={(e) => setCapIds(toggle(capIds, c.id, e.target.checked))} />
              {c.name}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Metros (choose a primary)</legend>
        {metros.map((m) => (
          <div key={m.id} className="row">
            <label className="inline">
              <input
                type="checkbox"
                checked={metroIds.includes(m.id)}
                onChange={(e) => {
                  setMetroIds(toggle(metroIds, m.id, e.target.checked));
                  if (!e.target.checked && primary === m.id) setPrimary(null);
                }}
              />
              {m.name}, {m.state}
            </label>
            <label className="inline small">
              <input type="radio" name="primary" disabled={!metroIds.includes(m.id)} checked={primary === m.id} onChange={() => setPrimary(m.id)} />
              primary
            </label>
          </div>
        ))}
      </fieldset>
      {action.msg && <Notice kind={action.msg.kind}>{action.msg.text}</Notice>}
      <div>
        <button
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              await setCapabilities(db, l, capIds, d.capabilityIds);
              await setMetros(db, l, metroIds, primary, d.metros);
              reload();
              return "Saved.";
            })
          }
        >
          Save capabilities and metros
        </button>
      </div>
    </div>
  );
}
