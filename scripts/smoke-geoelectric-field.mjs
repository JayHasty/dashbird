#!/usr/bin/env node
/**
 * Smoke: /api/geoelectric-field + NOAA map images (US–Canada 1D + CONUS EMTF 3D).
 */
const base = process.env.DASHBIRD_BASE || 'http://127.0.0.1:8787';
const imgUrls = [
  'https://services.swpc.noaa.gov/images/animations/geoelectric/US-Canada/EmapGraphics_1m/latest.png',
  'https://services.swpc.noaa.gov/images/animations/geoelectric/InterMagEarthScope/EmapGraphics_1m/latest.png',
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

for (const imgUrl of imgUrls) {
  const ir = await fetch(imgUrl);
  assert(ir.ok, `NOAA image HTTP ${ir.status} ${imgUrl}`);
  const buf = await ir.arrayBuffer();
  assert(buf.byteLength > 5000, `image too small (${buf.byteLength} bytes) ${imgUrl}`);
}

const r = await fetch(`${base}/api/geoelectric-field`, { cache: 'no-store' });
const j = await r.json();
assert(r.ok && j.ok !== false, `API ${r.status} ${JSON.stringify(j)}`);

if (Array.isArray(j.regions)) {
  assert(j.regions.length >= 2, `expected ≥2 regions, got ${j.regions.length}`);
  for (const region of j.regions) {
    assert(region?.id && region?.imageUrl, `region missing id/imageUrl: ${JSON.stringify(region)}`);
    assert(
      String(region.imageUrl).includes('geoelectric'),
      `unexpected imageUrl ${region.imageUrl}`,
    );
  }
}

if (j.active && j.imageSrc) {
  assert(j.imageUrl?.includes('geoelectric'), j.imageUrl);
  console.log('ok', {
    active: j.active,
    forceShow: j.forceShow,
    stormActive: j.stormActive,
    regions: j.regions?.map((x) => x.id),
  });
} else {
  console.log('ok', {
    active: j.active,
    hidden: !j.active,
    label: j.storm?.label,
    regions: j.regions?.map((x) => x.id),
    hint: 'Set SKY_DEBUG_GEOMAGNETIC_ACTIVE=1 to preview, or wait for NOAA G≥2 (above G1)',
  });
}
