import { getDb } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { log } from '../middleware/logger.js';

function parseJson(text, fallback) {
  try {
    return JSON.parse(text || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function mapPref(row) {
  return {
    taste: row.taste,
    servings: row.servings,
    max_minutes: row.max_minutes,
    cookware: parseJson(row.cookware_json, []),
    allergens: parseJson(row.allergens_json, []),
    dislikes: parseJson(row.dislikes_json, []),
    only_use_inventory: !!row.only_use_inventory,
    max_purchases: row.max_purchases,
    updated_at: row.updated_at,
  };
}

export function getPreferences() {
  const row = getDb().prepare('SELECT * FROM preferences WHERE id = 1').get();
  return mapPref(row);
}

export function updatePreferences(body) {
  const current = getPreferences();
  const servings = body.servings !== undefined ? Number(body.servings) : current.servings;
  const max_minutes =
    body.max_minutes !== undefined ? Number(body.max_minutes) : current.max_minutes;
  const max_purchases =
    body.max_purchases !== undefined ? Number(body.max_purchases) : current.max_purchases;

  if (!Number.isInteger(servings) || servings < 1 || servings > 12) {
    throw new AppError(400, 'VALIDATION_ERROR', '用餐人数须为 1–12 的整数');
  }
  if (!Number.isInteger(max_minutes) || max_minutes < 5 || max_minutes > 180) {
    throw new AppError(400, 'VALIDATION_ERROR', '烹饪时间须为 5–180 分钟');
  }
  if (!Number.isInteger(max_purchases) || max_purchases < 0 || max_purchases > 10) {
    throw new AppError(400, 'VALIDATION_ERROR', '最大补购数须为 0–10 的整数');
  }

  const taste = body.taste !== undefined ? String(body.taste) : current.taste;
  const cookware = body.cookware !== undefined ? body.cookware : current.cookware;
  const allergens = body.allergens !== undefined ? body.allergens : current.allergens;
  const dislikes = body.dislikes !== undefined ? body.dislikes : current.dislikes;
  const only_use_inventory =
    body.only_use_inventory !== undefined
      ? !!body.only_use_inventory
      : current.only_use_inventory;

  getDb()
    .prepare(
      `UPDATE preferences SET
       taste=?, servings=?, max_minutes=?, cookware_json=?, allergens_json=?,
       dislikes_json=?, only_use_inventory=?, max_purchases=?, updated_at=datetime('now')
       WHERE id=1`
    )
    .run(
      taste,
      servings,
      max_minutes,
      JSON.stringify(cookware || []),
      JSON.stringify(allergens || []),
      JSON.stringify(dislikes || []),
      only_use_inventory ? 1 : 0,
      max_purchases
    );
  log('info', 'preferences_updated', { taste, servings, max_minutes });
  return getPreferences();
}
