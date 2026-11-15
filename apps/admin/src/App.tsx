import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Ctx, type AppCtx } from "./context.ts";
import { isAdmin, loadVocab } from "./lib/api.ts";
import type { Db } from "./lib/db.ts";
import { supabaseDb } from "./lib/supabaseDb.ts";
import { Affiliates } from "./pages/Affiliates.tsx";
import { Claims } from "./pages/Claims.tsx";
import { Corrections } from "./pages/Corrections.tsx";
import { ListingPage } from "./pages/ListingPage.tsx";
import { Listings } from "./pages/Listings.tsx";
import { Stats } from "./pages/Stats.tsx";
import { errorText, Loading } from "./ui.tsx";

/** Hash routes: #/listings, #/listing/<id>, #/new, #/claims, #/corrections, #/affiliates, #/stats */
function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

const NAV = [
  ["listings", "Listings"],
  ["claims", "Claims"],
  ["corrections", "Corrections"],
  ["affiliates", "Affiliates"],
  ["stats", "Stats"],
] as const;

/** Demo mode only: a ready Db and a fake signed-in admin (see demo.ts). */
export interface DemoSession {
  db: Db;
  user: { id: string; email: string };
}

export function App({ client, demo }: { client: SupabaseClient | null; demo?: DemoSession }) {
  if (demo) return <Gate db={demo.db} userId={demo.user.id} email={`${demo.user.email} (demo data)`} onSignOut={() => {}} />;
  if (!client) {
    return (
      <main className="narrow">
        <h1>Directory admin</h1>
        <p className="error">Not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY for this build.</p>
      </main>
    );
  }
  return <WithSession client={client} />;
}

function WithSession({ client }: { client: SupabaseClient }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    client.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = client.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [client]);

  if (session === undefined) return <main className="narrow"><Loading /></main>;
  if (!session) return <SignIn client={client} />;
  return <SignedIn client={client} session={session} />;
}

function SignIn({ client }: { client: SupabaseClient }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState("sending");
    setError(null);
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      // Only existing users (created in the Supabase dashboard) can sign in; nobody can sign up here.
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (error) {
      setError(error.message);
      setState("idle");
    } else setState("sent");
  };

  return (
    <main className="narrow">
      <h1>Directory admin</h1>
      {state === "sent" ? (
        <p className="ok" role="status">Check your email for a sign-in link.</p>
      ) : (
        <form onSubmit={submit} className="stack">
          <label>
            Email
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button type="submit" disabled={state === "sending"}>Email me a sign-in link</button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      )}
    </main>
  );
}

function SignedIn({ client, session }: { client: SupabaseClient; session: Session }) {
  const db = useMemo(() => supabaseDb(client), [client]);
  return <Gate db={db} userId={session.user.id} email={session.user.email ?? ""} onSignOut={() => client.auth.signOut()} />;
}

/** Signed in: only users listed in `admins` get past here. RLS also returns nothing to anyone else. */
function Gate({ db, userId, email, onSignOut }: { db: Db; userId: string; email: string; onSignOut: () => void }) {
  const [ctx, setCtx] = useState<AppCtx | null | "denied">(null);
  const [error, setError] = useState<string | null>(null);
  const route = useRoute();

  useEffect(() => {
    let live = true;
    (async () => {
      if (!(await isAdmin(db, userId))) return live && setCtx("denied");
      const vocab = await loadVocab(db);
      if (live) setCtx({ db, vocab, email });
    })().catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [db, userId, email]);

  const signOut = onSignOut;

  if (error) return <main className="narrow"><Loading error={error} /></main>;
  if (ctx === null) return <main className="narrow"><Loading /></main>;
  if (ctx === "denied") {
    return (
      <main className="narrow">
        <h1>No access</h1>
        <p>{email} is signed in but is not an admin.</p>
        <button onClick={signOut}>Sign out</button>
      </main>
    );
  }

  const [page = "listings", arg] = route;
  return (
    <Ctx.Provider value={ctx}>
      <header className="top">
        <strong>Directory admin</strong>
        <nav>
          {NAV.map(([href, label]) => (
            <a key={href} href={`#/${href}`} aria-current={page === href || (href === "listings" && (page === "listing" || page === "new")) ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <span className="muted small who">{ctx.email}</span>
        <button className="link" onClick={signOut}>Sign out</button>
      </header>
      <main>
        {page === "listings" && <Listings />}
        {page === "new" && <ListingPage id={null} />}
        {page === "listing" && arg && <ListingPage key={arg} id={arg} />}
        {page === "claims" && <Claims />}
        {page === "corrections" && <Corrections />}
        {page === "affiliates" && <Affiliates />}
        {page === "stats" && <Stats />}
      </main>
    </Ctx.Provider>
  );
}
