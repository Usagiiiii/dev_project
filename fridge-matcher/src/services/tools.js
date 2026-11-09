/**
 * 工具层（实验6 2.2）
 *
 * 职责：
 * - 定义 Agent 可调用的工具注册表（名称、用途、Schema、权限、副作用）；
 * - 提供参数校验（类型 / 必填 / 数值范围 / 数组元素）与执行入口；
 * - 权限分级：read（只读，自动执行）/ write（有副作用，须人工确认）；
 * - 明确禁止的操作（执行 shell、删除数据、访问外部网络）不注册进工具表，
 *   模型生成的任意函数名不可能被执行（UNKNOWN_TOOL 拦截）。
 *
 * 设计原则：
 * - 零第三方依赖，Schema 校验为手写轻量实现，可解释、可测试；
 * - 工具执行失败不崩溃，统一转为 ToolError（含 code + message）回喂给模型，
 *   由 Agent 决定修正或终止；
 * - 复用实验5/实验4的服务模块（inventoryService / retrieval / knowledgeBase）。
 */
import { listIngredients } from './inventoryService.js';
import { consumeIngredients } from './inventoryService.js';
import { search } from './retrieval.js';

/** 工具执行错误：code 供 Agent 决策与日志分类，message 回喂给模型 */
export class ToolError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code; // UNKNOWN_TOOL | INVALID_ARGS | TOOL_EXEC_FAILED | USER_REJECTED | ITEM_NOT_FOUND | INSUFFICIENT_STOCK ...
    this.meta = meta;
  }
}

/* ------------------------------------------------------------------ */
/* 轻量 Schema 校验器（零依赖）                                         */
/* ------------------------------------------------------------------ */

/**
 * 校验单个参数值是否符合 schema 字段约束。
 * 支持：type(string/number/boolean/array/object)、required、enum、
 *       min/max（number）、minLength/maxLength（string）、items（array 元素 type）。
 * 返回错误数组（空数组表示通过）。
 */
function validateField(name, value, fieldSchema) {
  const errors = [];
  const { type, enum: enumValues, min, max, minLength, maxLength, items } = fieldSchema;

  if (value === undefined || value === null) {
    return errors; // 必填性由 validateArgs 统一处理
  }

  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (type && actualType !== type) {
    errors.push(`参数 "${name}" 类型应为 ${type}，实际为 ${actualType}`);
    return errors;
  }
  if (type === 'number' && typeof value === 'number') {
    if (min !== undefined && value < min) errors.push(`参数 "${name}" 不能小于 ${min}`);
    if (max !== undefined && value > max) errors.push(`参数 "${name}" 不能大于 ${max}`);
  }
  if (type === 'string' && typeof value === 'string') {
    if (minLength !== undefined && value.length < minLength) errors.push(`参数 "${name}" 长度不能少于 ${minLength}`);
    if (maxLength !== undefined && value.length > maxLength) errors.push(`参数 "${name}" 长度不能超过 ${maxLength}`);
  }
  if (enumValues && !enumValues.includes(value)) {
    errors.push(`参数 "${name}" 取值必须为 ${enumValues.join(' / ')}，实际为 ${JSON.stringify(value)}`);
  }
  if (type === 'array' && Array.isArray(value)) {
    if (minLength !== undefined && value.length < minLength) errors.push(`参数 "${name}" 至少需要 ${minLength} 个元素`);
    if (maxLength !== undefined && value.length > maxLength) errors.push(`参数 "${name}" 最多允许 ${maxLength} 个元素`);
    if (items) {
      value.forEach((el, i) => {
        const elType = Array.isArray(el) ? 'array' : typeof el;
        if (elType !== items.type) {
          errors.push(`参数 "${name}" 第 ${i + 1} 个元素类型应为 ${items.type}，实际为 ${elType}`);
        }
        if (items.type === 'object' && items.properties && el && typeof el === 'object' && !Array.isArray(el)) {
          for (const [subName, subSchema] of Object.entries(items.properties)) {
            if (subSchema.required && (el[subName] === undefined || el[subName] === null)) {
              errors.push(`参数 "${name}" 的元素缺少必填字段 "${subName}"`);
            }
          }
        }
      });
    }
  }
  return errors;
}

