import { search } from './retrieval.js';
import { loadKnowledgeBase, kbStats } from './knowledgeBase.js';
import { buildMessages, auditContext } from './promptTemplates.js';
import { callLLM, LLMError } from './modelClient.js';
import { parseLLMOutput, guardAnswer, getKbIds } from './ragGuard.js';
import { listIngredients } from './inventoryService.js';
import { getPreferences } from './preferenceService.js';
import { log } from '../middleware/logger.js';

/**
 * RAG 最小链路（实验5 2.4）
 *
 * 流程：问题输入 → 检索（关键词 BM25，Top-k）→ 上下文组织（库存+偏好+检索片段）
 *      → 模型调用（LLM 接口占位）→ 回答返回（带出处引用，经过规则校验）。
 *
 * 直接模型组（useRag=false）：不注入检索资料，仅提供库存与偏好上下文，
 * 用于实验5 2.5 与 RAG 组做对比测试。
 */

/**
 * 执行一次 RAG / 直接模型问答。
 * @param {string} question 用户问题
 * @param {object} [options]
 * @param {boolean} [options.useRag=true] true=RAG 组（注入检索资料），false=直接模型组
 * @param {number} [options.topK=3] 检索返回的片段数量 k
 * @param {number} [options.minScore=0.1] 相关性最低得分，低于该值视为无相关资料
 * @param {object} [options.preferences] 覆盖偏好（可选）
 * @param {object} [options.mock] 透传给 callLLM 的 mock 行为配置（mode/reply/ctx）
 * @param {boolean} [options.includeInventory=true] 是否注入库存上下文
 * @param {'v1'|'v2'} [options.version='v2'] Prompt 版本（V1 原版 / V2 修改版）
 * @returns {Promise<object>} 见下方返回结构说明
 */
export async function ask(question, options = {}) {
  const { useRag = true, topK = 3, minScore = 0.1, preferences: prefOverride, mock = {}, includeInventory = true, version = 'v2' } = options;
  const startedAt = Date.now();

  // 1. 组装上下文：库存（含寿命等级）与偏好
  const inventory = includeInventory ? listIngredients() : [];
  const preferences = { ...getPreferences(), ...(prefOverride || {}) };

  // 2. 检索（仅 RAG 组）；无结果或得分过低时 chunks 为空 → 资料不足提示
  const chunks = useRag ? await search(question, { topK, minScore }) : [];

  // 3. 上下文组织（默认 Prompt V2 修改版；可传 version 切换 V1 原版）
  const { messages, version: promptVersion, context_chars, prompt_tokens_estimate } = buildMessages(useRag ? 'rag' : 'direct', {
    question,
    inventory,
    preferences,
    chunks,
  }, version);
  const audit = auditContext({ question, inventory, chunks });

  // 4. 模型调用（接口占位：默认 mock；可模拟超时/不可用）
  let llm;
  try {
    llm = await callLLM({
      messages,
      temperature: 0.3,
      maxTokens: 800,
      timeoutMs: 120000,
      mock: {
        ...mock,
        ctx: { inventory, preferences, chunks, useRag },
      },
    });
  } catch (err) {
    const fallback = err instanceof LLMError ? { code: err.code, message: err.message } : { code: 'LLM_UNKNOWN', message: String(err.message || err) };
    log('warn', 'rag_llm_failed', { question, ...fallback });
    return {
      ok: false,
      question,
      source: useRag ? 'rag' : 'direct',
      model: 'unavailable',
      error: fallback,
      fallback: 'model_unavailable',
      issues: [{ code: fallback.code, message: fallback.message }],
      elapsed_ms: Date.now() - startedAt,
      context_chars,
      prompt_tokens_estimate,
      chunks: useRag ? chunks.map((r) => ({ id: r.chunk.id, title: r.chunk.title, score: r.score, matched: r.matched })) : [],
    };
  }

  // 5. 输出校验（解析 JSON + 白名单/过敏/引用/格式）
  const parsed = parseLLMOutput(llm.text);
  const guard = guardAnswer(parsed, {
    inventory,
    preferences,
    kbIds: getKbIds(),
  });

  const result = {
    ok: guard.ok,
    question,
    source: useRag ? 'rag' : 'direct',
    model: llm.model,
    mode: llm.mode,
    answer: guard.ok ? parsed : null,
    guard_issues: guard.issues,
    chunks: useRag ? chunks.map((r) => ({ id: r.chunk.id, title: r.chunk.title, score: r.score, matched: r.matched })) : [],
    prompt: { version: promptVersion, kind: useRag ? 'rag' : 'direct', context_chars, prompt_tokens_estimate, messages },
    usage: llm.usage,
    audit,
    elapsed_ms: Date.now() - startedAt,
  };

  log('info', 'rag_answered', { question, source: result.source, ok: result.ok, elapsed_ms: result.elapsed_ms });
  return result;
}

/** 知识库概览（供接口/命令行展示） */
export function getKbOverview() {
  const { chunks } = loadKnowledgeBase();
  return {
    stats: kbStats(),
    chunks: chunks.map((c) => ({ id: c.id, title: c.title, source: c.source, content_len: c.content_len, tags: c.tags })),
  };
}
