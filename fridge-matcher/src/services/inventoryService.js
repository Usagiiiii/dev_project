import { getDb } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { enrichIngredient, sortByLife } from './lifeService.js';
import { log } from '../middleware/logger.js';

const SUSPICIOUS_KEYWORDS = ['异味', '发黏', '发霉', '腐烂', '变质', '变色'];

function rowToIngredient(row) {
  if (!row) return null;
  return enrichIngredient(row);
}

export function listIngredients({ status } = {}) {
  const db = getDb();
  let rows;
  if (status) {
    rows = db
      .prepare('SELECT * FROM ingredients WHERE status = ? ORDER BY id')
      .all(status);
  } else {
    rows = db.prepare('SELECT * FROM ingredients ORDER BY id').all();
  }
  return sortByLife(rows);
}

export function getIngredient(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
  if (!row) throw new AppError(404, 'NOT_FOUND', `食材 #${id} 不存在`);
  return rowToIngredient(row);
}

function validatePayload(body, { partial = false } = {}) {
  const errors = [];
  if (!partial || body.name !== undefined) {
    if (!body.name || !String(body.name).trim()) {
      errors.push('名称不能为空');
    } else if (String(body.name).trim() === '有一些蔬菜' || String(body.name).trim() === '有蔬菜') {
      errors.push('请填写具体食材品种，不能使用模糊描述');
    }
  }
  if (!partial || body.quantity !== undefined) {
    const q = Number(body.quantity);
    if (!Number.isFinite(q) || q <= 0) errors.push('数量必须为正数');
  }
  if (!partial || body.unit !== undefined) {
    if (!body.unit || !String(body.unit).trim()) errors.push('单位不能为空');
  }
  if (body.expiry_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.expiry_date)) {
      errors.push('预计到期日格式应为 YYYY-MM-DD');
    }
  }
  if (errors.length) {
    throw new AppError(400, 'VALIDATION_ERROR', errors.join('；'));
  }
}

function detectNeedsConfirm(notes, expiryDate) {
  const text = String(notes || '');
  if (SUSPICIOUS_KEYWORDS.some((k) => text.includes(k))) return true;
  if (expiryDate) {
    const days = Math.ceil(
      (new Date(`${expiryDate}T23:59:59`) - new Date()) / (24 * 60 * 60 * 1000)
    );
    if (days < 0 && text.trim()) return true;
  }
  return false;
}

export function createIngredient(body) {
  validatePayload(body);
  const name = String(body.name).trim();
  const quantity = Number(body.quantity);
  const unit = String(body.unit).trim();
  const notes = String(body.notes || '');
  let status = body.status || 'available';
  if (detectNeedsConfirm(notes, body.expiry_date)) {
    status = 'needs_confirm';
  }

  const db = getDb();
  const dup = db
    .prepare(
      `SELECT id FROM ingredients
       WHERE name = ? AND status IN ('available','needs_confirm') AND unit = ?`
    )
    .get(name, unit);
  if (dup && body.allow_duplicate !== true) {
    throw new AppError(
      409,
      'DUPLICATE',
      `已存在同名同单位食材 #${dup.id}，请编辑数量或传 allow_duplicate=true`
    );
  }

  const info = db
    .prepare(
      `INSERT INTO ingredients
       (name, quantity, unit, purchase_date, expiry_date, storage, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      quantity,
      unit,
      body.purchase_date || null,
      body.expiry_date || null,
      body.storage || null,
      notes,
      status
    );
  log('info', 'ingredient_created', { id: info.lastInsertRowid, name, status });
  return getIngredient(Number(info.lastInsertRowid));
}

export function updateIngredient(id, body) {
  const current = getIngredient(id);
  validatePayload(body, { partial: true });
  const name = body.name !== undefined ? String(body.name).trim() : current.name;
  const quantity =
    body.quantity !== undefined ? Number(body.quantity) : current.quantity;
  const unit = body.unit !== undefined ? String(body.unit).trim() : current.unit;
  const notes = body.notes !== undefined ? String(body.notes) : current.notes;
  const expiry_date =
    body.expiry_date !== undefined ? body.expiry_date : current.expiry_date;
  let status = body.status !== undefined ? body.status : current.status;
  if (detectNeedsConfirm(notes, expiry_date) && status === 'available') {
    status = 'needs_confirm';
  }

  getDb()
    .prepare(
      `UPDATE ingredients SET
       name=?, quantity=?, unit=?, purchase_date=?, expiry_date=?,
       storage=?, notes=?, status=?, updated_at=datetime('now')
       WHERE id=?`
    )
    .run(
      name,
      quantity,
      unit,
      body.purchase_date !== undefined ? body.purchase_date : current.purchase_date,
      expiry_date,
      body.storage !== undefined ? body.storage : current.storage,
      notes,
      status,
      id
    );
  log('info', 'ingredient_updated', { id, status });
  return getIngredient(id);
}

export function deleteIngredient(id) {
  getIngredient(id);
  getDb().prepare('DELETE FROM ingredients WHERE id = ?').run(id);
  log('info', 'ingredient_deleted', { id });
  return { ok: true };
}

export function confirmIngredient(id) {
  const item = getIngredient(id);
  if (item.status !== 'needs_confirm') {
    throw new AppError(400, 'INVALID_STATUS', '仅“需要人工确认”状态可确认');
  }
  return updateIngredient(id, { status: 'available', notes: item.notes + '（已人工确认）' });
}

export function consumeIngredients(items, action = 'consume') {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', '消耗列表不能为空');
  }
  const db = getDb();
  const results = [];
  db.exec('BEGIN');
  try {
    for (const it of items) {
      const row = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(it.ingredient_id);
      if (!row) throw new AppError(404, 'NOT_FOUND', `食材 #${it.ingredient_id} 不存在`);
      const qty = Number(it.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new AppError(400, 'VALIDATION_ERROR', '消耗数量必须为正数');
      }
      if (qty > row.quantity) {
        throw new AppError(
          409,
          'INSUFFICIENT_STOCK',
          `${row.name} 库存不足（现有 ${row.quantity}${row.unit}）`
        );
      }
      const remain = Number((row.quantity - qty).toFixed(3));
      const nextStatus =
        action === 'discard'
          ? 'discarded'
          : remain <= 0
            ? 'consumed'
            : row.status;
      db.prepare(
        `UPDATE ingredients SET quantity=?, status=?, updated_at=datetime('now') WHERE id=?`
      ).run(Math.max(remain, 0), nextStatus, row.id);
      db.prepare(
        `INSERT INTO consumption_records (ingredient_id, quantity, action, note)
         VALUES (?, ?, ?, ?)`
      ).run(row.id, qty, action, it.note || null);
      results.push(getIngredient(row.id));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  log('info', 'ingredients_consumed', { count: items.length, action });
  return results;
}

export function clearAllIngredients() {
  const db = getDb();
  db.exec('DELETE FROM consumption_records; DELETE FROM plans; DELETE FROM ingredients;');
  log('info', 'ingredients_cleared', {});
}
