import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 使用独立测试库，避免污染真实 data/fridge.db（需在调用 getDb 前设置）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDb = path.resolve(__dirname, '../data/test-rag-fridge.db');
process.env.FRIDGE_DB_PATH = testDb;
process.env.LLM_MODE = 'mock';

import { loadKnowledgeBase, sampleChunks, kbStats } from '../src/services/knowledgeBase.js';
import { search } from '../src/services/retrieval.js';
import { buildMessages, buildSystemPrompt, PROMPT_VERSION } from '../src/services/promptTemplates.js';
import { callLLM, LLMError, getLLMMode } from '../src/services/modelClient.js';
import { ask } from '../src/services/ragService.js';
import { parseLLMOutput, guardAnswer } from '../src/services/ragGuard.js';
import { seedFromFile } from '../scripts/seed.js';
import { clearAllIngredients, listIngredients } from '../src/services/inventoryService.js';
import { getDb, closeDb } from '../src/db.js';

before(async () => {
  if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  getDb();
  seedFromFile(); // 样例库存：青菜/鸡蛋/番茄/豆腐/生姜/花生酱/疑似变质生菜，偏好含花生过敏
});

after(async () => {
  closeDb();
  try {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  } catch {
    // Windows 文件短暂占用，忽略
  }
});

test('KB-01 知识库加载：条目数与元数据完整', () => {
  const { meta, chunks } = loadKnowledgeBase();
  assert.ok(chunks.length >= 10, `片段数 ${chunks.length} 应 >= 10`);
  assert.ok(meta.chunk_strategy.includes('按条目切分'));
  for (const c of chunks) {
    assert.ok(c.id && /^KB-\d{2}$/.test(c.id));
    assert.ok(c.title && c.source && c.content && Array.isArray(c.tags));
    assert.ok(c.content_len > 0);
  }
});

test('KB-02 切分抽查：抽样片段字段完整且不重叠', () => {
  const samples = sampleChunks(3);
  assert.equal(samples.length, 3);
  const ids = new Set(samples.map((s) => s.id));
  assert.equal(ids.size, 3, '抽查片段不应重复');
  for (const s of samples) {
    assert.ok(s.title && s.source && s.content && s.content_len > 0 && Array.isArray(s.tags));
  }
  const stats = kbStats();
  assert.equal(stats.overlap, false, '按条目切分不应有重叠');
});

test('RET-01 检索：豆腐查询命中家常豆腐做法（KB-08）', async () => {
  const results = await search('豆腐怎么做好吃？', { topK: 3 });
  assert.ok(results.length >= 1);
  const topIds = results.map((r) => r.chunk.id);
  assert.ok(topIds.includes('KB-08'), `Top-k 应包含 KB-08，实际 ${topIds.join(',')}`);
  assert.ok(results[0].score >= results[results.length - 1].score, '应按得分降序');
});

test('RET-02 检索：青菜+鸡蛋查询命中青菜蛋花汤（KB-06）', async () => {
  const results = await search('青菜和鸡蛋能做什么菜？', { topK: 3 });
  assert.ok(results.some((r) => r.chunk.id === 'KB-06'));
});

test('RET-03 检索：异味发黏命中食品安全片段（KB-09）', async () => {
  const results = await search('食材有异味发黏还能吃吗？', { topK: 3 });
  assert.ok(results.some((r) => r.chunk.id === 'KB-09'));
});

test('RET-04 检索：知识库无答案的问题返回空（不强行给结果）', async () => {
  const results = await search('明天天气怎么样？', { topK: 3, minScore: 0.1 });
  assert.equal(results.length, 0, '无相关资料时应返回空数组');
});

test('PROMPT-01 原版 V1：RAG 组含资料编号与来源，直接组不含', () => {
  assert.equal(PROMPT_VERSION, 'v1');
  const inventory = [{ name: '青菜', quantity: 1, unit: '把', days_left: 1, life_level: 'critical', status: 'available' }];
  const chunks = [
    { chunk: { id: 'KB-06', title: '青菜蛋花汤的做法', source: '自建整理', content: '青菜洗净切段……' }, score: 0.9, matched: ['青菜', '鸡蛋'] },
  ];
  const rag = buildMessages('rag', { question: '青菜鸡蛋做什么？', inventory, preferences: {}, chunks });
  const direct = buildMessages('direct', { question: '青菜鸡蛋做什么？', inventory, preferences: {} });
  const ragUser = rag.messages[1].content;
  const directUser = direct.messages[1].content;
  assert.ok(ragUser.includes('[KB-06]'), 'RAG 组应包含资料编号');
  assert.ok(ragUser.includes('来源：'), 'RAG 组应包含来源');
  assert.ok(!directUser.includes('[KB-'), '直接组不应包含检索资料');
  assert.ok(buildSystemPrompt().includes('禁止虚构任何库存食材'));
  assert.ok(rag.context_chars > 0 && rag.prompt_tokens_estimate > 0);
});

test('LLM-01 占位接口：mock 成功返回与用量估算', async () => {
  const res = await callLLM({
    messages: [{ role: 'user', content: '你好' }],
    mock: { reply: '{"ok":true}' },
  });
  assert.equal(res.mode, 'mock');
  assert.equal(res.text, '{"ok":true}');
  assert.ok(res.usage.prompt_tokens_estimate > 0);
  assert.equal(getLLMMode(), 'mock');
});

test('LLM-02 占位接口：模拟超时抛出 LLM_TIMEOUT', async () => {
  await assert.rejects(
    callLLM({ messages: [{ role: 'user', content: 'hi' }], mock: { mode: 'timeout', timeoutMs: 30 } }),
    (err) => err instanceof LLMError && err.code === 'LLM_TIMEOUT'
  );
});

