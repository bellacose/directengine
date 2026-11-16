// A stand-in for the Supabase REST API (PostgREST) on PGlite, enough for the Edge Functions' real
// supabase-js calls: GET with select=, eq. filters and limit, POST inserts (returning the select=
// columns when asked), and POST /rpc/{fn} with named arguments. Anything else is an error, so the
// functions can't quietly depend on a feature this doesn't check.

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
    const m = url.pathname.match(/^\/rest\/v1\/(rpc\/)?([a-z_]+)$/);
    if (!m) return json(400, { message: `unsupported path ${url.pathname}` });
    if (req.headers.get("apikey") !== expectKey) return json(401, { message: "Invalid API key" });
    const table = ident(m[2]);
    try {
      if (m[1]) {
        if (req.method !== "POST") throw new Error(`fake PostgREST: rpc needs POST`);
        const args = (await req.json()) as Record<string, unknown>;
        const keys = Object.keys(args);
        const res = await db.query<{ r: unknown }>(
          `select to_json(public.${table}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")})) as r`,
          keys.map((k) => args[k]),
        );
        return json(200, res.rows[0].r);
      }
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
        let returning: string | null = null;
        for (const [k, v] of url.searchParams) {
          if (k === "select") returning = v.split(",").map(ident).join(", ");
          else if (k !== "columns") throw new Error(`fake PostgREST: unsupported parameter ${k}`);
        }
        const body = await req.json();
        const rows = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
        const out: unknown[] = [];
        for (const row of rows) {
          const keys = Object.keys(row);
          const res = await db.query<Record<string, unknown>>(
            `insert into public.${table} (${keys.map(ident).join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})` +
              (returning ? ` returning ${returning}` : ""),
            keys.map((k) => row[k]),
          );
          out.push(...res.rows);
        }
        return returning ? json(201, out) : new Response(null, { status: 201 });
      }
      return json(400, { message: `unsupported method ${req.method}` });
    } catch (e) {
      return json(400, { message: (e as Error).message });
    }
  }) as typeof fetch;
}
