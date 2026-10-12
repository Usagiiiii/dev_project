import {
  listIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
  confirmIngredient,
  consumeIngredients,
  getIngredient,
} from '../services/inventoryService.js';

export function registerIngredientRoutes(app) {
  app.get('/api/ingredients', (req, res) => {
    const status = req.query.status || undefined;
    res.json({ ok: true, data: listIngredients({ status }) });
  });

  // 固定路径须写在 :id 之前
  app.post('/api/ingredients/consume', async (req, res) => {
    const body = await req.json();
    const data = consumeIngredients(body.items || [], body.action || 'consume');
    res.json({ ok: true, data });
  });

  app.post('/api/ingredients/:id/confirm', (req, res) => {
    res.json({ ok: true, data: confirmIngredient(Number(req.params.id)) });
  });

  app.get('/api/ingredients/:id', (req, res) => {
    res.json({ ok: true, data: getIngredient(Number(req.params.id)) });
  });

  app.post('/api/ingredients', async (req, res) => {
    const body = await req.json();
    res.status(201).json({ ok: true, data: createIngredient(body) });
  });

  app.put('/api/ingredients/:id', async (req, res) => {
    const body = await req.json();
    res.json({ ok: true, data: updateIngredient(Number(req.params.id), body) });
  });

  app.delete('/api/ingredients/:id', (req, res) => {
    res.json(deleteIngredient(Number(req.params.id)));
  });
}
