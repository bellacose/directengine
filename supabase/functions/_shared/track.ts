/**
 * `track`: logs website, call and directions clicks on listing buttons.
 *
 * The host rewrites POST /track/ on each site's domain to this function as /track/{site}/ (see
 * apps/web/src/lib/host-routing.ts). The page sends {"listing": "<uuid>", "kind": "website",
 * "page": "/dtf/tampa-bay/"} with navigator.sendBeacon (apps/web/src/components/TrackClicks.astro).
 *
 * Accepted only for a known site, a published listing in that site's dataset, and an allowed kind.
 * Affiliate clicks are logged only by `go`, never here.
 */

import { cleanPagePath, type Db, oneRow, SLUG, text } from "./db.ts";

export const TRACK_KINDS = ["website", "call", "directions"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 2000;

export async function handleTrack(req: Request, db: Db): Promise<Response> {
  if (req.method !== "POST") return text(405, "Method not allowed", { Allow: "POST" });
  const m = new URL(req.url).pathname.match(/^\/track\/([^/]+)\/?$/);
  if (!m || !SLUG.test(m[1])) return text(404, "Not found");

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return text(413, "Too large");
  const raw = await req.text();
  if (raw.length > MAX_BODY) return text(413, "Too large");
  let body: { listing?: unknown; kind?: unknown; page?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return text(400, "Bad request");
  }
  if (!body || typeof body !== "object") return text(400, "Bad request");
  if (!(TRACK_KINDS as readonly unknown[]).includes(body.kind)) return text(400, "Unknown kind");
  if (typeof body.listing !== "string" || !UUID.test(body.listing)) return text(400, "Bad listing");

  const site = await oneRow<{ id: string; dataset_id: string }>(db, "sites", "id,dataset_id", "slug", m[1]);
  if (!site) return text(404, "Unknown site");
  const listing = await oneRow<{ id: string; dataset_id: string; status: string }>(db, "listings", "id,dataset_id,status", "id", body.listing);
  if (!listing || listing.status !== "published" || listing.dataset_id !== site.dataset_id) return text(404, "Unknown listing");

  const { error } = await db.from("clicks").insert({ site_id: site.id, kind: body.kind, listing_id: listing.id, page_path: cleanPagePath(body.page) });
  if (error) throw new Error(`clicks: ${error.message}`);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
