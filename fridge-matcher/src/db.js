import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');

let db;

/** 惰性解析库文件路径：每次调用读取当前 FRIDGE_DB_PATH，支持测试进程在加载模块后设置独立测试库 */
function resolveDbPath() {
  return process.env.FRIDGE_DB_PATH || path.join(dataDir, 'fridge.db');
}

export function getDb() {
  if (db) return db;
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);
  return db;
}

export function getDbPath() {
  return resolveDbPath();
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      purchase_date TEXT,
      expiry_date TEXT,
      storage TEXT,
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'available',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      taste TEXT DEFAULT '清淡',
      servings INTEGER DEFAULT 1,
      max_minutes INTEGER DEFAULT 30,
      cookware_json TEXT DEFAULT '[]',
      allergens_json TEXT DEFAULT '[]',
      dislikes_json TEXT DEFAULT '[]',
      only_use_inventory INTEGER DEFAULT 0,
      max_purchases INTEGER DEFAULT 2,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      reason TEXT,
      cooking_minutes INTEGER,
      source TEXT NOT NULL,
      used_items_json TEXT NOT NULL,
      required_purchases_json TEXT NOT NULL,
      optional_purchases_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      confirmed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS consumption_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingredient_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      action TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
    );
  `);

  const pref = database.prepare('SELECT id FROM preferences WHERE id = 1').get();
  if (!pref) {
    database
      .prepare(
        `INSERT INTO preferences (id, taste, servings, max_minutes, cookware_json, allergens_json, dislikes_json, only_use_inventory, max_purchases)
         VALUES (1, '清淡', 1, 30, '["炒锅"]', '[]', '[]', 0, 2)`
      )
      .run();
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
