import { createContext, useContext } from "react";
import type { Vocab } from "./lib/api.ts";
import type { Db } from "./lib/db.ts";

export interface AppCtx {
  db: Db;
  vocab: Vocab;
  email: string;
}

export const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside the signed-in app");
  return c;
}

/** Today's local date as YYYY-MM-DD. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
