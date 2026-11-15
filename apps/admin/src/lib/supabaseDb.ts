import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanSearchTerm, type Db, type Filter, type Row, type SelectOptions } from "./db.ts";

// supabase-js builders are chainable but their generic types differ per step; `any` keeps this
// adapter small. The Db interface above it is fully typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = any;

function applyFilters(q: Builder, where: Filter[] = []): Builder {
  for (const f of where) {
    if (f.op === "eq") q = f.value === null ? q.is(f.col, null) : q.eq(f.col, f.value);
    else if (f.op === "in") q = q.in(f.col, f.value);
    else q = q.gte(f.col, f.value);
  }
  return q;
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

/** The Db the app uses: supabase-js, as the signed-in user. */
export function supabaseDb(client: SupabaseClient): Db {
  return {
    async select<T>(source: string, opts: SelectOptions = {}) {
      let q: Builder = client.from(source).select((opts.columns ?? ["*"]).join(","));
      q = applyFilters(q, opts.where);
      const term = opts.search ? cleanSearchTerm(opts.search.term) : "";
      if (opts.search && term) {
        q = q.or(opts.search.columns.map((c) => `${c}.ilike.*${term}*`).join(","));
      }
      for (const o of opts.order ?? []) q = q.order(o.col, { ascending: o.asc !== false });
      if (opts.range) q = q.range(opts.range[0], opts.range[1]);
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as T[];
    },
    async insert<T>(table: string, row: Row) {
      const { data, error } = await client.from(table).insert(row).select().single();
      fail(error);
      return data as T;
    },
    async update<T>(table: string, patch: Row, where: Filter[]) {
      const { data, error } = await applyFilters(client.from(table).update(patch), where).select();
      fail(error);
      return (data ?? []) as T[];
    },
    async delete(table: string, where: Filter[]) {
      const { error } = await applyFilters(client.from(table).delete(), where);
      fail(error);
    },
    async rpc<T>(fn: string, args: Row) {
      const { data, error } = await client.rpc(fn, args);
      fail(error);
      return data as T;
    },
  };
}