/**
 * 校验 args 是否符合工具 Schema。
 * @param {object} schema 工具注册表中的 schema 定义
 * @param {object} args 模型给出的参数
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateArgs(schema, args) {
  const errors = [];
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, errors: ['参数必须是 JSON 对象'] };
  }
  const { required = [], properties = {} } = schema;
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      errors.push(`缺少必填参数 "${key}"`);
    }
  }
  for (const [key, fieldSchema] of Object.entries(properties)) {
    errors.push(...validateField(key, args[key], fieldSchema));
  }
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                             */
/* ------------------------------------------------------------------ */

/** 归一化库存条目：只暴露模型决策需要的最小字段，避免泄露内部数据 */
function toInventoryView(item) {
  return {
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    days_left: item.days_left ?? null,
    life_level: item.life_level ?? 'unknown',
    status: item.status,
  };
}

/**
 * 工具 1：查询库存（只读，自动执行）
 * 返回全部库存（含寿命等级），由模型自行判断可用与临期食材。
 * 设计说明：不提供过滤参数——筛选决策交给模型（工具保持最简单契约），
 * 避免模型误传 life_level 值（如 warn）与库存状态（如 available）混淆。
 */
async function runQueryInventory() {
  const rows = listIngredients();
  const items = rows.map(toInventoryView);
  return { ok: true, data: { count: items.length, items } };
}

/**
 * 工具 2：检索知识库菜谱（只读，自动执行）
 * 复用实验5的 2-gram+BM25 检索，把食材名列表拼成查询串。
 */
async function runSearchRecipe(args) {
  const query = (args.ingredients || []).join(' ');
  const topK = args.top_k ?? 3;
  const results = await search(query, { topK, minScore: 0.1 });
  return {
    ok: true,
    data: {
      results: results.map((r) => ({
        id: r.chunk.id,
        title: r.chunk.title,
        score: Number(r.score.toFixed(3)),
        content: r.chunk.content,
      })),
    },
  };
}

/**
 * 工具 3：记录食材消耗并更新库存（有副作用，须人工确认）
 * 复用 inventoryService.consumeIngredients（事务保证：全部成功或全部回滚）。
 * 模型只给食材名/数量/单位，程序负责解析为库存 id，模型无法绕过校验直接改库。
 */
async function runMarkConsumed(args) {
  const inventory = listIngredients();
  const items = args.items || [];

  // 1. 名称 → 库存条目解析（只允许 available / needs_confirm 状态，且单位一致）
  const resolved = [];
  for (const it of items) {
    const hit = inventory.find(
      (i) => i.name === it.name && i.unit === it.unit && (i.status === 'available' || i.status === 'needs_confirm')
    );
    if (!hit) {
      throw new ToolError(
        'ITEM_NOT_FOUND',
        `库存中不存在可消耗的食材「${it.name}」（单位 ${it.unit}），请先用 query_inventory 核对名称与单位`
      );
    }
    if (it.quantity > hit.quantity) {
      throw new ToolError(
        'INSUFFICIENT_STOCK',
        `「${it.name}」库存不足（现有 ${hit.quantity}${it.unit}），无法消耗 ${it.quantity}${it.unit}`
      );
    }
    resolved.push({ ingredient_id: hit.id, name: hit.name, quantity: it.quantity, unit: it.unit });
  }

  // 2. 事务执行消耗（库存扣减 + 写入 consumption_records）
  const updated = consumeIngredients(
    resolved.map((r) => ({ ingredient_id: r.ingredient_id, quantity: r.quantity, note: `agent:${r.name}` })),
    'consume'
  );
  return {
    ok: true,
    data: {
      consumed: resolved.map((r) => ({ name: r.name, quantity: r.quantity, unit: r.unit })),
      remaining: updated.map((u) => ({ name: u.name, quantity: u.quantity, unit: u.unit, life_level: u.life_level })),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 工具注册表                                                          */
/* ------------------------------------------------------------------ */

/**
 * 工具注册表：Agent 只能调用这里登记的工具。
 * - access: 'read' = 只读，自动执行；'write' = 修改数据，执行前须人工确认
 * - sideEffect: 是否修改数据（日志与确认逻辑依据此字段）
 * - requireConfirm: 是否需要人工确认
 */
export const TOOL_REGISTRY = {
  query_inventory: {
    name: 'query_inventory',
    description: '查询冰箱当前全部库存。返回每样食材的名称、数量、单位、剩余天数(days_left)与寿命等级(life_level: ok/warn/critical/expired/needs_confirm/consumed/discarded)。',
    access: 'read',
    sideEffect: false,
    requireConfirm: false,
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    run: runQueryInventory,
  },

  search_recipe: {
    name: 'search_recipe',
    description: '根据食材名称检索自建知识库中的家常菜做法。返回 Top-k 条相关菜谱（编号 id、标题、相关性得分、做法要点）。',
    access: 'read',
    sideEffect: false,
    requireConfirm: false,
    schema: {
      type: 'object',
      properties: {
        ingredients: {
          type: 'array',
          minLength: 1,
          maxLength: 5,
          items: { type: 'string' },
          description: '用于检索的食材名列表，如 ["青菜","鸡蛋"]',
        },
        top_k: {
          type: 'number',
          min: 1,
          max: 5,
          description: '返回菜谱条数（可选，默认 3，范围 1~5）',
        },
      },
      required: ['ingredients'],
    },
    run: runSearchRecipe,
  },

  mark_consumed: {
    name: 'mark_consumed',
    description: '记录方案消耗的食材并更新库存（扣减数量、写入消耗记录）。该操作会修改数据，执行前需要用户确认；用户拒绝时不执行并返回拒绝原因。',
    access: 'write',
    sideEffect: true,
    requireConfirm: true,
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minLength: 1,
          maxLength: 10,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, required: true },
              quantity: { type: 'number', min: 0.001, required: true },
              unit: { type: 'string', minLength: 1, required: true },
            },
          },
          description: '消耗清单：每项为 {name: 库存食材名, quantity: 数量, unit: 单位}',
        },
      },
      required: ['items'],
    },
    run: runMarkConsumed,
  },
};

