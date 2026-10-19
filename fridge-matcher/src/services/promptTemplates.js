import { estimateTokens } from './modelClient.js';

/**
 * Prompt 模板与上下文组织（实验5 2.2）—— 原版 V1
 *
 * 说明：实验5 要求「根据测试结果修改至少一次 Prompt，记录原版本、修改原因、
 * 修改内容和结果变化」；本次仅实现原版（V1），修改版（V2）留待基于对比测试
 * 结果在后续迭代实现，文档《实验5-实现说明.md》中记录待改方向。
 *
 * 结构：系统消息（任务要求 + 硬性规则 + 回答格式 + 信息不足处理）
 *      + 用户消息（问题 + 库存/偏好上下文 [+ RAG 组追加检索资料与来源]）
 */

export const PROMPT_VERSION = 'v1';

/** 系统提示：任务要求、硬性规则、回答格式、信息不足处理 */
export function buildSystemPrompt() {
  return [
    '你是「AI冰箱食材寿命匹配器」的料理助手。你的任务是根据用户冰箱的库存、',
    '偏好设置和检索到的知识库资料，生成 1 至 3 套可执行的料理方案。',
    '',
    '硬性规则（必须遵守）：',
    '1. 只能使用「库存清单」中列出的食材，名称必须与库存一致，禁止虚构任何库存食材。',
    '2. 禁止使用与用户过敏/忌口冲突的食材；发生冲突时明确提示，而不是给出方案。',
    '3. 优先消耗剩余寿命最短（临期/需尽快处理）的食材。',
    '4. 必须输出严格 JSON，不要输出任何其他文字。JSON 结构为：',
    '   {"title":"方案名","reason":"推荐理由","cooking_minutes":15,',
    '    "used_items":[{"name":"食材名","quantity":1,"unit":"个"}],',
    '    "required_purchases":[{"name":"缺少的关键食材","quantity":1,"unit":"个"}],',
    '    "optional_purchases":[{"name":"可选配料","quantity":1,"unit":"份"}],',
    '    "steps":["步骤1","步骤2"],"references":["KB-01"]}',
    '5. 信息不足时（没有可食用库存、问题超出任务范围、资料不足），输出',
    '   {"error":"CODE","message":"说明原因"}，不得编造答案或引用。',
    '6. 若提供了「知识库资料」，必须依据资料回答，并在 references 中列出实际',
    '   用到的资料编号（如 KB-06）；资料无法回答时明确说明资料不足。',
  ].join('\n');
}

/** 库存与偏好上下文的组装（与问题一起发给模型） */
export function buildInventoryContext(inventory, preferences = {}) {
  const usable = (inventory || []).filter((i) => i.status === 'available');
  const lines = usable.map(
    (i) => `- ${i.name}：${i.quantity}${i.unit}，剩余约 ${i.days_left ?? '未知'} 天（寿命等级：${i.life_level}）`
  );
  const head = [
    '【库存清单】（只能使用以下食材）',
    lines.length ? lines.join('\n') : '（空）',
    '',
    '【用户偏好】',
    `口味：${preferences.taste ?? '未设置'}；人数：${preferences.servings ?? 1}；最长烹饪时间：${preferences.max_minutes ?? 30} 分钟`,
    `过敏/忌口：${(preferences.allergens || []).join('、') || '无'}`,
    `仅使用现有库存：${preferences.only_use_inventory ? '是' : '否'}；最大补购数：${preferences.max_purchases ?? 2}`,
  ];
  return head.join('\n');
}

/** 检索片段格式化：带编号与来源（供 RAG 组使用） */
export function formatChunks(chunks) {
  if (!chunks || chunks.length === 0) return '';
  const parts = chunks.map((r, idx) => {
    const c = r.chunk;
    return [
      `[${c.id}] ${c.title}`,
      `来源：${c.source}`,
      `内容：${c.content}`,
      `（相关性得分：${r.score.toFixed(3)}，命中特征：${r.matched.join('、')}）`,
    ].join('\n');
  });
  return `【知识库资料】（依据这些资料回答，并在回答中引用编号）\n${parts.join('\n\n')}`;
}

/** 用户消息：直接模型组（无资料） */
export function buildDirectUserMessage({ question, inventory, preferences }) {
  const context = buildInventoryContext(inventory, preferences);
  return [`【用户问题】${question}`, '', context].join('\n');
}

/** 用户消息：RAG 组（带检索资料与来源） */
export function buildRagUserMessage({ question, inventory, preferences, chunks }) {
  const context = buildInventoryContext(inventory, preferences);
  const docs = formatChunks(chunks);
  return [`【用户问题】${question}`, '', context, '', docs].join('\n');
}

/**
 * 组装完整 messages（可选 system 前缀）。
 * @param {'direct'|'rag'} kind
 * @param {object} ctx { question, inventory, preferences, chunks }
 * @returns {{messages: Array, context_chars: number, prompt_tokens_estimate: number}}
 */
export function buildMessages(kind, ctx) {
  const system = buildSystemPrompt();
  const user =
    kind === 'rag'
      ? buildRagUserMessage(ctx)
      : buildDirectUserMessage(ctx);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  return {
    messages,
    version: PROMPT_VERSION,
    kind,
    context_chars: system.length + user.length,
    prompt_tokens_estimate: estimateTokens(system + user),
  };
}

/**
 * 上下文工程检查：记录无关/重复信息检查结果。
 * - 检查用户问题与库存之间是否有可匹配的食材（避免发送与问题无关的整库信息时可精简）；
 * - 检测上下文内是否有重复片段文本。
 */
export function auditContext(ctx) {
  const inventory = ctx.inventory || [];
  const question = ctx.question || '';
  const issues = [];
  if (inventory.length > 0 && !ctx.skipInventoryAudit) {
    const hit = inventory.some(
      (i) => i.status === 'available' && question.includes(i.name)
    );
    if (!hit) {
      issues.push('当前问题未直接命中库存食材名，可考虑精简库存上下文');
    }
  }
  const chunks = ctx.chunks || [];
  const ids = chunks.map((r) => r.chunk.id);
  if (new Set(ids).size !== ids.length) {
    issues.push('检索片段存在重复，已按 Top-k 去重后发送');
  }
  return {
    issues,
    note: '上下文工程检查：默认发送「问题 + 库存 + 偏好 [+ 检索资料]」；对与问题无关的字段按需精简。',
  };
}
