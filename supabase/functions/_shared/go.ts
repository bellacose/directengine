/**
 * `go`: the affiliate redirect behind /go/{program}/ on each site's own domain.
 *
 * The host rewrites /go/{program}/ to this function as /go/{site}/{program}/ (see
 * apps/web/src/lib/host-routing.ts), so the site comes from the host's routing, not from the page.
 *
 * - The target is always the link stored in site_affiliates for this site, never anything in the
 *   request. Any query string is ignored.
 * - Only an `approved` program with a link redirects (302). Anything else is 404 and logs nothing.
 * - Each GET logs one `clicks` row (site, program, page path from the Referer when it is one of the
 *   site's own pages). Crawlers that ignore robots.txt are redirected but not logged.
 * - The sub-ID names the site and page, e.g. "dtf_ship_dtf-to-tampa-bay". It replaces `{subid}` in
 *   the stored link if present (put it where the network wants it, e.g. Awin `clickref={subid}`);
 *   otherwise it is added as `subid=`.
 */

import { cleanPagePath, type Db, oneRow, SLUG, text } from "./db.ts";

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless/i;
const SUBID_MAX = 100;

/** The Referer's path, only when the Referer is a page on this site's own domain. */
export function pagePathFromReferer(referer: string | null, domain: string | null): string | null {
  if (!referer || !domain) return null;
  let u: URL;
  try {
    u = new URL(referer);
  } catch {
    return null;
  }
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
  if (u.protocol !== "https:" || bare(u.hostname) !== bare(domain)) return null;
  return cleanPagePath(u.pathname);
}

/** "dtf" + "/ship/dtf-to-tampa-bay/" -> "dtf_ship_dtf-to-tampa-bay"; "/" -> "dtf_home"; unknown -> "dtf_unknown". */
export function subId(site: string, pagePath: string | null): string {
  let page = "unknown";
  if (pagePath === "/") page = "home";
  else if (pagePath) {
    page = pagePath.split("/").filter(Boolean).map((s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-")).join("_") || "unknown";
  }
  return `${site}_${page}`.slice(0, SUBID_MAX);
}

/** The stored link with the sub-ID in it, or null if the stored link isn't a valid https URL. */
export function withSubId(stored: string, id: string): string | null {
  const templated = stored.includes("{subid}");
  let u: URL;
  try {
    u = new URL(templated ? stored.replaceAll("{subid}", encodeURIComponent(id)) : stored);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!templated) u.searchParams.set("subid", id);
  return u.toString();
}

export async function handleGo(req: Request, db: Db): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return text(405, "Method not allowed", { Allow: "GET, HEAD" });
  const m = new URL(req.url).pathname.match(/^\/go\/([^/]+)\/([^/]+)\/?$/);
  if (!m || !SLUG.test(m[1]) || !SLUG.test(m[2])) return text(404, "Not found");
  const [, siteSlug, programSlug] = m;

  const site = await oneRow<{ id: string; slug: string; domain: string | null }>(db, "sites", "id,slug,domain", "slug", siteSlug);
  const program = await oneRow<{ id: string }>(db, "affiliate_programs", "id", "slug", programSlug);
  if (!site || !program) return text(404, "Not found");

  const { data, error } = await db.from("site_affiliates").select("status,url").eq("site_id", site.id).eq("program_id", program.id).limit(1);
  if (error) throw new Error(`site_affiliates: ${error.message}`);
  const row = data?.[0] as { status: string; url: string | null } | undefined;
  if (!row || row.status !== "approved" || !row.url) return text(404, "Not found");

  const pagePath = pagePathFromReferer(req.headers.get("referer"), site.domain);
  const target = withSubId(row.url, subId(site.slug, pagePath));
  if (!target) return text(404, "Not found");

  if (req.method === "GET" && !BOT.test(req.headers.get("user-agent") ?? "")) {
    const { error: e } = await db.from("clicks").insert({ site_id: site.id, kind: "affiliate", program_id: program.id, page_path: pagePath });
    // A failed log must not strand the reader; the redirect still happens.
    if (e) console.error(`clicks insert failed: ${e.message}`);
  }

  return new Response(null, {
    status: 302,
    headers: { Location: target, "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}
