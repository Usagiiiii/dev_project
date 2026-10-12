/** 按剩余寿命计算等级：expired / critical / warn / ok / unknown */

export function daysUntilExpiry(expiryDate, today = new Date()) {
  if (!expiryDate) return null;
  const end = new Date(`${expiryDate}T23:59:59`);
  if (Number.isNaN(end.getTime())) return null;
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  return Math.ceil((end - start) / (24 * 60 * 60 * 1000));
}

export function lifeLevel(ingredient, today = new Date()) {
  if (ingredient.status === 'needs_confirm') return 'needs_confirm';
  if (ingredient.status === 'discarded' || ingredient.status === 'consumed') {
    return ingredient.status;
  }
  const days = daysUntilExpiry(ingredient.expiry_date, today);
  if (days === null) return 'unknown';
  if (days < 0) return 'expired';
  // 剩余 0–2 天（含明天到期）视为今天优先处理
  if (days <= 2) return 'critical';
  if (days <= 4) return 'warn';
  return 'ok';
}

export function enrichIngredient(row, today = new Date()) {
  const days = daysUntilExpiry(row.expiry_date, today);
  return {
    ...row,
    days_left: days,
    life_level: lifeLevel(row, today),
  };
}

export function sortByLife(ingredients, today = new Date()) {
  const rank = {
    needs_confirm: 0,
    expired: 1,
    critical: 2,
    warn: 3,
    unknown: 4,
    ok: 5,
    consumed: 9,
    discarded: 9,
  };
  return [...ingredients]
    .map((i) => enrichIngredient(i, today))
    .sort((a, b) => {
      const ra = rank[a.life_level] ?? 8;
      const rb = rank[b.life_level] ?? 8;
      if (ra !== rb) return ra - rb;
      const da = a.days_left ?? 9999;
      const db = b.days_left ?? 9999;
      return da - db;
    });
}
