import { fetchPlacePreview, mapsLink } from "../lib/places.ts";
import { Loading, useLoad } from "../ui.tsx";

/**
 * Shows a candidate's Google details, fetched live each time, for the reviewer's eyes only. Takes
 * no callbacks and hands nothing back: what Google returns stays inside this panel (D8).
 */
export function PlacePanel({ placeId, apiKey }: { placeId: string; apiKey: string | undefined }) {
  const details = useLoad(async () => (apiKey ? fetchPlacePreview(placeId, apiKey) : null), [placeId, apiKey]);

  return (
    <div className="place-panel">
      <div className="small muted">Shown live for review only. Nothing here is saved; fill the draft from the shop's own website.</div>
      {!apiKey ? (
        <p className="small">
          No Google browser key is set for this build, so details can't be shown here.{" "}
          <a href={mapsLink(placeId)} target="_blank" rel="noopener noreferrer">Open on Google Maps</a>
        </p>
      ) : !details.data ? (
        <>
          <Loading error={details.error} />
          {details.error && <a className="small" href={mapsLink(placeId)} target="_blank" rel="noopener noreferrer">Open on Google Maps</a>}
        </>
      ) : (
        <dl className="place-details">
          <dt>Name</dt><dd>{details.data.name ?? "—"}</dd>
          <dt>Address</dt><dd>{details.data.address ?? "—"}</dd>
          <dt>Phone</dt><dd>{details.data.phone ?? "—"}</dd>
          <dt>Website</dt>
          <dd>{details.data.website ? <a href={details.data.website} target="_blank" rel="noopener noreferrer">{details.data.website}</a> : "—"}</dd>
          {details.data.businessStatus && details.data.businessStatus !== "OPERATIONAL" && (
            <><dt>Status</dt><dd className="error">{details.data.businessStatus}</dd></>
          )}
          <dt>Map</dt><dd><a href={details.data.mapsUrl} target="_blank" rel="noopener noreferrer">Open on Google Maps</a></dd>
        </dl>
      )}
      <div className="google-attribution" translate="no" aria-label="Google Maps">Google Maps</div>
    </div>
  );
}
