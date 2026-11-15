import { useState } from "react";
import { useApp } from "../context.ts";
import { searchListings } from "../lib/api.ts";
import type { ListingRow } from "../lib/listing.ts";
import { fmtDate, Loading, useLoad } from "../ui.tsx";

export function Listings() {
  const { db } = useApp();
  const [term, setTerm] = useState("");
  const [status, setStatus] = useState<ListingRow["status"] | "">("");
  const [query, setQuery] = useState({ term: "", status: "" as ListingRow["status"] | "" });
  const { data, error } = useLoad(() => searchListings(db, query.term, query.status), [db, query]);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Listings</h1>
        <a href="#/new"><button>New draft</button></a>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setQuery({ term, status }); }}>
        <input type="search" placeholder="Name, city or slug" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search" />
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
          <option value="">Any status</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="removed">Removed</option>
        </select>
        <button type="submit">Search</button>
      </form>
      {!data ? <Loading error={error} /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>City</th><th>Status</th><th>Last checked</th></tr></thead>
            <tbody>
              {data.map((l) => (
                <tr key={l.id}>
                  <td><a href={`#/listing/${l.id}`}>{l.name}</a><div className="muted small">{l.slug}</div></td>
                  <td>{l.city}, {l.state}</td>
                  <td><span className={`badge ${l.status}`}>{l.status}</span></td>
                  <td>{fmtDate(l.last_verified_at)}</td>
                </tr>
              ))}
              {!data.length && <tr><td colSpan={4} className="muted">No listings match.</td></tr>}
            </tbody>
          </table>
          {data.length === 200 && <p className="muted small">Showing the first 200. Narrow the search.</p>}
        </div>
      )}
    </>
  );
}
