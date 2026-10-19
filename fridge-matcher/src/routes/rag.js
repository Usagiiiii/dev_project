import { ask, getKbOverview } from '../services/ragService.js';

export function registerRagRoutes(app) {
  // 一次 RAG / 直接模型问答（实验5 2.6 接口入口）
  app.post('/api/rag/ask', async (req, res) => {
    const body = await req.json();
    const question = String(body?.question || '').trim();
    if (!question) {
      res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: '问题不能为空' } });
      return;
    }
    const result = await ask(question, {
      useRag: body?.use_rag !== false,
      topK: Number(body?.top_k) || 3,
      mock: body?.mock || {},
    });
    res.json({ ok: true, data: result });
  });

  // 知识库概览（供抽查片段与元数据，实验5 2.3）
  app.get('/api/rag/kb', (_req, res) => {
    res.json({ ok: true, data: getKbOverview() });
  });
}
