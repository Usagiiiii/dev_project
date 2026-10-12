import { generatePlans, getPlan, confirmPlan } from '../services/planService.js';

export function registerPlanRoutes(app) {
  app.post('/api/plans/generate', async (req, res) => {
    const body = await req.json();
    const result = generatePlans(body || {});
    res.json({ ok: true, ...result });
  });

  app.get('/api/plans/:id', (req, res) => {
    res.json({ ok: true, data: getPlan(Number(req.params.id)) });
  });

  app.post('/api/plans/:id/confirm', async (req, res) => {
    const body = await req.json();
    const result = confirmPlan(Number(req.params.id), body || {});
    res.json({ ok: true, data: result });
  });
}
