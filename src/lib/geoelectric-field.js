/**
 * NOAA SWPC 1-minute geoelectric field maps during active geomagnetic storms.
 *
 * SWPC publishes only two live map products under the same animations tree
 * (verified via directory listing + product page — no other-country folders):
 *   - US-Canada 1D
 *   - InterMagEarthScope empirical EMTF 3D (CONUS where MT surveys exist)
 *
 * @see https://www.swpc.noaa.gov/products/geoelectric-field-models-1-minute
 */
import {
  assessGeomagneticStormActivity,
  geomagneticStormMeetsG2Threshold,
} from './geomagnetic-storm-merge.js';

const SWPC_PRODUCT = 'https://www.swpc.noaa.gov/products/geoelectric-field-models-1-minute';
const SWPC_IMAGE_BASE = 'https://services.swpc.noaa.gov/images/animations/geoelectric';

/**
 * Verified public SWPC geoelectric map regions (same URL family as latest.png).
 * Other countries are not published under this product.
 *
 * @type {ReadonlyArray<{
 *   id: string,
 *   label: string,
 *   coverage: string,
 *   model: string,
 *   imageUrl: string,
 * }>}
 */
export const GEOELECTRIC_REGIONS = Object.freeze([
  Object.freeze({
    id: 'us-canada-1d',
    label: 'US–Canada 1D',
    coverage: 'Lower 48 United States and Canada to 60°N',
    model: '1D physiographic conductivity (NOAA/NRCan/USGS)',
    imageUrl: `${SWPC_IMAGE_BASE}/US-Canada/EmapGraphics_1m/latest.png`,
  }),
  Object.freeze({
    id: 'conus-emtf-3d',
    label: 'CONUS EMTF 3D',
    coverage: 'Continental US where magnetotelluric surveys exist',
    model: 'Empirical EMTF 3D / InterMagEarthScope',
    imageUrl: `${SWPC_IMAGE_BASE}/InterMagEarthScope/EmapGraphics_1m/latest.png`,
  }),
]);

function geoelectricDisabled(env = process.env) {
  return String(env.GEOELECTRIC_FIELD || '').trim() === '0';
}

/**
 * @returns {Promise<object>}
 */
export async function getGeoelectricFieldPayload() {
  if (geoelectricDisabled()) {
    return { ok: true, active: false, disabled: true };
  }

  const storm = await assessGeomagneticStormActivity();
  const stormGte2 = geomagneticStormMeetsG2Threshold(storm);
  const show = stormGte2;

  if (!show) {
    return {
      ok: true,
      disabled: false,
      active: false,
      stormActive: false,
      stormGte2: false,
      storm,
      regions: GEOELECTRIC_REGIONS,
      productUrl: SWPC_PRODUCT,
    };
  }

  const refreshedAt = Date.now();
  const caption = storm.label || 'Geomagnetic storm';
  const regions = GEOELECTRIC_REGIONS.map((r) => ({
    ...r,
    imageSrc: `${r.imageUrl}?_=${refreshedAt}`,
  }));

  return {
    ok: true,
    active: true,
    stormActive: true,
    stormGte2: true,
    storm,
    /** @deprecated Prefer regions[0]; kept for older clients. */
    imageUrl: regions[0].imageUrl,
    imageSrc: regions[0].imageSrc,
    regions,
    productUrl: SWPC_PRODUCT,
    refreshedAt,
    caption,
  };
}
