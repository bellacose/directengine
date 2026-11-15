import { useState } from "react";
import { useApp } from "../context.ts";
import { listingNames, loadAffiliates, loadClicks } from "../lib/api.ts";
import { aggregateClicks, type Count } from "../lib/stats.ts";
import { Loading, useLoad } from "../ui.tsx";

/** Clicks by site, program, listing and week. */
export function Stats() {
  const { db } = useApp();
  const [weeks, setWeeks] = useState(12);
  const { data, error } = useLoad(async () => {
    const since = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString();
    const [clicks, aff] = await Promise.all([loadClicks(db, since), loadAffiliates(db)]);
    const listings = await listingNames(db, clicks.flatMap((c) => (c.listing_id ? [c.listing_id] : [])));
    return aggregateClicks(clicks, {
      sites: new Map(aff.sites.map((s) => [s.id, s.slug])),
      programs: new Map(aff.programs.map((p) => [p.id, p.name])),
      listings,
    });
  }, [db, weeks]);

  return (
    <>
      <h1>Stats</h1>
      <label className="inline">
        Period
        <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
          <option value={4}>Last 4 weeks</option>
          <option value={12}>Last 12 weeks</option>
          <option value={52}>Last 52 weeks</option>
        </select>
      </label>
      {!data ? <Loading error={error} /> : (
        <>
          <p>{data.total} clicks in this period.</p>
          <CountTable title="By site and week" heads={["Site", "Week of", "Kind"]} rows={data.bySiteWeek} />
          <CountTable title="Affiliate clicks by program" heads={["Site", "Program"]} rows={data.byProgram} />
          <CountTable title="By listing" heads={["Site", "Listing", "Kind"]} rows={data.byListing} />
        </>
      )}
    </>
  );
}

function CountTable({ title, heads, rows }: { title: string; heads: string[]; rows: Count[] }) {
  return (
    <>
      <h2>{title}</h2>
      <div className="table-wrap">
        <table>
          <thead><tr>{heads.map((h) => <th key={h}>{h}</th>)}<th>Clicks</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.key.join("|")}>{r.key.map((k, i) => <td key={i}>{k}</td>)}<td>{r.count}</td></tr>)}
            {!rows.length && <tr><td colSpan={heads.length + 1} className="muted">No clicks.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
