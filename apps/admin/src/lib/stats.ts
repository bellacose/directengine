/** Click counts by site, program, listing and week, from `clicks` rows. */

export interface ClickRow {
  site_id: string;
  kind: string;
  listing_id: string | null;
  program_id: string | null;
  created_at: string;
}

/** Monday (UTC) of the week a timestamp falls in, as YYYY-MM-DD. */
export function weekOf(ts: string): string {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

export interface Count {
  /** Display key parts, e.g. ["DTF site", "2026-11-09"]. */
  key: string[];
  count: number;
}

function tally(rows: ClickRow[], keyOf: (r: ClickRow) => string[] | null): Count[] {
  const m = new Map<string, Count>();
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    const id = JSON.stringify(key);
    const c = m.get(id) ?? { key, count: 0 };
    c.count++;
    m.set(id, c);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.key.join("\u0000").localeCompare(b.key.join("\u0000")));
}

export interface Names {
  sites: Map<string, string>;
  programs: Map<string, string>;
  listings: Map<string, string>;
}

export interface ClickStats {
  total: number;
  /** site, week, kind */
  bySiteWeek: Count[];
  /** site, program (affiliate clicks only) */
  byProgram: Count[];
  /** site, listing, kind (website, call, directions, claim_cta) */
  byListing: Count[];
}

export function aggregateClicks(rows: ClickRow[], names: Names): ClickStats {
  const name = (m: Map<string, string>, id: string | null) => (id ? m.get(id) ?? id : "(none)");
  return {
    total: rows.length,
    bySiteWeek: tally(rows, (r) => [name(names.sites, r.site_id), weekOf(r.created_at), r.kind]).sort(
      (a, b) => b.key[1].localeCompare(a.key[1]) || a.key[0].localeCompare(b.key[0]) || a.key[2].localeCompare(b.key[2]),
    ),
    byProgram: tally(rows, (r) => (r.kind === "affiliate" ? [name(names.sites, r.site_id), name(names.programs, r.program_id)] : null)),
    byListing: tally(rows, (r) => (r.listing_id ? [name(names.sites, r.site_id), name(names.listings, r.listing_id), r.kind] : null)),
  };
}
