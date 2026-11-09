/**
 * Agent 决策循环核心（实验6 2.3）
 *
 * 职责：
 * - 构造 Agent 系统 Prompt（角色定位、工具清单、输出协议、硬性规则）；
 * - 解析模型输出：区分「工具调用请求」与「最终答案」两种协议；
 * - 定义循环控制常量（最大步数 / 模型调用超时 / 总时限 / 解析失败重试上限）；
 * - 每一步的上下文累积由 Harness 负责（本模块不直接触模型与工具）。
 *
 * 输出协议（模型每次输出必须是合法 JSON，二选一）：
 *   1) 工具调用：{"tool":"工具名","args":{...}}
 *   2) 最终答案：{"final":{"title":...,"steps":[...],"used_items":[...],...}}
 *   3) 无法完成：{"final":{"error":"原因类型","message":"说明"}}
 *
 * 一步如何计数：一次「模型调用 →（可能）工具执行 → 结果回喂」算一步，
 * 由 Harness 强制执行 maxSteps，不能只写在提示词里。
 */
import { buildToolsDescription } from './tools.js';

/** 循环控制常量（由程序执行，非仅提示词约束） */
export const AGENT_LIMITS = {
  maxSteps: 8,           // 最大执行步数（模型调用次数上限）
  llmTimeoutMs: 120000,  // 单次模型调用超时
  maxTotalMs: 300000,    // 总运行时限（含工具执行）
  maxParseRetries: 2,    // 连续输出无法解析时的重试上限（超过则终止）
  temperature: 0.3,
  maxTokens: 1200,       // 单次模型输出上限（tool 调用与 final 均需容纳）
};

/** 构造 Agent 系统 Prompt（角色 + 工具清单 + 输出协议 + 硬性规则） */
export function buildAgentSystemPrompt(extra = {}) {
  const prefs = extra.preferences || {};
  const toolsDesc = buildToolsDescription();
  const allergens = (prefs.allergens || []).join('、') || '无';

  return `你是「AI冰箱食材寿命匹配器」的智能体（Agent）。你的任务：根据用户给出的目标，自主决定调用工具获取信息，最终输出可执行的料理方案。

【可用工具】（只能调用以下工具，禁止虚构工具名；每步只调用一个工具，等待工具结果后再决定下一步）
${toolsDesc}

【输出协议】每次输出必须是合法 JSON（第一行是 {，最后一行是 }），禁止任何前后缀文字、解释或代码块标记：
1. 需要调用工具时，输出：{"tool":"工具名","args":{...}}
2. 任务完成时，输出最终方案：{"final":{"title":"菜名","reason":"依据说明","cooking_minutes":N,"used_items":[{"name":"食材名","quantity":数量,"unit":"单位"}],"steps":["步骤1","步骤2",...],"references":["KB-编号"]}}
3. 无法完成任务时，输出：{"final":{"error":"原因类型","message":"中文说明"}}

【硬性规则】（必须遵守）
1. 只能使用工具返回的库存中真实存在的食材，名称与单位必须与 query_inventory 返回一致，禁止虚构。
2. 优先消耗 life_level 为 critical / warn 的临期食材；expired 与 needs_confirm 状态的食材不得使用。
3. 禁止使用过敏/忌口食材（用户过敏：${allergens || '无'}）。
4. 生成 final 之前，必须先调用 mark_consumed 记录方案将消耗的食材（该操作会请求用户确认）；若用户拒绝记录，仍在 final 中给出方案，并在 message 字段说明“用户拒绝记录消耗”。
5. used_items 中的每一项都应真实对应一次消耗记录；用量参考用户人数。
6. steps 给出 3 至 5 条具体、可执行的步骤。
7. references 只能引用 search_recipe 返回的菜谱编号；没有引用时省略该字段。
8. 信息不足（库存为空、检索无结果、无法满足目标）时，不要编造，按协议 3 输出。`;
}

/** 构造任务输入消息（system + user 目标与偏好） */
export function buildTaskMessages(task, extra = {}) {
  const prefs = extra.preferences || {};
  const prefLines = [
    `口味：${prefs.taste || '清淡'}`,
    `人数：${prefs.servings ?? 1}`,
    `最长烹饪时间：${prefs.max_minutes ?? 20} 分钟`,
    `过敏/忌口：${(prefs.allergens || []).join('、') || '无'}`,
  ].join('；');
  return [
    { role: 'system', content: buildAgentSystemPrompt({ preferences: prefs }) },
    { role: 'user', content: `【任务目标】${task}\n\n【用户偏好】${prefLines}` },
  ];
}

/** 工具结果消息（追加进上下文，供模型下一步决策；role 用 user 保证兼容性） */
export function buildToolResultMessage(toolName, resultText) {
  return { role: 'user', content: `【工具结果 ${toolName}】\n${resultText}` };
}

/**
 * 解析模型输出。
 * @param {string} text 模型原始输出
 * @returns {{kind:'tool', tool:string, args:object}
 *         |{kind:'final', answer:object}
 *         |{kind:'invalid', reason:string, raw:string}}
 */
export function parseAgentOutput(text) {
  const raw = String(text || '').trim();
  let parsed = null;

  // 1) 整体 JSON
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 2) 提取首个 { 至最后一个 } 的 JSON 子串（容忍前后缀文字）
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        // 3) 尝试剥离 ```json 代码块标记
        const stripped = raw.replace(/```json|```/g, '').trim();
        try {
          parsed = JSON.parse(stripped);
        } catch {
          parsed = null;
        }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'invalid', reason: 'INVALID_JSON', raw };
  }

  if (parsed.tool !== undefined) {
    if (typeof parsed.tool !== 'string' || !parsed.tool) {
      return { kind: 'invalid', reason: 'MISSING_TOOL_NAME', raw };
    }
    const args = parsed.args === undefined ? {} : parsed.args;
    return { kind: 'tool', tool: parsed.tool, args };
  }

  if (parsed.final !== undefined) {
    if (!parsed.final || typeof parsed.final !== 'object') {
      return { kind: 'invalid', reason: 'MISSING_FINAL', raw };
    }
    return { kind: 'final', answer: parsed.final };
  }

  return { kind: 'invalid', reason: 'UNKNOWN_SHAPE', raw };
}
