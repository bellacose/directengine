/**
 * Test double for the app's Db: the same operations as supabaseDb.ts, run as SQL on in-memory
 * Postgres with the real migration and seed. Each call switches to the `authenticated` role with
 * the given user id, the way PostgREST runs a request with the user's JWT, so RLS applies.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanSearchTerm, type Db, type Filter, type Row, type SelectOptions } from "../src/lib/db.ts";

const root = join(__dirname, "..", "..", "..");
const IDENT = /^[a-z_][a-z0-9_]*$/;
const id = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`bad identifier ${s}`);
  return `"${s}"`;
};

/** Fresh in-memory database with what a Supabase project provides, the migrations and the seed. */
export async function freshDb(): Promise<PGlite> {
  // Dates and timestamps as strings, the way PostgREST returns them to supabase-js.
  const asText = (v: string) => v;
  const db = new PGlite({ parsers: { 1082: asText, 1114: asText, 1184: asText } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  const migrations = join(root, "supabase", "migrations");
  for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(migrations, f), "utf8"));
  }
  await db.exec(readFileSync(join(root, "supabase", "seed.sql"), "utf8"));
  return db;
}

function where(filters: Filter[] = [], params: unknown[]): string[] {
  return filters.map((f) => {
    if (f.op === "eq" && f.value === null) return `${id(f.col)} is null`;
    params.push(f.value);
    if (f.op === "eq") return `${id(f.col)} = $${params.length}`;
    if (f.op === "gte") return `${id(f.col)} >= $${params.length}`;
    return `${id(f.col)}::text = any($${params.length}::text[])`;
  });
}

const jsonish = (v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);

/** A Db that runs every call as `userId` in the `authenticated` role. */
export function pgDb(pg: PGlite, userId: string): Db {
  const run = async <T>(sql: string, params: unknown[]): Promise<T[]> => {
    await pg.exec(`reset role`);
    await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
    await pg.exec(`set role authenticated`);
    try {
      return (await pg.query<T>(sql, params)).rows;
    } finally {
      await pg.exec(`reset role`);
    }
  };
  return {
    async select<T>(source: string, opts: SelectOptions = {}) {
      const params: unknown[] = [];
      const conds = where(opts.where, params);
      const term = opts.search ? cleanSearchTerm(opts.search.term) : "";
      if (opts.search && term) {
        params.push(`%${term}%`);
        conds.push(`(${opts.search.columns.map((c) => `${id(c)} ilike $${params.length}`).join(" or ")})`);
      }
      let sql = `select ${(opts.columns ?? ["*"]).map((c) => (c === "*" ? c : id(c))).join(", ")} from ${id(source)}`;
      if (conds.length) sql += ` where ${conds.join(" and ")}`;
      if (opts.order?.length) sql += ` order by ${opts.order.map((o) => `${id(o.col)} ${o.asc === false ? "desc" : "asc"}`).join(", ")}`;
      if (opts.range) sql += ` limit ${opts.range[1] - opts.range[0] + 1} offset ${opts.range[0]}`;
      return run<T>(sql, params);
    },
    async insert<T>(table: string, row: Row) {
      const keys = Object.keys(row);
      const params = keys.map((k) => jsonish(row[k]));
      const sql = `insert into ${id(table)} (${keys.map(id).join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`;
      return (await run<T>(sql, params))[0];
    },
    async update<T>(table: string, patch: Row, filters: Filter[]) {
      const keys = Object.keys(patch);
      const params: unknown[] = keys.map((k) => jsonish(patch[k]));
      const sets = keys.map((k, i) => `${id(k)} = $${i + 1}`);
      const conds = where(filters, params);
      return run<T>(`update ${id(table)} set ${sets.join(", ")} where ${conds.join(" and ")} returning *`, params);
    },
    async delete(table: string, filters: Filter[]) {
      const params: unknown[] = [];
      await run(`delete from ${id(table)} where ${where(filters, params).join(" and ")}`, params);
    },
    async rpc<T>(fn: string, args: Row) {
      const keys = Object.keys(args);
      const params = keys.map((k) => jsonish(args[k]));
      const rows = await run<{ r: T }>(`select ${id(fn)}(${keys.map((k, i) => `${id(k)} => $${i + 1}`).join(", ")}) as r`, params);
      return rows[0].r;
    },
  };
}
