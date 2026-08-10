import { Router } from 'express';
import { getGeoelectricFieldPayload } from '../lib/geoelectric-field.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const data = await getGeoelectricFieldPayload();
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