/** 工具执行入口：白名单检查 → Schema 校验 → 权限确认（由 Harness 注入）→ 执行 */
export async function executeTool(toolName, args, { confirm = null } = {}) {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    throw new ToolError('UNKNOWN_TOOL', `工具「${toolName}」不存在，可用工具：${Object.keys(TOOL_REGISTRY).join('、')}`);
  }

  const v = validateArgs(tool.schema, args);
  if (!v.ok) {
    throw new ToolError('INVALID_ARGS', `参数校验失败：${v.errors.join('；')}`);
  }

  if (tool.requireConfirm) {
    if (typeof confirm !== 'function') {
      throw new ToolError('CONFIRM_REQUIRED', `工具「${toolName}」修改数据，必须经用户确认后才能执行`);
    }
    const summary = buildConfirmSummary(toolName, args);
    const agreed = await confirm({ tool: toolName, args, summary });
    if (!agreed) {
      throw new ToolError('USER_REJECTED', `用户拒绝了「${toolName}」的执行：${summary}，本次操作未执行，库存未被修改`);
    }
  }

  return tool.run(args);
}

/** 生成确认提示内容（展示操作内容与影响，供用户确认） */
function buildConfirmSummary(toolName, args) {
  if (toolName === 'mark_consumed') {
    const desc = (args.items || []).map((i) => `${i.name} × ${i.quantity}${i.unit}`).join('、');
    return `将记录以下食材消耗并扣减库存：${desc}`;
  }
  return `调用 ${toolName}，参数 ${JSON.stringify(args)}`;
}

/** 工具清单文本（注入 Agent 系统 Prompt） */
export function buildToolsDescription() {
  return Object.values(TOOL_REGISTRY)
    .map((t) => {
      const schemaText = Object.entries(t.schema.properties)
        .map(([k, f]) => {
          const req = (t.schema.required || []).includes(k) ? '（必填）' : '';
          const range = f.min !== undefined || f.max !== undefined ? ` 范围 ${f.min ?? ''}~${f.max ?? ''}` : '';
          const itemsHint = f.items ? `，元素为 ${f.items.type}${f.items.type === 'object' ? '（含 name/quantity/unit）' : ''}` : '';
          return `${k}: ${f.type}${req}${range}${itemsHint}`;
        })
        .join('；');
      const accessText = t.requireConfirm ? '修改数据，执行前需用户确认' : '只读，自动执行';
      return `- ${t.name}(${schemaText})：${t.description}（${accessText}）`;
    })
    .join('\n');
}
