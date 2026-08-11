/**
 * GET/PUT /api/daily-scratch — floating scratch pad body (position stays in the browser).
 */
import { Router } from 'express';
import express from 'express';
import {
  DAILY_SCRATCH_CONTENT_MAX,
  loadDailyScratchFile,
  saveDailyScratchFile,
} from '../lib/daily-scratch-store.js';

const router = Router();
router.use(express.json({ limit: '64kb' }));

router.get('/', async (_req, res) => {
  try {
    const note = await loadDailyScratchFile();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, note });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.put('/', async (req, res) => {
  try {
    if (req.body?.content === undefined) {
      res.status(400).json({ ok: false, error: 'content_required' });
      return;
    }
    const content = String(req.body.content ?? '');
    if (content.length > DAILY_SCRATCH_CONTENT_MAX) {
      res.status(400).json({ ok: false, error: 'content_too_long' });
      return;
    }
    const note = await saveDailyScratchFile(content);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, note });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
