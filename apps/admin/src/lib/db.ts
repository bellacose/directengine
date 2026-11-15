/**
 * The few database operations the admin app needs. The app runs them through supabase-js
 * (`supabaseDb.ts`) as the signed-in user, so row level security decides what they return. Tests run
 * the same calls against the real migration on in-memory Postgres (`test/pgDb.ts`).
 *
 * Kept deliberately small: one table or view per call, no joins. Joining happens in `api.ts`.
 */

export type Filter =
  | { col: string; op: "eq"; value: string | number | boolean | null }
  | { col: string; op: "in"; value: (string | number)[] }
  | { col: string; op: "gte"; value: string | number };

export interface SelectOptions {
  columns?: string[];
  where?: Filter[];
  /** Case-insensitive substring match on any of these columns. */
  search?: { columns: string[]; term: string };
  order?: { col: string; asc?: boolean }[];
  /** Rows [from, to], both inclusive, as in supabase-js `.range()`. */
  range?: [number, number];
}

export type Row = Record<string, unknown>;

export interface Db {
  select<T = Row>(source: string, opts?: SelectOptions): Promise<T[]>;
  insert<T = Row>(table: string, row: Row): Promise<T>;
  /** Updates matching rows and returns them. Zero rows means not found or not allowed. */
  update<T = Row>(table: string, patch: Row, where: Filter[]): Promise<T[]>;
  delete(table: string, where: Filter[]): Promise<void>;
  rpc<T = unknown>(fn: string, args: Row): Promise<T>;
}

/** Strip characters that would break a PostgREST `or=` filter or act as LIKE wildcards. */
export function cleanSearchTerm(term: string): string {
  return term.replace(/[%_*,()\\"]/g, " ").replace(/\s+/g, " ").trim();
}

export const eq = (col: string, value: string | number | boolean | null): Filter => ({ col, op: "eq", value });
