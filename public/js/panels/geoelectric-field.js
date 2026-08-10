const POLL_MS = 15 * 60 * 1000;
const STORAGE_KEY = 'dashbird-geoelectric-region';

function stormGte2(data) {
  if (data?.stormGte2 === true) return true;
  if (data?.stormGte2 === false) return false;
  if (data?.stormActive !== true) return false;
  const g = Number(data?.storm?.g);
  return Number.isFinite(g) && g >= 2;
}

/**
 * @param {HTMLElement} card
 * @param {HTMLElement} mount
 * @param {boolean} show
 */
function setSectionVisible(card, mount, show) {
  card.hidden = !show;
  card.classList.toggle('sky-sidebar__card--geoelectric-off', !show);
  const img = mount.querySelector('.geoelectric-field__img');
  const cap = mount.querySelector('.geoelectric-field__caption');
  const status = mount.querySelector('.geoelectric-field__status');
  const meta = mount.querySelector('.geoelectric-field__meta');
  if (!show) {
    if (img) {
      img.hidden = true;
      img.removeAttribute('src');
    }
    if (cap) cap.hidden = true;
    if (status) status.hidden = true;
    if (meta) meta.hidden = true;
    mount._geoelectricStormActive = false;
    return;
  }
  mount._geoelectricStormActive = true;
}

/**
 * @param {unknown} data
 * @returns {Array<{ id: string, label: string, coverage?: string, imageUrl?: string, imageSrc?: string }>}
 */
function regionsFromPayload(data) {
  if (Array.isArray(data?.regions) && data.regions.length) {
    return data.regions.filter((r) => r && (r.imageSrc || r.imageUrl));
  }
  const src = typeof data?.imageSrc === 'string' ? data.imageSrc : data?.imageUrl;
  if (!src) return [];
  return [
    {
      id: 'us-canada-1d',
      label: 'US–Canada 1D',
      imageUrl: data.imageUrl,
      imageSrc: src,
    },
  ];
}

/**
 * @param {HTMLElement} mount
 */
function readSavedRegionId(mount) {
  try {
    return String(localStorage.getItem(STORAGE_KEY) || '').trim();
  } catch {
    return String(mount._geoelectricRegionId || '').trim();
  }
}

/**
 * @param {string} id
 * @param {HTMLElement} mount
 */
