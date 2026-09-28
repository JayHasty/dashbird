/**
 * Persist exported DEV NOTES for Cursor agents (climate-dash kanban export analogue).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEV_NOTES_PATH = path.join(root, 'data', 'dev-notes.md');

const PAGE_LABELS = {
  main: 'Main',
  now: 'Now',
  network: 'Network',
  'house-hunter': 'House Hunter',
  settings: 'Settings',
};

/**
 * @param {string} pageId
 * @returns {string}
 */
export function pageLabelForId(pageId) {
  const id = String(pageId || 'main').trim() || 'main';
  return PAGE_LABELS[id] || id;
}

/**
 * @param {string} pageId
 * @returns {string}
 */
export function devNotesTicketTitle(pageId) {
  return `${pageLabelForId(pageId)} dev change requests`;
}

/**
 * @returns {Promise<string>}
 */
export async function readDevNotesFile() {
  try {
    return await readFile(DEV_NOTES_PATH, 'utf8');
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return '';
    throw e;
  }
}

/**
 * Append an exported sticky dump. Tasks are one bullet per non-empty line.
 * @param {string} pageId
 * @param {string} content
 * @returns {Promise<{ title: string, path: string }>}
 */
export async function exportDevNotes(pageId, content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) {
    const err = new Error('Nothing to export — add notes first.');
    err.code = 'empty';
    throw err;
  }

  const id = String(pageId || 'main').trim() || 'main';
  const title = devNotesTicketTitle(id);
  const exportedAt = new Date().toISOString();
  const bullets = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) return `- [ ] ${line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '')}`;
      return `- [ ] ${line}`;
    });

  const block = [
    `## ${title}`,
    '',
    `<!-- [dev-notes:${id}] exported: ${exportedAt} -->`,
    `Page: ${id}`,
    `Exported: ${exportedAt}`,
    '',
    ...bullets,
    '',
  ].join('\n');

  await mkdir(path.dirname(DEV_NOTES_PATH), { recursive: true });
  let existing = await readDevNotesFile();
  if (!existing.trim()) {
    existing = '# Dashbird DEV NOTES\n\nExported from the floating sticky. Open Cursor and ask to spin up an agent for each open task.\n\n';
  } else if (!existing.endsWith('\n')) {
    existing += '\n';
  }

  await writeFile(DEV_NOTES_PATH, `${existing}${block}`, 'utf8');
  return { title, path: DEV_NOTES_PATH };
}

/**
 * Replace the whole file (e.g. after agents mark tasks done).
 * @param {string} markdown
 */
export async function writeDevNotesFile(markdown) {
  await mkdir(path.dirname(DEV_NOTES_PATH), { recursive: true });
  await writeFile(DEV_NOTES_PATH, String(markdown ?? ''), 'utf8');
}
