/**
 * Google Keep-style scratch notes — text files with optional image/voice attachment.
 */
import { Router } from 'express';
import express from 'express';
import { createReadStream } from 'node:fs';
import {
  bulkKeepNotesAction,
  clearKeepNoteAttachment,
  createKeepNote,
  deleteKeepNote,
  getKeepNote,
  KEEP_NOTES_ROOT,
  keepNoteAttachmentFile,
  listKeepNoteCategories,
  listKeepNotes,
  rememberKeepNoteCategory,
  reorderKeepNotes,
  setKeepNoteAttachment,
  updateKeepNote,
} from '../lib/keep-notes-store.js';
import { importKeepTakeout, listKeepImportFiles } from '../lib/keep-notes-import.js';

const router = Router();
router.use(express.json({ limit: '14mb' }));

router.get('/meta', (_req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ ok: true, root: KEEP_NOTES_ROOT });
});

router.get('/categories', async (_req, res) => {
  try {
    const categories = await listKeepNoteCategories();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, categories });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const categories = await rememberKeepNoteCategory(req.body?.category ?? req.body?.name);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ ok: true, categories });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** How many Takeout files are staged for import in data/keep-import/. */
router.get('/import', async (_req, res) => {
  try {
    const staged = await listKeepImportFiles();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      root: staged.root,
      jsonCount: staged.jsonCount,
      htmlCount: staged.htmlCount,
      total: staged.total,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** Parse staged Google Takeout Keep files and create notes. */
router.post('/import', async (req, res) => {
  try {
    const includeArchived = req.body?.includeArchived === true;
    const summary = await importKeepTakeout(process.env, { includeArchived });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/', async (req, res) => {
  try {
    const archivedQ = String(req.query?.archived || '').trim().toLowerCase();
    const archived = archivedQ === '1' || archivedQ === 'true';
    const notes = await listKeepNotes(process.env, { archived });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, notes, archived });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const note = await getKeepNote(String(req.params.id || ''));
    if (!note) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, note });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/', async (req, res) => {
  try {
    const note = await createKeepNote({
      title: req.body?.title,
      body: req.body?.body,
      pinned: req.body?.pinned,
      category: req.body?.category,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ ok: true, note });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/bulk', async (req, res) => {
  try {
    const action = String(req.body?.action || '').trim().toLowerCase();
    const result = await bulkKeepNotesAction(req.body?.ids, action);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...result });
  } catch (e) {
    const code = String(e?.code || '');
    const map = {
      invalid_ids: 400,
      invalid_action: 400,
      bulk_failed: 400,
    };
    res.status(map[code] || 500).json({
      ok: false,
      error: String(e?.message || e),
      code: code || undefined,
    });
  }
});

router.post('/reorder', async (req, res) => {
  try {
    const notes = await reorderKeepNotes({
      pinned: req.body?.pinned,
      others: req.body?.others,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, notes });
  } catch (e) {
    const code = String(e?.code || '');
    const map = {
      invalid_ids: 400,
      invalid_section: 400,
      not_found: 404,
    };
    res.status(map[code] || 500).json({
      ok: false,
      error: String(e?.message || e),
      code: code || undefined,
    });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const patch = {
      title: req.body?.title,
      body: req.body?.body,
      pinned: req.body?.pinned,
      archived: req.body?.archived,
    };
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'category')) {
      patch.category = req.body.category;
    }
    const note = await updateKeepNote(String(req.params.id || ''), patch);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, note });
  } catch (e) {
    const code = String(e?.code || '');
    res.status(code === 'not_found' ? 404 : 500).json({
      ok: false,
      error: String(e?.message || e),
      code: code || undefined,
    });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteKeepNote(String(req.params.id || ''));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true });
  } catch (e) {
    const code = String(e?.code || '');
    res.status(code === 'not_found' ? 404 : 500).json({
      ok: false,
      error: String(e?.message || e),
      code: code || undefined,
    });
  }
});

router.post('/:id/attachment', async (req, res) => {
  try {
    const note = await setKeepNoteAttachment(String(req.params.id || ''), req.body || {});
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, note });
  } catch (e) {
    const code = String(e?.code || '');
    const map = {
      not_found: 404,
      invalid_attachment: 400,
      invalid_attachment_type: 400,
      invalid_attachment_size: 400,
    };
    res.status(map[code] || 500).json({
      ok: false,
      error: String(e?.message || e),
      code: code || undefined,
    });
  }
});

router.delete('/:id/attachment', async (req, res) => {
  try {
    const note = await clearKeepNoteAttachment(String(req.params.id || ''));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, note });
  } catch (e) {
    const code = String(e?.code || '');
    res.status(code === 'not_found' ? 404 : 500).json({
      ok: false,
      error: String(e?.message || e),
      code: code || undefined,
    });
  }
});

router.get('/:id/attachment/:filename', async (req, res) => {
  try {
    const file = await keepNoteAttachmentFile(
      String(req.params.id || ''),
      String(req.params.filename || ''),
    );
    const total = file.size;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    const rangeHeader = String(req.headers.range || '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : total - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= total || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      createReadStream(file.path, { start, end }).pipe(res);
      return;
    }
    res.setHeader('Content-Length', String(total));
    createReadStream(file.path).pipe(res);
  } catch (e) {
    const code = String(e?.code || '');
    res.status(code === 'not_found' ? 404 : 500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

export default router;
