import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const testDb = path.join(root, 'data', 'test-fridge.db');
const PORT = 3789;
const BASE = `http://127.0.0.1:${PORT}`;

let child;

async function waitHealth(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}

before(async () => {
  if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), FRIDGE_DB_PATH: testDb },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitHealth();
});

after(async () => {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
  }
  try {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  } catch {
    // Windows 可能短暂占用，忽略清理失败
  }
});

async function json(pathname, options) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json();
  return { res, body };
}

test('TC01 新增食材并按寿命排序', async () => {
  await json('/api/dev/clear', { method: 'POST' });
  await json('/api/ingredients', {
    method: 'POST',
    body: JSON.stringify({
      name: '青菜',
      quantity: 1,
      unit: '把',
      expiry_date: '2026-10-13',
      allow_duplicate: true,
    }),
  });
  await json('/api/ingredients', {
    method: 'POST',
    body: JSON.stringify({
      name: '鸡蛋',
      quantity: 2,
      unit: '枚',
      expiry_date: '2026-10-25',
      allow_duplicate: true,
    }),
  });
  const { body } = await json('/api/ingredients');
  assert.equal(body.ok, true);
  assert.ok(body.data.length >= 2);
  assert.equal(body.data[0].name, '青菜');
});

test('TC02 模糊名称被拒绝', async () => {
  const { res, body } = await json('/api/ingredients', {
    method: 'POST',
    body: JSON.stringify({ name: '有蔬菜', quantity: 1, unit: '份' }),
  });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('TC03 异味备注进入人工确认', async () => {
  const { body } = await json('/api/ingredients', {
    method: 'POST',
    body: JSON.stringify({
      name: '生菜',
      quantity: 1,
      unit: '把',
      expiry_date: '2026-10-08',
      notes: '有异味、表面发黏',
      allow_duplicate: true,
    }),
  });
  assert.equal(body.data.status, 'needs_confirm');
  assert.equal(body.data.life_level, 'needs_confirm');
});

test('TC04 空库存生成方案提示信息不足', async () => {
  await json('/api/dev/clear', { method: 'POST' });
  const { body } = await json('/api/plans/generate', {
    method: 'POST',
    body: JSON.stringify({ preferences: { taste: '清淡', servings: 1, max_minutes: 20 } }),
  });
  assert.equal(body.source, 'validation');
  assert.equal(body.plans.length, 0);
  assert.ok(body.issues.some((i) => i.code === 'MISSING_REQUIRED_FIELD'));
});

test('TC05 样例数据可生成规则方案且优先青菜', async () => {
  await json('/api/dev/seed', { method: 'POST' });
  const { body } = await json('/api/plans/generate', {
    method: 'POST',
    body: JSON.stringify({
      preferences: { taste: '清淡', servings: 1, max_minutes: 20, allergens: ['花生'] },
      only_use_inventory: false,
      max_purchases: 2,
    }),
  });
  assert.equal(body.source, 'rule_fallback');
  assert.ok(body.plans.length >= 1);
  const first = body.plans[0];
  assert.ok(first.used_items.some((u) => u.name.includes('青菜') || first.title.includes('青菜')));
  assert.ok(!JSON.stringify(first).includes('花生酱'));
});

test('TC06 确认方案后库存扣减', async () => {
  await json('/api/dev/seed', { method: 'POST' });
  const gen = await json('/api/plans/generate', {
    method: 'POST',
    body: JSON.stringify({
      preferences: { taste: '清淡', servings: 1, max_minutes: 20, allergens: ['花生'] },
    }),
  });
  const plan = gen.body.plans[0];
  const before = await json('/api/ingredients');
  const eggBefore = before.body.data.find((i) => i.name === '鸡蛋');
  const confirm = await json(`/api/plans/${plan.id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ consume: true }),
  });
  assert.equal(
    confirm.body.ok,
    true,
    confirm.body.error?.message || 'confirm failed'
  );
  const after = await json('/api/ingredients');
  const eggAfter = after.body.data.find((i) => i.id === eggBefore.id);
  const usedEgg = plan.used_items.find((u) => u.name === '鸡蛋');
  if (usedEgg) {
    assert.ok(eggAfter.quantity < eggBefore.quantity);
  }
});

test('TC07 非法数量被拒绝', async () => {
  const { res, body } = await json('/api/ingredients', {
    method: 'POST',
    body: JSON.stringify({ name: '土豆', quantity: -1, unit: '个' }),
  });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('TC08 偏好人数超范围', async () => {
  const { res, body } = await json('/api/preferences', {
    method: 'PUT',
    body: JSON.stringify({ servings: 99 }),
  });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});
