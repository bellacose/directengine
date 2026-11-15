import { useState } from "react";
import { localToday, useApp } from "../context.ts";
import { approveClaim, createDraft, getListing, listClaims, listingNames, rejectClaim, searchListings, type ClaimRow } from "../lib/api.ts";
import { emptyCore, slugify, type CoreInput } from "../lib/listing.ts";
import { fmtDate, Loading, Notice, useAction, useLoad } from "../ui.tsx";
import { CheckForm } from "./CheckForm.tsx";
import { CoreForm } from "./CoreForm.tsx";

/** Claim and add-your-shop submissions. Approving records an owner_submitted check; publishing stays separate. */
export function Claims() {
  const { db } = useApp();
  const [status, setStatus] = useState<ClaimRow["status"]>("pending");
  const { data, error, reload } = useLoad(async () => {
    const claims = await listClaims(db, status);
    const names = await listingNames(db, claims.flatMap((c) => (c.listing_id ? [c.listing_id] : [])));
    return { claims, names };
  }, [db, status]);

  return (
    <>
      <h1>Claims</h1>
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value as ClaimRow["status"])} aria-label="Status">
          <option value="pending">Waiting for review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      {!data ? <Loading error={error} /> : (
        <>
          {!data.claims.length && <p className="muted">Nothing here.</p>}
          {data.claims.map((c) => (
            <ClaimCard key={c.id} claim={c} listingName={c.listing_id ? data.names.get(c.listing_id) : undefined} onDone={reload} />
          ))}
        </>
      )}
    </>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Starting draft fields from what the owner typed. The reviewer checks every one before saving. */
function draftFromPayload(p: Record<string, unknown>): CoreInput {
  const name = str(p.name) || str(p.shop_name);
  return {
    ...emptyCore(),
    name,
    slug: slugify(name),
    address1: str(p.address1) || str(p.address),
    city: str(p.city),
    state: str(p.state).toUpperCase(),
    zip: str(p.zip),
    phone: str(p.phone),
    website: str(p.website),
    description: str(p.description).slice(0, 500),
  };
}

function ClaimCard({ claim, listingName, onDone }: { claim: ClaimRow; listingName?: string; onDone: () => void }) {
  const { db } = useApp();
  const [open, setOpen] = useState(false);
  const reject = useAction();
  const pending = claim.status === "pending";

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{claim.listing_id ? <a href={`#/listing/${claim.listing_id}`}>{listingName ?? "Listed shop"}</a> : "New shop (not listed yet)"}</strong>
          <div className="small muted">{claim.contact_email} · sent {fmtDate(claim.created_at)}{claim.decided_at && ` · decided ${fmtDate(claim.decided_at)}`}</div>
        </div>
        {pending && (
          <div className="row">
            <button onClick={() => setOpen(!open)} className={open ? "secondary" : ""}>{open ? "Close" : "Review and approve"}</button>
            <button className="danger" disabled={reject.busy} onClick={() => reject.run(async () => { await rejectClaim(db, claim.id); onDone(); })}>Reject</button>
          </div>
        )}
      </div>
      <details>
        <summary className="small">What they sent</summary>
        <pre>{JSON.stringify(claim.payload, null, 2)}</pre>
      </details>
      {reject.msg && <Notice kind={reject.msg.kind}>{reject.msg.text}</Notice>}
      {open && <Approve claim={claim} onDone={onDone} />}
    </div>
  );
}

function Approve({ claim, onDone }: { claim: ClaimRow; onDone: () => void }) {
  const { db, vocab } = useApp();
  const [listingId, setListingId] = useState<string | null>(claim.listing_id);
  const target = useLoad(async () => (listingId ? { d: await getListing(db, listingId) } : null), [db, listingId]);
  const facts = claim.payload.facts && typeof claim.payload.facts === "object" ? (claim.payload.facts as Record<string, unknown>) : {};
  const known = new Set(vocab.factDefs.filter((f) => f.dataset_id === claim.dataset_id).map((f) => f.key));
  const prefill = Object.fromEntries(Object.entries(facts).filter(([k]) => known.has(k)));

  if (!listingId) return <PickListing claim={claim} onPick={setListingId} />;
  if (!target.data) return <Loading error={target.error} />;
  const d = target.data.d;
  if (!d) return <p className="error">Listing not found.</p>;

  return (
    <div className="stack">
      <h3>Owner-submitted check for {d.listing.name}</h3>
      <p className="small muted">
        Set only what the owner told us and you accept. Each value is recorded as owner submitted, today.
        Approving does not publish the listing.
      </p>
      <CheckForm
        datasetId={claim.dataset_id}
        factStatus={d.factStatus}
        fixedMethod="owner_submitted"
        prefill={prefill}
        submitLabel="Approve claim and record check"
        onSubmit={async (form, defs, existing) => {
          const r = await approveClaim(db, claim, d.listing.id, form, defs, existing, localToday());
          if (!r.ok) return r;
          onDone();
          return { ok: true, message: "Claim approved." };
        }}
      />
    </div>
  );
}

/** A claim for a shop we don't list: attach it to an existing listing, or create a draft from it. */
function PickListing({ claim, onPick }: { claim: ClaimRow; onPick: (id: string) => void }) {
  const { db } = useApp();
  const [term, setTerm] = useState(str(claim.payload.name) || str(claim.payload.shop_name));
  const [q, setQ] = useState(term);
  const found = useLoad(() => (q.trim() ? searchListings(db, q) : Promise.resolve([])), [db, q]);

  return (
    <div className="stack">
      <h3>Is this shop already listed?</h3>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setQ(term); }}>
        <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search listings" />
        <button type="submit" className="secondary">Search</button>
      </form>
      {found.data?.map((l) => (
        <div key={l.id} className="row">
          <span>{l.name} <span className="muted small">{l.city} · {l.status}</span></span>
          <button className="secondary" onClick={() => onPick(l.id)}>Use this listing</button>
        </div>
      ))}
      <h3>Or create a draft from the submission</h3>
      <CoreForm
        initial={draftFromPayload(claim.payload)}
        autoSlug
        submitLabel="Create draft"
        onSave={async (row) => {
          const l = await createDraft(db, claim.dataset_id, row);
          onPick(l.id);
        }}
      />
    </div>
  );
}
