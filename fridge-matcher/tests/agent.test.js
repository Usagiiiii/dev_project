import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 独立测试库，避免污染真实 data/fridge.db（需在调用 getDb 前设置）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDb = path.resolve(__dirname, '../data/test-agent-fridge.db');
process.env.FRIDGE_DB_PATH = testDb;
process.env.LLM_MODE = 'mock';

import { runAgentTask } from '../src/services/harness.js';
import { executeTool, validateArgs, TOOL_REGISTRY, ToolError } from '../src/services/tools.js';
import { parseAgentOutput, AGENT_LIMITS } from '../src/services/agent.js';
import { clearAllIngredients, listIngredients, createIngredient } from '../src/services/inventoryService.js';
import { updatePreferences } from '../src/services/preferenceService.js';
import { getDb, closeDb } from '../src/db.js';

before(() => {
  if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  getDb();
  testSeed();
});

after(() => {
  closeDb();
  try {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  } catch {
    // Windows 文件短暂占用，忽略
  }
});

beforeEach(() => {
  testSeed(); // 每个用例重置库存与偏好，保证独立性
});

/** 本地日期字符串（YYYY-MM-DD）：相对今天偏移 offsetDays 天，避免写死日期随时间推移失效 */
function daysFromNow(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 测试专用库存：以「今天」为基准动态生成，覆盖 ok / warn / critical / needs_confirm / expired
 * 各寿命等级（阈值见 lifeService：≤2 天 critical、≤4 天 warn、>4 天 ok、<0 过期），
 * 便于验证成功标准中的禁用规则与临期优先。写死日期会随时间过期导致用例失效。
 */
function testSeed() {
  getDb();
  clearAllIngredients();
  const items = [
    { name: '青菜', quantity: 1, unit: '把', expiry_date: daysFromNow(26), storage: '冷藏抽屉', notes: '' }, // ok
    { name: '鸡蛋', quantity: 6, unit: '枚', expiry_date: daysFromNow(3), storage: '冷藏', notes: '' }, // warn
    { name: '番茄', quantity: 4, unit: '个', expiry_date: daysFromNow(7), storage: '冷藏', notes: '' }, // ok
    { name: '豆腐', quantity: 1, unit: '盒', expiry_date: daysFromNow(1), storage: '冷藏', notes: '' }, // critical
    { name: '生姜', quantity: 0.5, unit: '块', expiry_date: daysFromNow(22), storage: '冷藏', notes: '' }, // ok
    { name: '花生酱', quantity: 1, unit: '瓶', expiry_date: daysFromNow(60), storage: '常温', notes: '' }, // ok（过敏不可用）
    { name: '生菜', quantity: 1, unit: '把', expiry_date: daysFromNow(1), storage: '冷藏', notes: '有异味、表面发黏' }, // → needs_confirm
    { name: '洋葱', quantity: 2, unit: '个', expiry_date: daysFromNow(-10), storage: '常温', notes: '' }, // → expired
  ];
  for (const it of items) {
    createIngredient({ ...it, status: 'available', allow_duplicate: true });
  }
  updatePreferences({
    taste: '清淡',
    servings: 1,
    max_minutes: 20,
    cookware: ['炒锅'],
    allergens: ['花生'],
    dislikes: [],
    only_use_inventory: false,
    max_purchases: 2,
  });
}

/** 构造按 step 返回预设文本的模型替换（模拟模型决策序列） */
function mockLLMSequence(sequence, { repeatLast = false } = {}) {
  return async ({ step }) => {
    if (step <= sequence.length) return sequence[step - 1];
    return repeatLast ? sequence[sequence.length - 1] : sequence[sequence.length - 1];
  };
}

const FINAL_PLAN = JSON.stringify({
  final: {
    title: '番茄炒蛋',
    reason: '依据库存与菜谱资料',
    cooking_minutes: 15,
    used_items: [{ name: '番茄', quantity: 2, unit: '个' }, { name: '鸡蛋', quantity: 3, unit: '枚' }],
    steps: ['番茄切块', '鸡蛋打散炒熟', '合炒调味'],
    references: ['KB-07'],
  },
});

const FINAL_TOMATO = JSON.stringify({
  final: {
    title: '凉拌番茄',
    reason: '依据库存与菜谱资料',
    cooking_minutes: 10,
    used_items: [{ name: '番茄', quantity: 2, unit: '个' }],
    steps: ['番茄切块', '调味装盘'],
    references: ['KB-07'],
  },
});

/* ------------------------------------------------------------------ */
/* 2.2 工具接口与参数约束                                               */
/* ------------------------------------------------------------------ */

test('TOOL-01 Schema 校验：正确参数通过，错误类型/缺失必填被拦截', () => {
  // search_recipe：ingredients 必填且必须是数组
  assert.equal(validateArgs(TOOL_REGISTRY.search_recipe.schema, { ingredients: ['番茄', '鸡蛋'], top_k: 3 }).ok, true);
  const bad1 = validateArgs(TOOL_REGISTRY.search_recipe.schema, { ingredients: '番茄' });
  assert.equal(bad1.ok, false);
  assert.ok(bad1.errors.some((e) => e.includes('类型应为 array')));
  const bad2 = validateArgs(TOOL_REGISTRY.search_recipe.schema, {});
  assert.equal(bad2.ok, false);
  assert.ok(bad2.errors.some((e) => e.includes('缺少必填参数 "ingredients"')));
  // top_k 越界
  const bad3 = validateArgs(TOOL_REGISTRY.search_recipe.schema, { ingredients: ['番茄'], top_k: 99 });
  assert.equal(bad3.ok, false);
  assert.ok(bad3.errors.some((e) => e.includes('不能大于 5')));
  // mark_consumed：items 元素必填字段
  const bad4 = validateArgs(TOOL_REGISTRY.mark_consumed.schema, { items: [{ name: '番茄', unit: '个' }] });
  assert.equal(bad4.ok, false);
  assert.ok(bad4.errors.some((e) => e.includes('缺少必填字段 "quantity"')));
});

test('TOOL-02 白名单：模型生成的任意工具名被 UNKNOWN_TOOL 拦截', async () => {
  await assert.rejects(
    executeTool('delete_food', {}),
    (err) => err instanceof ToolError && err.code === 'UNKNOWN_TOOL'
  );
});

test('TOOL-03 工具直测（正确参数）：query_inventory 返回库存且含寿命等级', async () => {
  const res = await executeTool('query_inventory', {});
  assert.equal(res.ok, true);
  assert.ok(res.data.count >= 5);
  const tomato = res.data.items.find((i) => i.name === '番茄');
  assert.ok(tomato && tomato.life_level && typeof tomato.days_left === 'number');
});

test('TOOL-04 工具直测（正确参数）：search_recipe 检索命中番茄炒蛋 KB-07', async () => {
  const res = await executeTool('search_recipe', { ingredients: ['番茄', '鸡蛋'], top_k: 3 });
  assert.equal(res.ok, true);
  assert.ok(res.data.results.some((r) => r.id === 'KB-07'));
});

test('TOOL-05 工具直测（错误参数）：search_recipe 参数越界返回工具错误', async () => {
  await assert.rejects(
    executeTool('search_recipe', { ingredients: ['番茄'], top_k: 99 }),
    (err) => err instanceof ToolError && err.code === 'INVALID_ARGS'
  );
});

test('TOOL-06 写工具无确认回调时拒绝执行（权限边界由程序兜底）', async () => {
  await assert.rejects(
    executeTool('mark_consumed', { items: [{ name: '番茄', quantity: 1, unit: '个' }] }, { confirm: null }),
    (err) => err instanceof ToolError && err.code === 'CONFIRM_REQUIRED'
  );
});

/* ------------------------------------------------------------------ */
/* 2.6 五类测试：正常完成（真实模型 + 真实工具 + 确认同意）                */
/* ------------------------------------------------------------------ */

test(
  'AGENT-01 正常完成：真实模型 qwen-plus 自主调用工具并给出方案（确认同意）',
  { timeout: 180000 },
  async (t) => {
    const prev = process.env.LLM_MODE;
    process.env.LLM_MODE = 'api';
    // 真实模型依赖本地网络：网络抖动不应把整个用例判红。失败一次后重试，仍不可用则 skip 并给出原因。
    const NETWORK_CODES = ['LLM_NETWORK_ERROR', 'LLM_TIMEOUT', 'LLM_SERVICE_UNAVAILABLE', 'LLM_NOT_CONFIGURED'];
    const llmErrorOf = (run) => run.steps.find((s) => s.kind === 'llm_error');
    try {
      let run = await runAgentTask('用冰箱里的临期食材做今晚的菜，并记录消耗', {
        confirm: async () => true,
      });
      if (run.status === 'llm_failed') {
        const err = llmErrorOf(run);
        if (NETWORK_CODES.includes(err?.error_code)) {
          t.diagnostic(`首次调用失败（${err.error_code}: ${err.message}），1.5s 后重试一次`);
          await new Promise((r) => setTimeout(r, 1500));
          run = await runAgentTask('用冰箱里的临期食材做今晚的菜，并记录消耗', {
            confirm: async () => true,
          });
        }
      }
      if (run.status === 'llm_failed') {
        const err = llmErrorOf(run);
        t.diagnostic(`真实模型不可用（${err?.error_code}: ${err?.message}），检查网络与 .env 后重跑；离线用例不受影响`);
        t.skip('网络或模型服务暂不可用，跳过真实调用用例');
        return;
      }
      assert.equal(run.status, 'completed', `应正常完成，实际 ${run.status}，问题：${JSON.stringify(run.success_issues)}`);
      assert.equal(run.success, true);
      assert.ok(run.total_steps >= 2, '应至少经历模型→工具→final 两步');
      assert.ok(run.steps.some((s) => s.kind === 'tool'), '应至少调用一个工具');
      assert.ok(run.final && run.final.title, '应给出方案标题');
      assert.ok(run.mode === 'api' || run.steps.some((s) => s.kind === 'tool' && s.ok), '正常流程应实际调用模型和工具');
    } finally {
      process.env.LLM_MODE = prev;
    }
  }
);

/* ------------------------------------------------------------------ */
/* 2.6 参数错误（模拟触发）：模型给出错误参数 → Schema 拦截 → 回喂修正      */
/* ------------------------------------------------------------------ */

test('AGENT-02 参数错误：模型输出字符串而非数组被拦截，修正后继续完成', async () => {
  const seq = [
    JSON.stringify({ tool: 'search_recipe', args: { ingredients: '番茄' } }), // 错误参数（字符串）
    JSON.stringify({ tool: 'search_recipe', args: { ingredients: ['番茄', '鸡蛋'], top_k: 3 } }), // 修正
    FINAL_PLAN,
  ];
  const run = await runAgentTask('用临期食材做菜', {
    llmOverride: mockLLMSequence(seq),
    confirm: async () => true,
  });
  const badStep = run.steps.find((s) => s.kind === 'tool' && s.error_code === 'INVALID_ARGS');
  assert.ok(badStep, '应记录一次参数校验失败');
  assert.equal(run.status, 'completed', `模型修正后应完成，实际 ${run.status}`);
  assert.equal(run.success, true);
});

/* ------------------------------------------------------------------ */
/* 2.6 工具异常（模拟触发）：工具执行失败 → 错误回喂 → 模型修正            */
/* ------------------------------------------------------------------ */

test('AGENT-03 工具异常：top_k 越界触发工具错误，模型修正后完成', async () => {
  const seq = [
    JSON.stringify({ tool: 'search_recipe', args: { ingredients: ['番茄'], top_k: 99 } }), // 越界
    JSON.stringify({ tool: 'search_recipe', args: { ingredients: ['番茄', '鸡蛋'], top_k: 3 } }), // 修正
    FINAL_PLAN,
  ];
  const run = await runAgentTask('用临期食材做菜', {
    llmOverride: mockLLMSequence(seq),
    confirm: async () => true,
  });
  const badStep = run.steps.find((s) => s.kind === 'tool' && s.error_code === 'INVALID_ARGS');
  assert.ok(badStep, '应记录一次工具错误');
  assert.equal(run.status, 'completed');
});

test('AGENT-04 工具异常：消耗不存在的食材返回 ITEM_NOT_FOUND 并回喂', async () => {
  const seq = [
    JSON.stringify({ tool: 'mark_consumed', args: { items: [{ name: '深海龙虾', quantity: 1, unit: '只' }] } }),
    FINAL_PLAN,
  ];
  const run = await runAgentTask('用临期食材做菜', {
    llmOverride: mockLLMSequence(seq),
    confirm: async () => true,
  });
  const badStep = run.steps.find((s) => s.kind === 'tool' && s.error_code === 'ITEM_NOT_FOUND');
  assert.ok(badStep, '应记录 ITEM_NOT_FOUND 错误并回喂模型');
});

/* ------------------------------------------------------------------ */
/* 2.6 达到步数限制（模拟触发）：模型死循环 → maxSteps 强制停止            */
/* ------------------------------------------------------------------ */

test('AGENT-05 步数限制：模型反复调用同一工具不结束，达到上限强制停止', async () => {
  const loop = JSON.stringify({ tool: 'query_inventory', args: {} });
  const run = await runAgentTask('用临期食材做菜', {
    llmOverride: mockLLMSequence([loop], { repeatLast: true }),
    confirm: async () => true,
  });
  assert.equal(run.status, 'max_steps_reached');
  assert.equal(run.success, false);
  assert.equal(run.total_steps, run.maxSteps, '应正好执行 maxSteps 步后停止');
});

/* ------------------------------------------------------------------ */
/* 2.6 人工确认：同意与拒绝                                             */
/* ------------------------------------------------------------------ */

test('AGENT-06 人工确认-同意：mark_consumed 执行，库存扣减且消耗一致', async () => {
  const before = listIngredients().find((i) => i.name === '番茄').quantity;
  const seq = [
    JSON.stringify({ tool: 'query_inventory', args: {} }),
    JSON.stringify({
      tool: 'mark_consumed',
      args: { items: [{ name: '番茄', quantity: 2, unit: '个' }] },
    }),
    FINAL_TOMATO,
  ];
  const run = await runAgentTask('用临期食材做菜并记录消耗', {
    llmOverride: mockLLMSequence(seq),
    confirm: async () => true,
  });
  const after = listIngredients().find((i) => i.name === '番茄').quantity;
  assert.equal(after, Number((before - 2).toFixed(3)), '确认同意后库存应扣减 2 个');
  assert.equal(run.status, 'completed');
  assert.equal(run.success, true, `消耗一致应通过复核：${JSON.stringify(run.success_issues)}`);
});

test('AGENT-07 人工确认-拒绝：mark_consumed 不执行，库存不变，结果回喂模型', async () => {
  const before = listIngredients().find((i) => i.name === '番茄').quantity;
  const seq = [
    JSON.stringify({
      tool: 'mark_consumed',
      args: { items: [{ name: '番茄', quantity: 2, unit: '个' }] },
    }),
    FINAL_PLAN,
  ];
  const run = await runAgentTask('用临期食材做菜并记录消耗', {
    llmOverride: mockLLMSequence(seq),
    confirm: async () => false, // 用户拒绝
  });
  const after = listIngredients().find((i) => i.name === '番茄').quantity;
  assert.equal(after, before, '用户拒绝后库存不应变化');
  const rejected = run.steps.find((s) => s.kind === 'tool' && s.error_code === 'USER_REJECTED');
  assert.ok(rejected, '应记录 USER_REJECTED 并回喂模型');
  assert.equal(run.note, 'user_rejected_consumption', '拒绝记录时 final 仍有效并标记说明');
});

/* ------------------------------------------------------------------ */
/* 2.6 边界补充：连续非法 JSON / 模型调用失败                             */
/* ------------------------------------------------------------------ */

test('AGENT-08 连续输出无法解析：达到重试上限后终止并返回明确状态', async () => {
  const run = await runAgentTask('用临期食材做菜', {
    llmOverride: async () => '这不是JSON，也没有工具调用',
    confirm: async () => true,
  });
  assert.equal(run.status, 'parse_failed');
  assert.equal(run.success, false);
  const parseErrors = run.steps.filter((s) => s.kind === 'parse_error');
  assert.ok(parseErrors.length > AGENT_LIMITS.maxParseRetries, '应超过解析重试上限');
});

test('AGENT-09 模型调用失败：LLM_TIMEOUT 时返回明确状态而不是崩溃', async () => {
  const run = await runAgentTask('用临期食材做菜', {
    llmOverride: async () => {
      throw new Error('LLM_TIMEOUT: 模型调用超时（模拟）');
    },
    confirm: async () => true,
  });
  assert.equal(run.status, 'llm_failed');
  assert.equal(run.success, false);
  assert.ok(run.steps.some((s) => s.kind === 'llm_error'));
});

/* ------------------------------------------------------------------ */
/* 2.3 输出解析                                                         */
/* ------------------------------------------------------------------ */

test('PARSE-01 模型输出解析：工具调用 / final / 非法输出三类正确区分', () => {
  assert.deepEqual(parseAgentOutput('{"tool":"query_inventory","args":{}}'), { kind: 'tool', tool: 'query_inventory', args: {} });
  assert.deepEqual(parseAgentOutput('```json\n{"tool":"search_recipe","args":{"ingredients":["番茄"]}}\n```').kind, 'tool');
  assert.equal(parseAgentOutput('好的，方案如下：{"final":{"title":"番茄炒蛋"}} 希望对你有帮助').kind, 'final');
  assert.equal(parseAgentOutput('不是JSON').kind, 'invalid');
  assert.equal(parseAgentOutput('{"foo":"bar"}').kind, 'invalid');
});