function writeSavedRegionId(id, mount) {
  const key = String(id || '').trim();
  if (!key) return;
  mount._geoelectricRegionId = key;
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * @param {HTMLElement} card
 * @param {HTMLElement} mount
 * @param {object} data
 */
function applyPayload(card, mount, data) {
  const img = mount.querySelector('.geoelectric-field__img');
  const cap = mount.querySelector('.geoelectric-field__caption');
  const status = mount.querySelector('.geoelectric-field__status');
  const meta = mount.querySelector('.geoelectric-field__meta');
  const labelEl = mount.querySelector('.geoelectric-field__label');
  const counterEl = mount.querySelector('.geoelectric-field__counter');
  const prevBtn = mount.querySelector('.geoelectric-field__nav--prev');
  const nextBtn = mount.querySelector('.geoelectric-field__nav--next');
  if (!img || !cap || !status) return;

  if (!data?.ok || data.disabled || !stormGte2(data)) {
    setSectionVisible(card, mount, false);
    return;
  }

  const regions = regionsFromPayload(data);
  if (!regions.length) {
    setSectionVisible(card, mount, false);
    return;
  }

  setSectionVisible(card, mount, true);
  mount._geoelectricRegions = regions;

  let index = Number(mount._geoelectricRegionIndex);
  if (!Number.isFinite(index) || index < 0 || index >= regions.length) {
    const saved = readSavedRegionId(mount);
    const found = saved ? regions.findIndex((r) => r.id === saved) : -1;
    index = found >= 0 ? found : 0;
  }
  mount._geoelectricRegionIndex = index;

  const region = regions[index];
  const src =
    typeof region.imageSrc === 'string' && region.imageSrc
      ? region.imageSrc
      : region.imageUrl;
  if (!src) {
    setSectionVisible(card, mount, false);
    return;
  }

  if (region.id) writeSavedRegionId(region.id, mount);

  const multi = regions.length > 1;
  if (meta) meta.hidden = false;
  if (labelEl) {
    labelEl.textContent = region.label || 'Geoelectric map';
    labelEl.title = region.coverage || region.label || '';
  }
  if (counterEl) {
    counterEl.textContent = multi ? `${index + 1} / ${regions.length}` : '';
    counterEl.hidden = !multi;
  }
  if (prevBtn) prevBtn.hidden = !multi;
  if (nextBtn) nextBtn.hidden = !multi;

  img.alt = `NOAA 1-minute geoelectric field map — ${region.label || 'region'}`;

  const stormLabel =
    typeof data.caption === 'string' && data.caption.trim()
      ? data.caption.trim()
      : data.storm?.label || 'Geomagnetic storm';
  const refreshed =
    typeof data.refreshedAt === 'number'
      ? new Date(data.refreshedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : '';
  const coverage =
    typeof region.coverage === 'string' && region.coverage.trim()
      ? region.coverage.trim()
      : '';
  const bits = [stormLabel];
  if (coverage) bits.push(coverage);
  if (refreshed) bits.push(`map updated ${refreshed}`);
  cap.textContent = bits.join(' · ');

  const showMap = () => {
    status.hidden = true;
    img.hidden = false;
    cap.hidden = false;
  };

  if (img.getAttribute('src') === src && img.complete && img.naturalWidth > 0) {
    showMap();
    return;
  }

  status.hidden = false;
  status.textContent = 'Loading geoelectric map…';
  img.hidden = true;
  cap.hidden = true;

  img.onload = () => showMap();
  img.onerror = () => {
    if (!mount._geoelectricStormActive) {
      setSectionVisible(card, mount, false);
      return;
    }
    status.hidden = false;
    status.textContent = 'Geoelectric map image failed to load.';
    img.hidden = true;
    cap.hidden = true;
  };

  if (img.getAttribute('src') !== src) {
    img.src = src;
  } else if (img.complete && img.naturalWidth > 0) {
    showMap();
  }
}

/**
 * @param {HTMLElement} card
 * @param {HTMLElement} mount
 * @param {number} delta
 */
function stepRegion(card, mount, delta) {
  const regions = Array.isArray(mount._geoelectricRegions)
    ? mount._geoelectricRegions
    : [];
  if (regions.length < 2) return;
  const cur = Number(mount._geoelectricRegionIndex) || 0;
  mount._geoelectricRegionIndex = (cur + delta + regions.length) % regions.length;
  const last = mount._geoelectricLastPayload;
  if (last) applyPayload(card, mount, last);
}

/**
 * @param {HTMLElement | null} card
 * @param {HTMLElement | null} mount
 */
export function mountGeoelectricField(card, mount) {
  if (!card || !mount) return;

  mount.className = 'geoelectric-field';
  mount.replaceChildren();

  const frameWrap = document.createElement('div');
  frameWrap.className = 'geoelectric-field__frame';

  const img = document.createElement('img');
  img.className = 'geoelectric-field__img';
  img.alt = 'NOAA 1-minute geoelectric field map';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.hidden = true;

  const meta = document.createElement('div');
  meta.className = 'geoelectric-field__meta';
  meta.hidden = true;

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'geoelectric-field__nav geoelectric-field__nav--prev';
  prev.setAttribute('aria-label', 'Previous geoelectric map region');
  prev.textContent = '‹';
  prev.hidden = true;
  prev.addEventListener('click', () => stepRegion(card, mount, -1));

  const labelEl = document.createElement('span');
  labelEl.className = 'geoelectric-field__label';

  const counterEl = document.createElement('span');
  counterEl.className = 'geoelectric-field__counter';
  counterEl.hidden = true;

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'geoelectric-field__nav geoelectric-field__nav--next';
  next.setAttribute('aria-label', 'Next geoelectric map region');
  next.textContent = '›';
  next.hidden = true;
  next.addEventListener('click', () => stepRegion(card, mount, 1));

  meta.append(prev, labelEl, counterEl, next);

  const cap = document.createElement('p');
  cap.className = 'geoelectric-field__caption';
  cap.hidden = true;

  const status = document.createElement('p');
  status.className = 'geoelectric-field__status';
  status.hidden = true;

  frameWrap.append(img);
  mount.append(frameWrap, meta, cap, status);

  let pollTimer = null;

  async function refresh() {
    try {
      const r = await fetch('/api/geoelectric-field', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      mount._geoelectricLastPayload = data;
      applyPayload(card, mount, data);
    } catch {
      setSectionVisible(card, mount, false);
    }
  }

  setSectionVisible(card, mount, false);
  refresh();
  pollTimer = setInterval(refresh, POLL_MS);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
  };
}
