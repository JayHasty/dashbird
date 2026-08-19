/**
 * Share Contact Info — LinkedIn card image + Facebook profile QR.
 */

const LINKEDIN_CARD_URL = '/assets/share-contact-linkedin.jpeg';
const FACEBOOK_QR_URL = '/assets/share-contact-facebook-qr.png';
const FACEBOOK_PROFILE_URL = ''; // set locally / via future Settings; never commit a personal profile

/**
 * @param {string} href
 * @param {string} filename
 */
function downloadHref(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * @param {{
 *   title: string,
 *   imageUrl: string,
 *   imageAlt: string,
 *   caption?: string,
 *   downloadName: string,
 *   linkUrl?: string,
 * }} opts
 */
function openShareAssetDialog(opts) {
  const backdrop = document.createElement('div');
  backdrop.className = 'network-crm__img-pick-backdrop network-crm__share-backdrop';
  backdrop.setAttribute('role', 'presentation');

  const dialog = document.createElement('div');
  dialog.className = 'network-crm__img-pick-dialog network-crm__share-asset-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', opts.title);

  const header = document.createElement('div');
  header.className = 'network-crm__img-pick-dialog-header';
  const title = document.createElement('h3');
  title.className = 'network-crm__img-pick-dialog-title';
  title.textContent = opts.title;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
  closeBtn.textContent = 'Close';
  header.append(title, closeBtn);

  const frame = document.createElement('div');
  frame.className = 'network-crm__share-asset-frame';
  const img = document.createElement('img');
  img.src = opts.imageUrl;
  img.alt = opts.imageAlt;
  img.className = 'network-crm__share-asset-img';
  frame.append(img);

  /** @type {HTMLElement[]} */
  const parts = [header, frame];

  if (opts.caption || opts.linkUrl) {
    const meta = document.createElement('p');
    meta.className = 'network-crm__share-asset-caption muted';
    if (opts.linkUrl) {
      const a = document.createElement('a');
      a.href = opts.linkUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = opts.caption || opts.linkUrl;
      meta.append(a);
    } else {
      meta.textContent = opts.caption || '';
    }
    parts.push(meta);
  }

  if (typeof navigator.share === 'function') {
    const actions = document.createElement('div');
    actions.className = 'network-crm__share-asset-actions';
    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'network-crm__btn network-crm__btn--primary';
    shareBtn.textContent = 'Share…';
    shareBtn.addEventListener('click', async () => {
      try {
        const res = await fetch(opts.imageUrl);
        const blob = await res.blob();
        const file = new File([blob], opts.downloadName, {
          type: blob.type || 'image/jpeg',
        });
        const payload = {
          title: opts.title,
          files: [file],
          ...(opts.linkUrl ? { url: opts.linkUrl } : {}),
        };
        if (navigator.canShare?.(payload) || navigator.canShare?.({ files: [file] })) {
          await navigator.share(payload);
        } else {
          await navigator.share({
            title: opts.title,
            ...(opts.linkUrl ? { url: opts.linkUrl } : { text: opts.title }),
          });
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
        downloadHref(opts.imageUrl, opts.downloadName);
      }
    });
    actions.append(shareBtn);
    parts.push(actions);
  }
  dialog.append(...parts);
  backdrop.append(dialog);

  function close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  closeBtn.focus();
}

/** Open LinkedIn / Facebook share picker, then the chosen asset. */
export function openShareContactInfoDialog() {
  const backdrop = document.createElement('div');
  backdrop.className = 'network-crm__img-pick-backdrop network-crm__share-backdrop';
  backdrop.setAttribute('role', 'presentation');

  const dialog = document.createElement('div');
  dialog.className = 'network-crm__img-pick-dialog network-crm__enrich-dialog network-crm__share-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Share Contact Info');

  const header = document.createElement('div');
  header.className = 'network-crm__img-pick-dialog-header';
  const title = document.createElement('h3');
  title.className = 'network-crm__img-pick-dialog-title';
  title.textContent = 'Share Contact Info';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'network-crm__btn network-crm__btn--tiny';
  closeBtn.textContent = 'Close';
  header.append(title, closeBtn);

  const hint = document.createElement('p');
  hint.className = 'network-crm__img-pick-hint muted';
  hint.textContent = 'Choose a channel to show your share card.';

  const listEl = document.createElement('div');
  listEl.className = 'network-crm__enrich-options';

  /**
   * @param {string} label
   * @param {string} desc
   * @param {() => void} onClick
   */
  function addOption(label, desc, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'network-crm__enrich-option';
    const textWrap = document.createElement('span');
    textWrap.className = 'network-crm__enrich-option-text';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const p = document.createElement('span');
    p.className = 'muted';
    p.textContent = desc;
    textWrap.append(strong, p);
    btn.append(textWrap);
    btn.addEventListener('click', onClick);
    listEl.append(btn);
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  addOption('LinkedIn', 'Show your LinkedIn contact card image', () => {
    close();
    openShareAssetDialog({
      title: 'LinkedIn contact card',
      imageUrl: LINKEDIN_CARD_URL,
      imageAlt: 'Jay Hasty LinkedIn contact card with QR code',
      downloadName: 'jay-hasty-linkedin-contact.jpeg',
    });
  });

  addOption('Facebook', 'Show a QR code for your Facebook profile', () => {
    close();
    openShareAssetDialog({
      title: 'Facebook profile QR',
      imageUrl: FACEBOOK_QR_URL,
      imageAlt: 'QR code linking to Facebook profile',
      caption: FACEBOOK_PROFILE_URL,
      linkUrl: FACEBOOK_PROFILE_URL,
      downloadName: 'jay-hasty-facebook-qr.png',
    });
  });

  dialog.append(header, hint, listEl);
  backdrop.append(dialog);

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  closeBtn.focus();
}
