/**
 * Live Google Place Details for the candidate review screen. **Display only** (D8): what this
 * returns is shown to the reviewer and dropped. Nothing here writes, and no module that writes
 * (api.ts, the Db implementations) may import it; a test enforces that.
 *
 * The key is a browser key (VITE_GOOGLE_MAPS_BROWSER_KEY) restricted in Google Cloud to the admin
 * app's HTTP referrer and to the Places API (New). It is never the Supabase service key, and it is
 * optional: without it the screen shows the place ID and a Google Maps link only.
 */

export const DETAILS_URL = "https://places.googleapis.com/v1/places/";
/** Only what a reviewer needs to recognise the shop and find its own website. */
export const DETAILS_FIELD_MASK = "displayName,formattedAddress,nationalPhoneNumber,websiteUri,googleMapsUri,businessStatus";

export interface PlacePreview {
  name: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  mapsUrl: string;
  businessStatus: string | null;
}

/** Opens the place on Google Maps; needs no key. */
export const mapsLink = (placeId: string) => `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const httpUrl = (v: unknown) => {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

export async function fetchPlacePreview(placeId: string, key: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<PlacePreview> {
  const res = await fetchFn(DETAILS_URL + encodeURIComponent(placeId), {
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": DETAILS_FIELD_MASK },
  });
  if (!res.ok) throw new Error(`Google Place Details failed (HTTP ${res.status}).`);
  const p = (await res.json()) as Record<string, unknown>;
  const display = p.displayName as { text?: unknown } | undefined;
  return {
    name: str(display?.text),
    address: str(p.formattedAddress),
    phone: str(p.nationalPhoneNumber),
    website: httpUrl(p.websiteUri),
    mapsUrl: httpUrl(p.googleMapsUri) ?? mapsLink(placeId),
    businessStatus: str(p.businessStatus),
  };
}
