import { getDb } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { listIngredients, consumeIngredients } from './inventoryService.js';
import { getPreferences } from './preferenceService.js';
import { log } from '../middleware/logger.js';

/** 预置规则模板：实验4非AI降级方案核心 */
const TEMPLATES = [
  {
    id: 'veggie-egg-soup',
    title: '青菜蛋花汤',
    taste: ['清淡', '家常'],
    minutes: 15,
    need: [
      { key: '青菜', aliases: ['青菜', '生菜', '小白菜'], qty: 1, unit: '把', critical: true },
      { key: '鸡蛋', aliases: ['鸡蛋', '蛋'], qty: 1, unit: '枚', critical: true },
    ],
    optional: [{ name: '盐', qty: 1, unit: '适量' }],
    steps: ['青菜洗净切段', '锅中加水烧开，下青菜', '打入蛋花，调味出锅'],
  },
  {
    id: 'tomato-egg',
    title: '番茄炒蛋',
    taste: ['清淡', '家常', '酸甜'],
    minutes: 15,
    need: [
      { key: '番茄', aliases: ['番茄', '西红柿'], qty: 2, unit: '个', critical: true },
      { key: '鸡蛋', aliases: ['鸡蛋', '蛋'], qty: 2, unit: '枚', critical: true },
    ],
    optional: [{ name: '葱', qty: 1, unit: '根' }],
    steps: ['番茄切块，鸡蛋打散', '先炒蛋盛出', '炒番茄出汁后合炒调味'],
  },
  {
    id: 'tofu-stir',
    title: '家常豆腐',
    taste: ['清淡', '家常'],
    minutes: 20,
    need: [
      { key: '豆腐', aliases: ['豆腐'], qty: 1, unit: '盒', critical: true },
      { key: '生姜', aliases: ['生姜', '姜'], qty: 0.2, unit: '块', critical: false },
    ],
    optional: [{ name: '蒜', qty: 2, unit: '瓣' }],
    steps: ['豆腐切块焯水', '热锅少油，下姜片', '下豆腐轻煎后调味'],
  },
];

function findStock(inventory, aliases) {
  return inventory.find(
    (i) =>
      i.status === 'available' &&
      aliases.some((a) => i.name.includes(a) || a.includes(i.name))
  );
}

function containsAllergen(text, allergens) {
  return allergens.some((a) => text.includes(a));
}

function matchTemplate(template, inventory, preferences) {
  const used = [];
  const requiredPurchases = [];
  const issues = [];

  for (const need of template.need) {
    const stock = findStock(inventory, need.aliases);
    if (stock) {
      if (containsAllergen(stock.name, preferences.allergens || [])) {
        issues.push({
          code: 'ALLERGEN_CONFLICT',
          message: `方案「${template.title}」涉及过敏食材：${stock.name}`,
        });
        return null;
      }
      const useQty = Math.min(stock.quantity, need.qty * preferences.servings);
      used.push({
        ingredient_id: stock.id,
        name: stock.name,
        quantity: useQty,
        unit: stock.unit,
        life_level: stock.life_level,
      });
    } else if (need.critical) {
      requiredPurchases.push({ name: need.key, quantity: need.qty * preferences.servings, unit: need.unit });
    }
  }

  if (used.length === 0) return null;

  if (preferences.only_use_inventory && requiredPurchases.length > 0) {
    return null;
  }
  if (requiredPurchases.length > (preferences.max_purchases ?? 2)) {
    return null;
  }

  // 优先消耗临期：若库存中有 critical/warn 却未被使用，降权（不返回）
  const priorityLeft = inventory.filter(
    (i) =>
      i.status === 'available' &&
      (i.life_level === 'critical' || i.life_level === 'warn') &&
      !used.some((u) => u.ingredient_id === i.id)
  );
  const usesPriority = used.some(
    (u) => u.life_level === 'critical' || u.life_level === 'warn'
  );

  const optional = (template.optional || []).filter(
    (o) => !containsAllergen(o.name, preferences.allergens || [])
  );

  return {
    templateId: template.id,
    title: template.title,
    reason: usesPriority
      ? '优先消耗临期/需尽快处理的库存食材'
      : priorityLeft.length
        ? '可执行基础方案（仍有临期食材未纳入，可改偏好后重试）'
        : '匹配现有库存与烹饪时间的规则模板方案',
    cooking_minutes: template.minutes,
    used_items: used,
    required_purchases: requiredPurchases,
    optional_purchases: optional,
    steps: template.steps,
    priority_score: usesPriority ? 0 : 1 + requiredPurchases.length,
    issues,
  };
}

