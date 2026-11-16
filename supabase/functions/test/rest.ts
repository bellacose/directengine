// A stand-in for the Supabase REST API (PostgREST) on PGlite, enough for the Edge Functions' real
// supabase-js calls: GET with select=, eq. filters and limit, and POST inserts. Anything else is an
// error, so the functions can't quietly depend on a feature this doesn't check.

import type { PGlite } from "@electric-sql/pglite";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`fake PostgREST: unsupported identifier "${s}"`);
  return `"${s}"`;
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function restFetch(db: PGlite, expectKey: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m) return json(400, { message: `unsupported path ${url.pathname}` });
    if (req.headers.get("apikey") !== expectKey) return json(401, { message: "Invalid API key" });
    const table = ident(m[1]);
    try {
      if (req.method === "GET") {
        const params: unknown[] = [];
        const where: string[] = [];
        let cols = "*";
        let limit = 1000;
        for (const [k, v] of url.searchParams) {
          if (k === "select") cols = v.split(",").map(ident).join(", ");
          else if (k === "limit") limit = Number(v);
          else if (v.startsWith("eq.")) {
            params.push(v.slice(3));
            where.push(`${ident(k)}::text = $${params.length}`);
          } else throw new Error(`fake PostgREST: unsupported parameter ${k}=${v}`);
        }
        const sql = `select coalesce(json_agg(t), '[]'::json) as rows from (select ${cols} from public.${table}` +
          (where.length ? ` where ${where.join(" and ")}` : "") + ` limit ${limit}) t`;
        const res = await db.query<{ rows: unknown[] }>(sql, params);
        return json(200, res.rows[0].rows);
      }
      if (req.method === "POST") {
        for (const k of url.searchParams.keys()) if (k !== "columns") throw new Error(`fake PostgREST: unsupported parameter ${k}`);
        const body = await req.json();
        const rows = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
        for (const row of rows) {
          const keys = Object.keys(row);
          await db.query(
            `insert into public.${table} (${keys.map(ident).join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
            keys.map((k) => row[k]),
          );
        }
        return new Response(null, { status: 201 });
      }
      return json(400, { message: `unsupported method ${req.method}` });
    } catch (e) {
      return json(400, { message: (e as Error).message });
    }
  }) as typeof fetch;
}
