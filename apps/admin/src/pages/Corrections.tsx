import { useState } from "react";
import { useApp } from "../context.ts";
import { listCorrections, listingNames, setCorrectionStatus, type CorrectionRow } from "../lib/api.ts";
import { fmtDate, Loading, Notice, useAction, useLoad } from "../ui.tsx";

/** Change reports from the public form. Fix the listing with a new check, then close the report. */
export function Corrections() {
  const { db } = useApp();
  const [status, setStatus] = useState<CorrectionRow["status"]>("open");
  const action = useAction();
  const { data, error, reload } = useLoad(async () => {
    const rows = await listCorrections(db, status);
    return { rows, names: await listingNames(db, rows.map((r) => r.listing_id)) };
  }, [db, status]);

  const close = (id: string, to: CorrectionRow["status"]) =>
    action.run(async () => {
      await setCorrectionStatus(db, id, to);
      reload();
    });

  return (
    <>
      <h1>Corrections</h1>
      <select value={status} onChange={(e) => setStatus(e.target.value as CorrectionRow["status"])} aria-label="Status">
        <option value="open">Open</option>
        <option value="done">Done</option>
        <option value="dismissed">Dismissed</option>
      </select>
      {action.msg && <Notice kind={action.msg.kind}>{action.msg.text}</Notice>}
      {!data ? <Loading error={error} /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Listing</th><th>Report</th><th>Sent</th><th /></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td><a href={`#/listing/${r.listing_id}`}>{data.names.get(r.listing_id) ?? r.listing_id}</a></td>
                  <td style={{ whiteSpace: "pre-wrap" }}>{r.detail}</td>
                  <td>{fmtDate(r.created_at)}</td>
                  <td>
                    {r.status === "open" ? (
                      <div className="row">
                        <button disabled={action.busy} onClick={() => close(r.id, "done")}>Done</button>
                        <button className="secondary" disabled={action.busy} onClick={() => close(r.id, "dismissed")}>Dismiss</button>
                      </div>
                    ) : (
                      <button className="link" disabled={action.busy} onClick={() => close(r.id, "open")}>Reopen</button>
                    )}
                  </td>
                </tr>
              ))}
              {!data.rows.length && <tr><td colSpan={4} className="muted">Nothing here.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