export function generatePlans(options = {}) {
  const preferences = { ...getPreferences(), ...options.preferences };
  if (options.only_use_inventory !== undefined) {
    preferences.only_use_inventory = options.only_use_inventory;
  }
  if (options.max_purchases !== undefined) {
    preferences.max_purchases = options.max_purchases;
  }

  const all = listIngredients();
  const issues = [];

  const vague = all.filter(
    (i) => i.status === 'available' && (!i.name || i.name.length < 2)
  );
  if (vague.length) {
    issues.push({
      code: 'MISSING_REQUIRED_FIELD',
      message: '存在信息不完整的食材，请补充具体名称与数量',
    });
  }

  const usable = all.filter((i) => i.status === 'available');
  const blocked = all.filter((i) => i.status === 'needs_confirm' || i.life_level === 'expired');
  for (const b of blocked) {
    issues.push({
      code: 'NEEDS_MANUAL_CONFIRM',
      message: `「${b.name}」标记为需要人工确认/已过期，不计入可食用库存推荐`,
      ingredient_id: b.id,
    });
  }

  if (usable.length === 0) {
    issues.push({
      code: 'MISSING_REQUIRED_FIELD',
      message: '请至少录入一种具体食材及大致数量后再生成方案',
    });
    return { source: 'validation', plans: [], issues };
  }

  const candidates = TEMPLATES.filter((t) => {
    if (t.minutes > preferences.max_minutes) return false;
    if (preferences.taste && !t.taste.includes(preferences.taste) && preferences.taste !== '家常') {
      // 口味不完全匹配时仍允许家常模板
      return t.taste.includes('家常') || t.taste.includes(preferences.taste);
    }
    return true;
  })
    .map((t) => matchTemplate(t, usable, preferences))
    .filter(Boolean)
    .sort((a, b) => a.priority_score - b.priority_score);

  // 过敏硬拦截：二次扫描
  const safePlans = [];
  for (const p of candidates) {
    const text = JSON.stringify(p);
    const hit = (preferences.allergens || []).find((a) => text.includes(a));
    if (hit) {
      issues.push({
        code: 'ALLERGEN_CONFLICT',
        message: `方案「${p.title}」与过敏设置「${hit}」冲突，已拦截`,
      });
      continue;
    }
    safePlans.push(p);
  }

  if (safePlans.length === 0) {
    issues.push({
      code: 'NO_MATCHING_PLAN',
      message: '当前库存与偏好下无可用规则方案，请补充食材或放宽补购限制',
    });
    return { source: 'rule_fallback', plans: [], issues };
  }

  const db = getDb();
  const saved = [];
  const insert = db.prepare(
    `INSERT INTO plans
     (title, reason, cooking_minutes, source, used_items_json, required_purchases_json, optional_purchases_json, steps_json)
     VALUES (?, ?, ?, 'rule_fallback', ?, ?, ?, ?)`
  );
  for (const p of safePlans.slice(0, 3)) {
    const info = insert.run(
      p.title,
      p.reason,
      p.cooking_minutes,
      JSON.stringify(p.used_items),
      JSON.stringify(p.required_purchases),
      JSON.stringify(p.optional_purchases),
      JSON.stringify(p.steps)
    );
    saved.push({
      id: Number(info.lastInsertRowid),
      source: 'rule_fallback',
      title: p.title,
      reason: p.reason,
      cooking_minutes: p.cooking_minutes,
      used_items: p.used_items,
      required_purchases: p.required_purchases,
      optional_purchases: p.optional_purchases,
      steps: p.steps,
      confirmed: false,
    });
  }

  log('info', 'plans_generated', { count: saved.length, source: 'rule_fallback' });
  return { source: 'rule_fallback', plans: saved, issues };
}

export function getPlan(id) {
  const row = getDb().prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!row) throw new AppError(404, 'NOT_FOUND', `方案 #${id} 不存在`);
  return {
    id: row.id,
    title: row.title,
    reason: row.reason,
    cooking_minutes: row.cooking_minutes,
    source: row.source,
    used_items: JSON.parse(row.used_items_json),
    required_purchases: JSON.parse(row.required_purchases_json),
    optional_purchases: JSON.parse(row.optional_purchases_json),
    steps: JSON.parse(row.steps_json),
    confirmed: !!row.confirmed,
    created_at: row.created_at,
  };
}

export function confirmPlan(id, { consume = true } = {}) {
  const plan = getPlan(id);
  if (plan.confirmed) {
    throw new AppError(409, 'ALREADY_CONFIRMED', '方案已确认，请勿重复扣减');
  }

  const prefs = getPreferences();
  const text = JSON.stringify(plan);
  const hit = (prefs.allergens || []).find((a) => text.includes(a));
  if (hit) {
    throw new AppError(409, 'ALLERGEN_CONFLICT', `与过敏「${hit}」冲突，禁止确认`);
  }

  // 库存变化再校验
  const current = listIngredients();
  for (const u of plan.used_items) {
    const stock = current.find((i) => i.id === u.ingredient_id);
    if (!stock || stock.status !== 'available') {
      throw new AppError(409, 'STOCK_CHANGED', `食材「${u.name}」状态已变化，请重新生成`);
    }
    if (stock.quantity < u.quantity) {
      throw new AppError(409, 'STOCK_CHANGED', `食材「${u.name}」数量不足，请重新生成`);
    }
  }

  if (consume) {
    consumeIngredients(
      plan.used_items.map((u) => ({
        ingredient_id: u.ingredient_id,
        quantity: u.quantity,
        note: `确认方案#${id}`,
      })),
      'consume'
    );
  }

  getDb().prepare('UPDATE plans SET confirmed = 1 WHERE id = ?').run(id);
  log('info', 'plan_confirmed', { id, consume });
  return {
    plan: getPlan(id),
    shopping_list: {
      required: plan.required_purchases,
      optional: plan.optional_purchases,
    },
    inventory: listIngredients({ status: 'available' }),
  };
}