test('LLM-03 占位接口：模拟服务不可用抛出 LLM_SERVICE_UNAVAILABLE', async () => {
  await assert.rejects(
    callLLM({ messages: [{ role: 'user', content: 'hi' }], mock: { mode: 'error' } }),
    (err) => err instanceof LLMError && err.code === 'LLM_SERVICE_UNAVAILABLE'
  );
});

test('LLM-04 占位接口：API 模式未配置时明确报错', async () => {
  const prev = process.env.LLM_MODE;
  process.env.LLM_MODE = 'api';
  delete process.env.LLM_API_URL;
  delete process.env.LLM_API_KEY;
  try {
    await assert.rejects(
      callLLM({ messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err instanceof LLMError && err.code === 'LLM_NOT_CONFIGURED'
    );
  } finally {
    process.env.LLM_MODE = prev;
  }
});

test('RAG-01 最小链路：RAG 组带检索片段、回答带引用并通过校验', async () => {
  const r = await ask('番茄和鸡蛋能做什么家常菜？', { useRag: true, topK: 3 });
  assert.equal(r.ok, true, JSON.stringify(r.guard_issues));
  assert.equal(r.source, 'rag');
  assert.ok(r.chunks.length >= 1, '应检索到片段');
  assert.ok(r.answer.title && Array.isArray(r.answer.steps));
  assert.ok(r.answer.references.includes('KB-07'), `应引用 KB-07，实际 ${JSON.stringify(r.answer.references)}`);
  assert.ok(r.prompt.kind === 'rag' && r.prompt.version === 'v1');
  assert.ok(r.elapsed_ms >= 0);
  assert.ok(r.usage.prompt_tokens_estimate > 0);
});

test('RAG-02 直接模型组：无资料注入，无引用', async () => {
  const r = await ask('番茄和鸡蛋能做什么家常菜？', { useRag: false });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'direct');
  assert.equal(r.chunks.length, 0);
  assert.deepEqual(r.answer.references, []);
});

test('RAG-03 失败处理：模型超时时返回降级结果而不是崩溃', async () => {
  const r = await ask('豆腐怎么做好吃？', { useRag: true, mock: { mode: 'timeout', timeoutMs: 30 } });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'model_unavailable');
  assert.equal(r.error.code, 'LLM_TIMEOUT');
  assert.ok(r.issues.length >= 1);
});

test('GUARD-01 输出校验：虚构库存食材被拦截', () => {
  const parsed = parseLLMOutput('{"title":"x","steps":["a"],"used_items":[{"name":"深海龙虾","quantity":1,"unit":"只"}]}');
  const guard = guardAnswer(parsed, {
    inventory: [{ name: '青菜', status: 'available' }],
    preferences: {},
    kbIds: ['KB-01'],
  });
  assert.equal(guard.ok, false);
  assert.ok(guard.issues.some((i) => i.code === 'FABRICATED_INVENTORY'));
});

test('GUARD-02 输出校验：过敏食材被拦截且阻止确认', () => {
  const parsed = parseLLMOutput(
    '{"title":"花生酱拌菜","steps":["a"],"used_items":[{"name":"花生酱","quantity":1,"unit":"瓶"}],"references":["KB-01"]}'
  );
  const guard = guardAnswer(parsed, {
    inventory: [{ name: '花生酱', status: 'available' }],
    preferences: { allergens: ['花生'] },
    kbIds: ['KB-01'],
  });
  assert.equal(guard.ok, false);
  assert.ok(guard.issues.some((i) => i.code === 'ALLERGEN_CONFLICT'));
});

test('GUARD-03 输出校验：无效引用被标记', () => {
  const parsed = parseLLMOutput(
    '{"title":"x","steps":["a"],"used_items":[{"name":"青菜","quantity":1,"unit":"把"}],"references":["KB-99"]}'
  );
  const guard = guardAnswer(parsed, {
    inventory: [{ name: '青菜', status: 'available' }],
    preferences: {},
    kbIds: ['KB-01'],
  });
  assert.ok(guard.issues.some((i) => i.code === 'INVALID_REFERENCE'));
});

test('GUARD-04 非法 JSON 输出被识别', () => {
  const guard = guardAnswer(parseLLMOutput('不是json'), { inventory: [], preferences: {}, kbIds: [] });
  assert.equal(guard.ok, false);
  assert.ok(guard.issues.some((i) => i.code === 'INVALID_JSON'));
});

test('GUARD-05 自然语言包裹的 JSON 也能解析（真实模型容错）', () => {
  const parsed = parseLLMOutput(
    '好的，根据资料为你生成方案：{"title":"番茄炒蛋","steps":["a"],"used_items":[{"name":"番茄","quantity":1,"unit":"个"}]} 希望有帮助！'
  );
  assert.ok(parsed, '应能从自然语言中提取 JSON');
  assert.equal(parsed.title, '番茄炒蛋');
});

test('RAG-04 空库存时提示信息不足，不编造方案', async () => {
  clearAllIngredients();
  const r = await ask('有什么能做的菜？', { useRag: true });
  assert.equal(r.ok, true);
  assert.ok(r.answer.error === 'INSUFFICIENT_INFO', '应返回信息不足而不是虚构方案');
  seedFromFile(); // 恢复样例库存，避免影响其它测试
  assert.ok(listIngredients().length > 0);
});

test('RAG-05 检索无相关资料时明确提示资料不足，不编造', async () => {
  const r = await ask('教我做佛跳墙的做法', { useRag: true, topK: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.chunks.length, 0, '无关问题不应检索到片段');
  assert.equal(r.answer.error, 'INSUFFICIENT_DOCS', '应提示资料不足');
});
