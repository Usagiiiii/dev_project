import { getPreferences, updatePreferences } from '../services/preferenceService.js';

export function registerPreferenceRoutes(app) {
  app.get('/api/preferences', (_req, res) => {
    res.json({ ok: true, data: getPreferences() });
  });

  app.put('/api/preferences', async (req, res) => {
    const body = await req.json();
    res.json({ ok: true, data: updatePreferences(body) });
  });
}
