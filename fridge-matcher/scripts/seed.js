import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../src/db.js';
import { clearAllIngredients, createIngredient } from '../src/services/inventoryService.js';
import { updatePreferences } from '../src/services/preferenceService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.resolve(__dirname, '../data/sample-seed.json');

export function seedFromFile() {
  getDb();
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  clearAllIngredients();
  let count = 0;
  for (const item of seed.ingredients) {
    createIngredient({ ...item, allow_duplicate: true });
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
