/**
 * 运行时 Harness（实验6 2.4 / 2.5）
 *
 * 职责：把模型与工具组织成可观测、可终止、可复核的单 Agent 运行闭环。
 * - run()：主循环——构造任务输入 → 模型调用 → 输出解析 → 工具分发/权限确认/执行
 *          → 结果回喂 → 模型继续或给出 final → 成功标准复核；
 * - 限制强制：最大步数 / 模型调用超时 / 总时限 / 连续解析失败上限，全部由程序执行；
 * - 可观测性：每次运行生成 task_id，记录每步的时间、工具与参数摘要、结果摘要、
 *   错误类型、耗时与最终状态，落盘 logs/agent-<task_id>.json（密钥脱敏：不记录
 *   API Key、不记录消息全文）；
 * - 成功标准复核：模型给出 final 后由程序独立检查（不凭模型自称完成）；
 * - 人工确认：需要确认的工具在执行前展示操作内容与影响，由 confirm 回调决定；
 *   拒绝或超时不执行，并把拒绝结果回喂给模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLLM, LLMError } from './modelClient.js';
import { TOOL_REGISTRY, executeTool } from './tools.js';
import { AGENT_LIMITS, buildTaskMessages, buildToolResultMessage, parseAgentOutput } from './agent.js';
import { listIngredients } from './inventoryService.js';
import { getPreferences } from './preferenceService.js';
import { loadKnowledgeBase } from './knowledgeBase.js';
import { log } from '../middleware/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '../../logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* 工具结果文本化（回喂模型）                                             */
/* ------------------------------------------------------------------ */

/** 把工具返回值转成给模型的文本（保留关键字段，压缩冗余） */
function stringifyToolResult(toolName, result) {
  if (toolName === 'query_inventory') {
    const items = result.data.items || [];
    const lines = items.map(
      (i) => `- ${i.name}：${i.quantity}${i.unit}，剩余 ${i.days_left ?? '?'} 天（${i.life_level}，状态 ${i.status}）`
    );
    return `共 ${items.length} 项库存：\n${lines.join('\n')}`;
  }
  if (toolName === 'search_recipe') {
    const results = result.data.results || [];
    const lines = results.map(
      (r, idx) => `[${idx + 1}] ${r.id} ${r.title}（相关性 ${r.score}）：${r.content}`
    );
    return `检索到 ${results.length} 条相关菜谱：\n${lines.join('\n')}`;
  }
  if (toolName === 'mark_consumed') {
    const consumed = (result.data.consumed || []).map((c) => `${c.name}×${c.quantity}${c.unit}`).join('、');
    return `已确认并更新库存：消耗 ${consumed}；剩余库存详见 remaining。`;
  }
  return JSON.stringify(result);
}

