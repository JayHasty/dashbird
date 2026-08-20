/**
 * Read/write helpers for the bookmark tile files served at
 * `/data/bookmarks-personal.json` and `/data/bookmarks-work.json`.
 *
 * These power the Bookmarks panel add/delete UI. Files keep the shape
 * `{ sections: [{ title, items: [{ word, href, title?, icon? }] }] }`.
 *
 * Writes are atomic (tmp + rename) and serialized per scope so a crash or
 * concurrent edit cannot leave a truncated/corrupt live JSON file — that used
 * to surface in the UI as "Invalid JSON in bookmark file" (SPA HTML fallback).
 */
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixHostOwnership } from './fix-host-ownership.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const dataDir = path.join(root, 'public', 'data');

const SCOPES = {
  personal: 'bookmarks-personal.json',
  work: 'bookmarks-work.json',
};

/** @type {Map<string, Promise<unknown>>} */
const scopeWriteChains = new Map();

class BookmarkError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function scopeFile(scope) {
  const key = String(scope || '').trim().toLowerCase();
  if (!SCOPES[key]) throw new BookmarkError('invalid_scope', `Unknown scope: ${scope}`);
  return path.join(dataDir, SCOPES[key]);
}

/**
 * Run bookmark mutations one-at-a-time per scope (read-modify-write safety).
 * @template T
 * @param {string} scope
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withScopeLock(scope, fn) {
  const key = String(scope || '').trim().toLowerCase();
  const prev = scopeWriteChains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  scopeWriteChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function normalizeBookmarkData(data) {
  if (!data || !Array.isArray(data.sections)) return { sections: [] };
  return data;
}

/**
 * @param {string} filePath
 * @returns {Promise<{ ok: true, data: { sections: unknown[] } } | { ok: false, missing: boolean }>}
 */
async function tryReadBookmarkFile(filePath) {
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, missing: false };
  }
  if (!String(raw).trim()) return { ok: false, missing: false };
  try {
    return { ok: true, data: normalizeBookmarkData(JSON.parse(raw)) };
  } catch {
    return { ok: false, missing: false };
  }
}

async function readScope(scope) {
  const file = scopeFile(scope);
  const bak = `${file}.bak`;

  const primary = await tryReadBookmarkFile(file);
  if (primary.ok) return primary.data;

  const backup = await tryReadBookmarkFile(bak);
  if (backup.ok) {
    // Heal a truncated/corrupt live file from the last good write.
    await writeScopeAtomic(file, backup.data);
    return backup.data;
  }

  if (primary.missing) return { sections: [] };
  throw new BookmarkError('invalid_json', 'Bookmark file is not valid JSON');
}

/**
 * Write bookmark JSON without truncating the live file first.
 * @param {string} file
 * @param {{ sections: unknown[] }} data
 */
async function writeScopeAtomic(file, data) {
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const bak = `${file}.bak`;
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, body, 'utf8');
    try {
      await copyFile(file, bak);
    } catch {
      /* first write — no prior file to back up */
    }
    await rename(tmp, file);
    await fixHostOwnership([file, bak]);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

async function writeScope(scope, data) {
  await writeScopeAtomic(scopeFile(scope), data);
}

function normStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function isValidHref(href) {
  const h = normStr(href);
  if (!h) return false;
  // Allow http(s) plus the app's custom launch schemes.
  if (/^https?:\/\//i.test(h)) return true;
  if (/^(cursor|signal|command):/i.test(h)) return true;
  if (/^\/api\/open-desktop\//i.test(h)) return true;
  return false;
}

/**
 * Add a bookmark item to a section (section is created if missing).
 * @param {string} scope
 * @param {{ section: string, word: string, href: string, title?: string, icon?: string }} input
 */
export async function addBookmark(scope, input) {
  const section = normStr(input?.section);
  const word = normStr(input?.word);
  const href = normStr(input?.href);
  const title = normStr(input?.title);
  const icon = normStr(input?.icon);

  if (!section) throw new BookmarkError('invalid_section', 'Section is required');
  if (!word) throw new BookmarkError('invalid_word', 'Name is required');
  if (!isValidHref(href)) throw new BookmarkError('invalid_href', 'A valid URL is required');

  return withScopeLock(scope, async () => {
    const data = await readScope(scope);
    let sec = data.sections.find(
      (s) => s && normStr(s.title).toLowerCase() === section.toLowerCase(),
    );
    if (!sec) {
      sec = { title: section, items: [] };
      data.sections.push(sec);
    }
    if (!Array.isArray(sec.items)) sec.items = [];

    const item = { word, href };
    if (title) item.title = title;
    if (icon) item.icon = icon;
    sec.items.push(item);

    await writeScope(scope, data);
    return data;
  });
}

/**
 * Delete a bookmark item from a section by matching href (and word when given).
 * @param {string} scope
 * @param {{ section: string, href: string, word?: string }} input
 */
export async function deleteBookmark(scope, input) {
  const section = normStr(input?.section);
  const href = normStr(input?.href);
  const word = normStr(input?.word);
  if (!section) throw new BookmarkError('invalid_section', 'Section is required');
  if (!href) throw new BookmarkError('invalid_href', 'href is required');

  return withScopeLock(scope, async () => {
    const data = await readScope(scope);
    const sec = data.sections.find(
      (s) => s && normStr(s.title).toLowerCase() === section.toLowerCase(),
    );
    if (!sec || !Array.isArray(sec.items)) throw new BookmarkError('not_found', 'Section not found');

    const before = sec.items.length;
    sec.items = sec.items.filter((it) => {
      if (!it) return false;
      const hrefMatch = normStr(it.href) === href;
      const wordMatch = word ? normStr(it.word).toLowerCase() === word.toLowerCase() : true;
      return !(hrefMatch && wordMatch);
    });
    if (sec.items.length === before) throw new BookmarkError('not_found', 'Bookmark not found');

    // Drop the section entirely if it became empty.
    data.sections = data.sections.filter((s) => s && Array.isArray(s.items) && s.items.length > 0);

    await writeScope(scope, data);
    return data;
  });
}

function itemKey(section, word, href) {
  return `${normStr(section).toLowerCase()}||${normStr(word).toLowerCase()}||${normStr(href)}`;
}

/**
 * Delete several bookmarks at once.
 * @param {string} scope
 * @param {Array<{ section: string, href: string, word?: string }>} items
 */
export async function bulkDeleteBookmarks(scope, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BookmarkError('invalid_items', 'No bookmarks selected');
  }
  const keys = new Set(items.map((k) => itemKey(k?.section, k?.word, k?.href)));
  return withScopeLock(scope, async () => {
    const data = await readScope(scope);
    let removed = 0;
    for (const sec of data.sections) {
      if (!sec || !Array.isArray(sec.items)) continue;
      const before = sec.items.length;
      sec.items = sec.items.filter(
        (it) => !keys.has(itemKey(sec.title, it?.word, it?.href)),
      );
      removed += before - sec.items.length;
    }
    if (removed === 0) throw new BookmarkError('not_found', 'No matching bookmarks found');
    data.sections = data.sections.filter((s) => s && Array.isArray(s.items) && s.items.length > 0);
    await writeScope(scope, data);
    return data;
  });
}

/**
 * Replace the ordering / section membership of bookmarks. The client sends the
 * desired layout as sections of `{ word, href }` refs; we rebuild using the full
 * stored item objects (preserving icon/title). Any stored items missing from the
 * payload are preserved (appended to their original section) to avoid data loss.
 * @param {string} scope
 * @param {{ sections: Array<{ title: string, items: Array<{ word: string, href: string }> }> }} layout
 */
export async function setBookmarkLayout(scope, layout) {
  if (!layout || !Array.isArray(layout.sections)) {
    throw new BookmarkError('invalid_layout', 'Layout must include sections');
  }
  return withScopeLock(scope, async () => {
    const data = await readScope(scope);

    const map = new Map();
    for (const sec of data.sections) {
      for (const it of sec.items || []) {
        if (!it) continue;
        const key = `${normStr(it.word).toLowerCase()}||${normStr(it.href)}`;
        if (!map.has(key)) map.set(key, it);
      }
    }

    const outSections = [];
    for (const sec of layout.sections) {
      const title = normStr(sec?.title);
      if (!title) continue;
      const outItems = [];
      for (const ref of Array.isArray(sec?.items) ? sec.items : []) {
        const key = `${normStr(ref?.word).toLowerCase()}||${normStr(ref?.href)}`;
        const full = map.get(key);
        if (full) {
          outItems.push(full);
          map.delete(key);
        }
      }
      if (outItems.length > 0) outSections.push({ title, items: outItems });
    }

    // Preserve any stored items the client didn't list (keeps data safe).
    if (map.size > 0) {
      for (const sec of data.sections) {
        const leftovers = (sec.items || []).filter((it) => {
          const key = `${normStr(it?.word).toLowerCase()}||${normStr(it?.href)}`;
          return map.has(key);
        });
        if (leftovers.length === 0) continue;
        let target = outSections.find(
          (s) => s.title.toLowerCase() === normStr(sec.title).toLowerCase(),
        );
        if (!target) {
          target = { title: sec.title, items: [] };
          outSections.push(target);
        }
        for (const it of leftovers) {
          target.items.push(it);
          map.delete(`${normStr(it.word).toLowerCase()}||${normStr(it.href)}`);
        }
      }
    }

    data.sections = outSections;
    await writeScope(scope, data);
    return data;
  });
}

export { BookmarkError, readScope };
