import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PG_PARSERS, SUPABASE_SETUP } from "../src/lib/pgDb.ts";

export { pgDb } from "../src/lib/pgDb.ts";

const root = join(__dirname, "..", "..", "..");

/** Fresh in-memory database with what Supabase provides, every migration and the seed. */
export async function freshDb(): Promise<PGlite> {
  const db = new PGlite({ parsers: PG_PARSERS });
  await db.exec(SUPABASE_SETUP);
  const migrations = join(root, "supabase", "migrations");
  for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(migrations, f), "utf8"));
  }
  await db.exec(readFileSync(join(root, "supabase", "seed.sql"), "utf8"));
  return db;
}