/** 参数摘要（日志用，截断防止日志膨胀；参数内无密钥类字段） */
function summarizeArgs(toolName, args) {
  if (toolName === 'mark_consumed') {
    return { items: (args.items || []).map((i) => `${i.name}×${i.quantity}${i.unit}`).join('、') };
  }
  return JSON.stringify(args).slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* 成功标准复核（2.1 定义的成功标准，由程序执行）                          */
/* ------------------------------------------------------------------ */

/**
 * 复核最终方案是否满足成功标准（不凭模型自称完成）。
 * 成功标准：
 *   S1 final 结构完整（title / steps / used_items 非空，无 error 字段）；
 *   S2 used_items 全部真实存在于库存，且数量不超过现有量；
 *   S3 不使用过敏食材（allergens）；
 *   S4 不使用 expired / needs_confirm 状态的食材；
 *   S5 references（若有）必须是真实 KB 编号；
 *   S6 消耗一致性：若用户已同意 mark_consumed，则库存消耗记录必须与 used_items 一致；
 *      若用户拒绝记录，允许 final 给出方案并附说明（不判失败，标记 note）。
 * @param {object} final 模型给出的最终答案
 * @param {object} ctx { inventory, allergens, kbIds, consumptionAccepted, consumptionMatches }
 * @returns {{ok: boolean, issues: Array<{code:string,message:string}>}}
 */
export function checkSuccess(final, ctx) {
  const issues = [];
  const { inventory, allergens = [], kbIds = [], consumptionAccepted, consumptionMatches } = ctx;

  if (!final || typeof final !== 'object') {
    return { ok: false, issues: [{ code: 'NO_FINAL', message: '模型未给出最终方案' }] };
  }
  if (final.error) {
    return {
      ok: false,
      issues: [{ code: 'MODEL_DECLINED', message: `模型声明无法完成：${final.error} ${final.message || ''}` }],
    };
  }
  if (!final.title || !Array.isArray(final.steps) || final.steps.length === 0 || !Array.isArray(final.used_items) || final.used_items.length === 0) {
    issues.push({ code: 'MISSING_FIELDS', message: 'final 缺少 title / steps / used_items 之一或为空' });
  }

  // S2/S3/S4：逐一核对 used_items
  for (const item of final.used_items || []) {
    const hit = inventory.find((i) => i.name === item.name && i.unit === item.unit && i.status !== 'consumed' && i.status !== 'discarded');
    if (!hit) {
      issues.push({ code: 'FABRICATED_INVENTORY', message: `「${item.name}」不在可用库存中（虚构或已消耗）` });
      continue;
    }
    if (item.quantity > hit.quantity) {
      issues.push({ code: 'INSUFFICIENT_STOCK', message: `「${item.name}」用量 ${item.quantity}${item.unit} 超过库存 ${hit.quantity}${item.unit}` });
    }
    if (allergens.some((a) => String(item.name).includes(a) || String(a).includes(String(item.name)))) {
      issues.push({ code: 'ALLERGEN_CONFLICT', message: `「${item.name}」与过敏原冲突：${allergens.join('、')}` });
    }
    if (hit.life_level === 'expired' || hit.life_level === 'needs_confirm') {
      issues.push({ code: 'FORBIDDEN_INGREDIENT', message: `「${item.name}」状态为 ${hit.life_level}，禁止使用` });
    }
  }

  // S5：引用真实性
  for (const ref of final.references || []) {
    if (!kbIds.includes(ref)) {
      issues.push({ code: 'INVALID_REFERENCE', message: `引用编号 ${ref} 不存在于知识库` });
    }
  }

  // S6：消耗一致性
  if (consumptionAccepted === true && !consumptionMatches) {
    issues.push({ code: 'CONSUMPTION_MISMATCH', message: '用户已同意记录消耗，但库存消耗记录与 used_items 不一致' });
  }

  return { ok: issues.length === 0, issues };
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

/**
 * 运行一次 Agent 任务。
 * @param {string} task 任务目标（自然语言）
 * @param {object} [options]
 *   - confirm: 人工确认回调 async ({tool,args,summary}) => boolean
 *              （缺省 = 自动拒绝；CLI 演示注入 readline，测试注入模拟函数）
 *   - llmOverride: 测试用模型替换 async ({messages, step}) => string
 *              （缺省走真实 callLLM；注入后可用预设文本序列模拟各类边界场景）
 *   - maxSteps / maxTotalMs: 覆盖默认限制（测试用）
 * @returns {Promise<object>} 完整运行结果（含 steps 明细与日志路径）
 */
export async function runAgentTask(task, options = {}) {
  const {
    confirm = null,
    llmOverride = null,
    maxSteps = AGENT_LIMITS.maxSteps,
    maxTotalMs = AGENT_LIMITS.maxTotalMs,
  } = options;

  const taskId = `T${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  let modelMeta = { model: null, mode: null }; // 模型元信息（循环外定义，供日志使用）
  const run = {
    task_id: taskId,
    task,
    status: 'running',
    maxSteps,
    maxTotalMs,
    steps: [],
    final: null,
    success: false,
    success_issues: [],
    elapsed_ms: 0,
  };

  // 上下文（system + user 目标/偏好；工具结果逐步追加）
  const prefs = getPreferences();
  const messages = buildTaskMessages(task, { preferences: prefs });
  const inventorySnapshot = listIngredients().map((i) => ({ ...i }));
  const kbIds = loadKnowledgeBase().chunks.map((c) => c.id);

  let step = 0;
  let parseFailures = 0;
  let consumptionAccepted = null; // null=未请求确认 | true=同意 | false=拒绝

  log('info', 'agent_run_started', { task_id: taskId, task });

  try {
    while (true) {
      // 0) 总时限检查
      if (Date.now() - startedAt > maxTotalMs) {
        run.status = 'total_timeout';
        run.success = false;
        break;
      }

      // 1) 步数检查（一步 = 一次模型调用及其引发的工具执行）
      if (step >= maxSteps) {
        run.status = 'max_steps_reached';
        run.success = false;
        break;
      }
      step += 1;

      // 2) 模型调用（真实 API 或测试注入）
      const stepStart = Date.now();
      let llmText;
      try {
        if (typeof llmOverride === 'function') {
          llmText = await llmOverride({ messages, step });
          modelMeta = { model: 'test-override', mode: 'test' };
        } else {
          const res = await callLLM({
            messages,
            temperature: AGENT_LIMITS.temperature,
            maxTokens: AGENT_LIMITS.maxTokens,
            timeoutMs: AGENT_LIMITS.llmTimeoutMs,
          });
          llmText = res.text;
          modelMeta = { model: res.model, mode: res.mode };
        }
      } catch (err) {
        const code = err instanceof LLMError ? err.code : 'LLM_UNKNOWN';
        run.steps.push({
          step,
          kind: 'llm_error',
          error_code: code,
          message: err.message,
          latency_ms: Date.now() - stepStart,
        });
        run.status = 'llm_failed';
        run.success = false;
        run.reason = `模型调用失败：${code}`;
        log('warn', 'agent_llm_failed', { task_id: taskId, step, code });
        break;
      }

      // 3) 解析模型输出
      const parsed = parseAgentOutput(llmText);
      if (parsed.kind === 'invalid') {
        parseFailures += 1;
        run.steps.push({
          step,
          kind: 'parse_error',
          error_code: parsed.reason,
          latency_ms: Date.now() - stepStart,
        });
        if (parseFailures > AGENT_LIMITS.maxParseRetries) {
          run.status = 'parse_failed';
          run.success = false;
          run.reason = `模型连续 ${parseFailures} 次输出无法解析`;
          break;
        }
        // 有限次修正：把解析错误回喂给模型
        messages.push({ role: 'assistant', content: llmText });
        messages.push(buildToolResultMessage('__parser__', `输出无法解析（${parsed.reason}）：不是合法的 tool/final JSON。请重新输出严格 JSON。`));
        continue;
      }
      parseFailures = 0;

      // 4) 工具调用分支
      if (parsed.kind === 'tool') {
        const { tool, args } = parsed;
        messages.push({ role: 'assistant', content: llmText });
        const toolStart = Date.now();
        const stepRecord = { step, kind: 'tool', tool, args: summarizeArgs(tool, args) };

        // 4a) 白名单 + Schema + 权限（executeTool 内部完成），确认回调由 Harness 注入
        try {
          const result = await executeTool(tool, args, { confirm });
          stepRecord.ok = true;
          stepRecord.result = summarizeResult(tool, result);
          stepRecord.latency_ms = Date.now() - toolStart;
          const resultText = stringifyToolResult(tool, result);
          messages.push(buildToolResultMessage(tool, resultText));
          if (tool === 'mark_consumed') consumptionAccepted = true;
        } catch (err) {
          const code = err instanceof Error && err.code ? err.code : 'TOOL_EXEC_FAILED';
          stepRecord.ok = false;
          stepRecord.error_code = code;
          stepRecord.message = err.message;
          stepRecord.latency_ms = Date.now() - toolStart;
          const resultText = `{ "ok": false, "code": "${code}", "message": "${String(err.message).replace(/"/g, "'")}" }`;
          messages.push(buildToolResultMessage(tool, resultText));
          if (tool === 'mark_consumed' && code === 'USER_REJECTED') consumptionAccepted = false;
        }
        run.steps.push(stepRecord);
        log('info', 'agent_tool_called', { task_id: taskId, step, tool, ok: stepRecord.ok, code: stepRecord.error_code });
        continue; // 回到循环：模型根据工具结果决定下一步
      }

      // 5) 最终答案分支
      if (parsed.kind === 'final') {
        run.steps.push({ step, kind: 'final', latency_ms: Date.now() - stepStart });
        run.final = parsed.answer;

        // 消耗一致性：统计本次运行实际消耗的食材（在确认后执行的前提下）
        const consumptionMatches = checkConsumptionMatches(parsed.answer, inventorySnapshot);
        const successCheck = checkSuccess(parsed.answer, {
          inventory: inventorySnapshot,
          allergens: prefs.allergens || [],
          kbIds,
          consumptionAccepted,
          consumptionMatches,
        });
        run.success = successCheck.ok;
        run.success_issues = successCheck.issues;
        run.status = successCheck.ok ? 'completed' : 'failed';
        run.note = consumptionAccepted === false ? 'user_rejected_consumption' : undefined;
        break;
      }
    }
  } catch (err) {
    run.status = 'harness_error';
    run.success = false;
    run.reason = `Harness 内部错误：${err.message}`;
  }

  run.elapsed_ms = Date.now() - startedAt;
  run.total_steps = run.steps.length;
  run.messages_count = messages.length;

  // 落盘日志（logs/agent-<task_id>.json；不写消息全文与密钥）
  const logPath = path.join(LOG_DIR, `agent-${taskId}.json`);
  fs.writeFileSync(
    logPath,
    JSON.stringify(
      {
        task_id: run.task_id,
        task: run.task,
        status: run.status,
        success: run.success,
        success_issues: run.success_issues,
        note: run.note,
        model: modelMeta.model,
        mode: modelMeta.mode,
        total_steps: run.total_steps,
        elapsed_ms: run.elapsed_ms,
        maxSteps,
        consumptionAccepted,
        steps: run.steps,
        final: run.final,
      },
      null,
      2
    ),
    'utf8'
  );
  run.log_path = logPath;

  log('info', 'agent_run_finished', { task_id: taskId, status: run.status, success: run.success, steps: run.total_steps, elapsed_ms: run.elapsed_ms });
  return run;
}

/** 消耗一致性：用户同意记录后，本次运行实际消耗（通过 DB 差值对比）与方案 used_items 是否一致 */
function checkConsumptionMatches(final, inventorySnapshot) {
  const after = listIngredients();
  const diffs = [];
  for (const item of final.used_items || []) {
    const before = inventorySnapshot.find((i) => i.name === item.name && i.unit === item.unit);
    const now = after.find((i) => i.name === item.name && i.unit === item.unit);
    const consumed = before && now ? Number((before.quantity - now.quantity).toFixed(3)) : 0;
    if (Math.abs(consumed - item.quantity) > 1e-6) {
      diffs.push(`${item.name}: 方案 ${item.quantity}${item.unit}，实际消耗 ${consumed}${item.unit}`);
    }
  }
  return diffs.length === 0;
}

/** 结果摘要（日志用，截断） */
function summarizeResult(toolName, result) {
  if (toolName === 'query_inventory') return `库存 ${result.data.count} 项`;
  if (toolName === 'search_recipe') return `检索到 ${result.data.results.length} 条`;
  if (toolName === 'mark_consumed') return `已消耗 ${(result.data.consumed || []).map((c) => c.name).join('、')}`;
  return JSON.stringify(result).slice(0, 200);
}
