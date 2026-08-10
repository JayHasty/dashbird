/**
 * Tool Library persistence — data/tool-library.json + assets on disk.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { looksLikePublicHttpUrl } from './public-http-url.js';
import { fixHostOwnership } from './fix-host-ownership.js';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** @typedef {object} ToolRecord */
export const SEED_CATEGORIES = [
  'video',
  'audio',
  'audio-only',
  '3D modeling',
  'project mgmt',
  'design',
  'development',
  'writing',
  'automation',
  'AI',
  'notes',
  'communication',
  'finance',
  'security',
  'utilities',
];

export function toolLibraryPath(env = process.env) {
  const override = String(env.TOOL_LIBRARY_PATH || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/tool-library.json');
}

export function toolLibraryAssetsDir(env = process.env) {
  const override = String(env.TOOL_LIBRARY_ASSETS_DIR || '').trim();
  if (override) return override;
  return path.join(PKG_ROOT, 'data/tool-library-assets');
}

/**
 * @returns {Promise<{ version: number, tools: ToolRecord[] }>}
 */
export async function loadToolLibrary() {
  const p = toolLibraryPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const j = JSON.parse(raw);
    const tools = Array.isArray(j?.tools) ? j.tools : [];
    return { version: Number(j?.version) || 1, tools };
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
      return { version: 1, tools: [] };
    }
    throw e;
  }
}

/**
 * @param {{ version: number, tools: ToolRecord[] }} data
 */
/** Serialize mutations so concurrent favorite/asset updates cannot clobber the same .tmp. */
let toolLibraryWriteChain = Promise.resolve();

async function writeToolLibraryFile(data) {
  const p = toolLibraryPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, p);
    await fixHostOwnership(p);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * @param {{ version: number, tools: ToolRecord[] }} data
 */
export async function saveToolLibrary(data) {
  const next = toolLibraryWriteChain.then(
    () => writeToolLibraryFile(data),
    () => writeToolLibraryFile(data),
  );
  toolLibraryWriteChain = next.catch(() => {});
  await next;
}

/**
 * @param {ToolRecord[]} tools
 */
export function collectCategories(tools) {
  const set = new Set(SEED_CATEGORIES);
  for (const t of tools) {
    for (const c of t.categories || []) {
      const s = String(c || '').trim();
      if (s) set.add(s);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {ToolRecord} tool
 */
export async function addTool(tool) {
  const data = await loadToolLibrary();
  data.tools.push(tool);
  await saveToolLibrary(data);
  return tool;
}

/**
 * @param {string} id
 */
export async function getToolById(id) {
  const data = await loadToolLibrary();
  return data.tools.find((t) => t.id === id) ?? null;
}

/**
 * @param {string[]} ids
 */
export async function deleteTools(ids) {
  const drop = new Set(ids.map((x) => String(x)));
  const data = await loadToolLibrary();
  const before = data.tools.length;
  data.tools = data.tools.filter((t) => !drop.has(t.id));
  await saveToolLibrary(data);
  return { removed: before - data.tools.length };
}

/**
 * @param {string} id
 * @param {boolean} favorite
 */
export async function setToolFavorite(id, favorite) {
  const run = async () => {
    const data = await loadToolLibrary();
    const tool = data.tools.find((t) => t.id === id);
    if (!tool) return null;
    tool.favorite = Boolean(favorite);
    await writeToolLibraryFile(data);
    return tool;
  };
  const next = toolLibraryWriteChain.then(run, run);
  toolLibraryWriteChain = next.catch(() => {});
  return next;
}

/**
 * Mark whether Jay is currently paying for this tool (money icon on card).
 * @param {string} id
 * @param {boolean} paying
 * @param {{ url?: string }} [opts] — also match by URL when id is missing/catalog-only
 */
export async function setToolPaying(id, paying, opts = {}) {
  const run = async () => {
    const data = await loadToolLibrary();
    let tool = data.tools.find((t) => t.id === id);
    if (!tool && opts.url) {
      try {
        const want = normalizeToolUrl(opts.url).toLowerCase();
        tool = data.tools.find((t) => {
          try {
            return normalizeToolUrl(t.url || t.website || '').toLowerCase() === want;
          } catch {
            return false;
          }
        });
      } catch {
        /* ignore bad url */
      }
    }
    if (!tool) return null;
    tool.paying = Boolean(paying);
    await writeToolLibraryFile(data);
    return tool;
  };
  const next = toolLibraryWriteChain.then(run, run);
  toolLibraryWriteChain = next.catch(() => {});
  return next;
}

/** Metadata fields a user may hand-edit on a tool card. */
export const EDITABLE_TOOL_FIELDS = [
  'name',
  'url',
  'website',
  'bestUsedFor',
  'categories',
  'operatingSystems',
  'pricing',
  'rating',
  'ratingSource',
  'features',
  'pros',
  'cons',
];

/**
 * Merge a whitelisted metadata patch onto an existing tool. Preserves id/addedAt.
 * @param {string} id
 * @param {Partial<ToolRecord>} patch
 * @returns {Promise<ToolRecord | null>}
 */
export async function updateTool(id, patch = {}) {
  const editable = new Set(EDITABLE_TOOL_FIELDS);
  const run = async () => {
    const data = await loadToolLibrary();
    const idx = data.tools.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const prev = data.tools[idx];
    const next = { ...prev };
    for (const [key, value] of Object.entries(patch)) {
      if (!editable.has(key)) continue;
      next[key] = value;
    }
    next.id = prev.id;
    next.addedAt = prev.addedAt;
    next.updatedAt = new Date().toISOString();
    data.tools[idx] = next;
    await writeToolLibraryFile(data);
    return next;
  };
  const next = toolLibraryWriteChain.then(run, run);
  toolLibraryWriteChain = next.catch(() => {});
  return next;
}

/**
 * @param {string} url
 */
export function normalizeToolUrl(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('url_required');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_url');
  parsed.hash = '';
  // Sync reject of literal private/local hosts; DNS-aware check runs at fetch time.
  if (!looksLikePublicHttpUrl(parsed.toString())) throw new Error('url_not_public');
  return parsed.toString();
}

/**
 * @param {string} toolId
 * @param {Buffer} buf
 * @param {string} ext
 */
export async function saveToolAsset(toolId, kind, buf, ext = 'png') {
  const dir = toolLibraryAssetsDir();
  await fs.mkdir(dir, { recursive: true });
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'png';
  const name = `${toolId}-${kind}.${safeExt}`;
  const fp = path.join(dir, name);
  await fs.writeFile(fp, buf);
  await fixHostOwnership([dir, fp]);
  return `/api/tool-library/assets/${name}`;
}

export function newToolId() {
  return randomUUID();
}
