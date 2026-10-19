import { createApp } from './miniHttp.js';
import { getDb, getDbPath } from './db.js';
import { requestLogger, log, getLogPath } from './middleware/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { registerIngredientRoutes } from './routes/ingredients.js';
import { registerPreferenceRoutes } from './routes/preferences.js';
import { registerPlanRoutes } from './routes/plans.js';
import { registerRagRoutes } from './routes/rag.js';
import { seedFromFile } from '../scripts/seed.js';
import { clearAllIngredients } from './services/inventoryService.js';

const PORT = Number(process.env.PORT || 3780);

getDb();

const app = createApp();
app.useRequest(requestLogger);
app.useError(errorHandler);

registerIngredientRoutes(app);
registerPreferenceRoutes(app);
registerPlanRoutes(app);
registerRagRoutes(app);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'fridge-matcher',
    db: getDbPath(),
    log: getLogPath(),
  });
});

app.post('/api/dev/seed', (_req, res) => {
  const count = seedFromFile();
  res.json({ ok: true, count });
});

app.post('/api/dev/clear', (_req, res) => {
  clearAllIngredients();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  log('info', 'server_started', { port: PORT, db: getDbPath() });
  console.log(`fridge-matcher running at http://localhost:${PORT}`);
});
