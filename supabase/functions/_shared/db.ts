/**
 * What the Edge Functions need from supabase-js, typed loosely so these files run unchanged in Deno
 * (the deployed functions) and in Node (the tests, which use the real client against PGlite).
 */

// deno-lint-ignore no-explicit-any
export type Db = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };

/** URL-safe slug, the same rule the database applies to site and program slugs. */
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A site page path as the plan writes it: "/", "/dtf/tampa-bay/", "/shop/example-dtf-tampa/". */
const PAGE_PATH = /^\/[A-Za-z0-9\-._~/]{0,299}$/;
export const cleanPagePath = (p: unknown): string | null => (typeof p === "string" && PAGE_PATH.test(p) ? p : null);

/** First row matching column = value, or null. Throws on a database error. */
export async function oneRow<T>(db: Db, table: string, columns: string, column: string, value: string): Promise<T | null> {
  const { data, error } = await db.from(table).select(columns).eq(column, value).limit(1);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data?.[0] as T | undefined) ?? null;
}

export const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", ...headers },
  });

/**
 * The service key from the function's environment: the new secret key (SUPABASE_SECRET_KEYS,
 * "default") when the project has one, else the legacy SUPABASE_SERVICE_ROLE_KEY.
 */
export function serviceKey(get: (name: string) => string | undefined): string {
  const keys = get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const k = JSON.parse(keys)?.default;
      if (typeof k === "string" && k) return k;
    } catch {
      // fall through to the legacy key
    }
  }
  const legacy = get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("No service key: neither SUPABASE_SECRET_KEYS.default nor SUPABASE_SERVICE_ROLE_KEY is set");
  return legacy;
}
