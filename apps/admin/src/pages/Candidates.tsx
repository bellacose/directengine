import { useState } from "react";
import { useApp } from "../context.ts";
import { addCandidateAsDraft, listCandidates, rejectCandidate, type CandidateRow } from "../lib/api.ts";
import { draftStart } from "../lib/listing.ts";
import { fmtDate, Loading, Notice, useAction, useLoad } from "../ui.tsx";
import { CoreForm } from "./CoreForm.tsx";
import { PlacePanel } from "./PlacePanel.tsx";

/** Browser key for live Place Details: HTTP-referrer and API restricted. Optional. */
const PLACES_KEY = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY || undefined;

/** Place IDs found by `npm run discover`, waiting for a person to look at them. */
export function Candidates() {
  const { db, vocab } = useApp();
  const [status, setStatus] = useState<CandidateRow["status"]>("new");
  const { data, error, reload } = useLoad(() => listCandidates(db, status), [db, status]);
  const dsName = new Map(vocab.datasets.map((d) => [d.id, d.name]));

  return (
    <>
      <h1>Candidates</h1>
      <p className="muted small">
        Shops found by discovery. Look each one up, then add it as a draft (typing the details from the
        shop's own website) or reject it. Only the place ID is stored.
      </p>
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value as CandidateRow["status"])} aria-label="Status">
          <option value="new">Waiting for review</option>
          <option value="added">Added as draft</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      {!data ? <Loading error={error} /> : (
        <>
          {!data.length && <p className="muted">Nothing here.</p>}
          {data.map((c) => <CandidateCard key={c.id} candidate={c} dataset={dsName.get(c.dataset_id)} onDone={reload} />)}
        </>
      )}
    </>
  );
}

function CandidateCard({ candidate: c, dataset, onDone }: { candidate: CandidateRow; dataset?: string; onDone: () => void }) {
  const { db } = useApp();
  const [show, setShow] = useState(false);
  const [adding, setAdding] = useState(false);
  const reject = useAction();
  const pending = c.status === "new";

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{c.query ?? "No query recorded"}</strong>
          <div className="small muted">
            {dataset ?? "Unknown dataset"} · found {fmtDate(c.discovered_at)} · place ID <code>{c.place_id}</code>
          </div>
        </div>
        <div className="row">
          <button className="secondary" onClick={() => setShow(!show)}>{show ? "Hide details" : "Show details"}</button>
          {pending && (
            <>
              <button onClick={() => setAdding(!adding)} className={adding ? "secondary" : ""}>{adding ? "Close" : "Add as draft"}</button>
              <button className="danger" disabled={reject.busy} onClick={() => reject.run(async () => { await rejectCandidate(db, c.id); onDone(); })}>Reject</button>
            </>
          )}
        </div>
      </div>
      {show && <PlacePanel placeId={c.place_id} apiKey={PLACES_KEY} />}
      {reject.msg && <Notice kind={reject.msg.kind}>{reject.msg.text}</Notice>}
      {adding && pending && (
        <div className="stack">
          <h3>New draft</h3>
          <p className="small muted">
            Fill this from the shop's own website, not from Google. The place ID is attached for you.
            The draft stays unpublished until a check is recorded.
          </p>
          <CoreForm
            initial={draftStart(c.place_id)}
            autoSlug
            submitLabel="Create draft"
            onSave={async (row) => {
              const l = await addCandidateAsDraft(db, c, row);
              window.location.hash = `#/listing/${l.id}`;
            }}
          />
        </div>
      )}
    </div>
  );
}
