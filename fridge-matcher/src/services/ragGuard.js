import { loadKnowledgeBase } from './knowledgeBase.js';

/**
 * RAG 输出校验模块（实验5 2.4 安全约束层）
 *
 * 复用实验4 的规则层思路，对 LLM 输出做强制校验：
 * - 库存白名单：used_items 的食材名必须真实存在于库存（禁止虚构库存）；
 * - 过敏硬拦截：任何涉及过敏食材的条目直接拦截；
 * - 引用校验：references 必须是知识库中真实存在的片段编号；
 * - 格式校验：必须输出可解析 JSON 且包含必要字段。
 */

/** 解析 LLM 输出为 JSON；失败返回 null */
export function parseLLMOutput(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 容错 1：模型可能输出 ```json ... ``` 包裹
  let cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  // 容错 2：真实模型常把 JSON 包裹在自然语言里（如 "答案是：{...}"），
  // 提取第一个 '{' 到最后一个 '}' 之间的子串再尝试解析
  if (!cleaned.startsWith('{')) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    }
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * 对解析后的模型输出执行校验。
 * @param {object|null} parsed
 * @param {object} ctx { inventory, preferences, kbIds }
 * @returns {{ok: boolean, issues: Array<{code:string, message:string}>, answer: object|null}}
 */
export function guardAnswer(parsed, ctx = {}) {
  const issues = [];
  const inventory = (ctx.inventory || []).filter((i) => i.status === 'available');
  const allergens = ctx.preferences?.allergens || [];
  const kbIds = new Set(ctx.kbIds || []);

  if (parsed === null) {
    return { ok: false, issues: [{ code: 'INVALID_JSON', message: '模型输出不是合法 JSON，无法校验' }], answer: null };
  }

  // 模型自身声明信息不足：接受并透传
  if (parsed.error) {
    return { ok: true, issues: [{ code: 'MODEL_UNCERTAIN', message: parsed.message || parsed.error }], answer: parsed };
  }

  // 格式校验：必要字段
  if (!parsed.title || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    issues.push({ code: 'INVALID_FORMAT', message: '缺少 title 或 steps 字段' });
  }
  const usedItems = Array.isArray(parsed.used_items) ? parsed.used_items : [];
  if (usedItems.length === 0) {
    issues.push({ code: 'INVALID_FORMAT', message: 'used_items 为空，方案未消耗任何库存食材' });
  }

  // 库存白名单：used_items 必须存在于库存
  for (const item of usedItems) {
    const name = String(item?.name || '');
    const inStock = inventory.some((i) => i.name === name);
    if (!inStock) {
      issues.push({
        code: 'FABRICATED_INVENTORY',
        message: `模型虚构了库存食材「${name}」，已拦截`,
      });
    }
  }

  // 过敏硬拦截：方案涉及的食材（含补购项）不得命中过敏清单
  const allNames = [
    ...usedItems,
    ...(Array.isArray(parsed.required_purchases) ? parsed.required_purchases : []),
    ...(Array.isArray(parsed.optional_purchases) ? parsed.optional_purchases : []),
  ].map((x) => String(x?.name || ''));
  for (const a of allergens) {
    const hit = allNames.find((n) => n.includes(a) || a.includes(n));
    if (hit) {
      issues.push({ code: 'ALLERGEN_CONFLICT', message: `方案涉及过敏食材「${hit}」（过敏项：${a}），已拦截` });
    }
  }

  // 引用校验：references 必须是知识库真实编号
  const refs = Array.isArray(parsed.references) ? parsed.references : [];
  for (const r of refs) {
    if (!kbIds.has(r)) {
      issues.push({ code: 'INVALID_REFERENCE', message: `引用了不存在的资料编号「${r}」` });
    }
  }

  const hasBlocking = issues.some(
    (i) => i.code === 'FABRICATED_INVENTORY' || i.code === 'ALLERGEN_CONFLICT' || i.code === 'INVALID_FORMAT'
  );
  return { ok: !hasBlocking, issues, answer: hasBlocking ? null : parsed };
}

/** 获取知识库全部编号（供引用校验） */
export function getKbIds() {
  const { chunks } = loadKnowledgeBase();
  return chunks.map((c) => c.id);
}
