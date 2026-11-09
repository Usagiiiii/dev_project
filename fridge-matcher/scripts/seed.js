import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../src/db.js';
import { clearAllIngredients, createIngredient } from '../src/services/inventoryService.js';
import { updatePreferences } from '../src/services/preferenceService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.resolve(__dirname, '../data/sample-seed.json');

/** 本地日期字符串（YYYY-MM-DD），用于相对天数换算 */
function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 样例数据的日期支持相对写法，避免写死日期随时间推移全部过期：
 *   expiry_days_from_now: 距今天数（负数为已过期）
 *   purchase_days_ago:    购买于多少天前
 * 同时保留 expiry_date / purchase_date 绝对写法（两者都存在时以相对写法为准）。
 */
function resolveDates(item) {
  const { expiry_days_from_now, purchase_days_ago, ...rest } = item;
  if (expiry_days_from_now !== undefined && expiry_days_from_now !== null) {
    rest.expiry_date = localDate(Number(expiry_days_from_now));
  }
  if (purchase_days_ago !== undefined && purchase_days_ago !== null) {
    rest.purchase_date = localDate(-Number(purchase_days_ago));
  }
  return rest;
}

export function seedFromFile() {
  getDb();
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  clearAllIngredients();
  let count = 0;
  for (const item of seed.ingredients) {
    createIngredient({ ...resolveDates(item), allow_duplicate: true });
    count += 1;
  }
  if (seed.preferences) updatePreferences(seed.preferences);
  return count;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const count = seedFromFile();
  console.log(`seeded ${count} ingredients`);
  closeDb();
}
