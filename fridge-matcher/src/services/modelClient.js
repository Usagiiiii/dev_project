/**
 * LLM 调用模块（实验5 2.1）
 *
 * 设计说明：
 * - 本模块定义统一调用契约 callLLM()，对外屏蔽模型来源；
 * - 两种模式（环境变量 LLM_MODE 控制，默认 mock）：
 *   1) mock：占位实现，返回可配置的模拟结果，用于跑通 RAG 链路、输出校验与失败处理；
 *   2) api ：真实调用，兼容 OpenAI 协议 chat/completions（豆包、千问等通用），
 *      配置项 LLM_API_URL / LLM_API_KEY / LLM_MODEL 见 .env.example。
 * - 失败处理：HTTP 非 2xx → LLM_HTTP_ERROR；超时 → LLM_TIMEOUT；
 *   网络失败 → LLM_NETWORK_ERROR；JSON/字段缺失 → LLM_BAD_RESPONSE。
 *
 * 配置来源（按优先级）：进程环境变量 > 项目根目录 .env 文件。
 * 安全：.env 已被 .gitignore 忽略，API Key 不会进入版本库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(__dirname, '../../.env');

/** 轻量 .env 加载器（零依赖）：仅注入进程环境变量中不存在的键，不覆盖已有值 */
function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnvFile();

export const LLM_MODES = { MOCK: 'mock', API: 'api' };

export class LLMError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code; // LLM_NOT_CONFIGURED | LLM_TIMEOUT | LLM_NETWORK_ERROR | LLM_HTTP_ERROR | LLM_BAD_RESPONSE | LLM_SERVICE_UNAVAILABLE
    this.meta = meta;
  }
}

export function getLLMMode() {
  return (process.env.LLM_MODE || LLM_MODES.MOCK).toLowerCase();
}

/** 粗略估算 Token 数（中文场景 1 个汉字约 1 token 的简化口径，标记为估算值） */
export function estimateTokens(text) {
  const chars = String(text || '').length;
  return Math.ceil(chars / 1.6);
}

/**
 * 统一模型调用入口。
 * @param {object} options
 * @param {Array<{role:string, content:string}>} options.messages 发送给模型的完整消息
 * @param {number} [options.temperature=0.3]
 * @param {number} [options.maxTokens=800]
 * @param {number} [options.timeoutMs=30000] 调用超时阈值
 * @param {object} [options.mock={}] mock 模式行为配置：
 *   - mode: 'ok' | 'timeout' | 'error'（默认 'ok'）
 *   - reply: 显式模拟回答文本；缺省时使用 mockGenerator(ctx)
 *   - ctx: 供 mockGenerator 使用的结构化上下文（库存/偏好/检索片段）
 *   - timeoutMs: 模拟超时时延（毫秒，默认 3000）
 * @returns {Promise<{model:string, mode:string, text:string, usage:object}>}
 */
export async function callLLM({ messages, temperature = 0.3, maxTokens = 800, timeoutMs = 120000, mock = {} }) {
  const mode = getLLMMode();

  if (mode === LLM_MODES.API) {
    return callApiLLM({ messages, temperature, maxTokens, timeoutMs });
  }
  return callMockLLM({ messages, temperature, maxTokens, mock });
}

/** 真实 API 调用：兼容 OpenAI 协议 chat/completions（豆包、千问等通用） */
async function callApiLLM({ messages, temperature, maxTokens, timeoutMs }) {
  const apiUrl = process.env.LLM_API_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!apiUrl || !apiKey || !model) {
    throw new LLMError(
      'LLM_NOT_CONFIGURED',
      '未配置 LLM_API_URL / LLM_API_KEY / LLM_MODEL（可写入项目根目录 .env，参考 .env.example）'
    );
  }

  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (/timeout/i.test(err.name) || /timeout/i.test(String(err.message))) {
      throw new LLMError('LLM_TIMEOUT', `模型调用超时（超过 ${timeoutMs}ms 无响应）`);
    }
    throw new LLMError('LLM_NETWORK_ERROR', `网络请求失败：${err.message}`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // 忽略响应体读取失败
    }
    throw new LLMError('LLM_HTTP_ERROR', `模型接口返回 HTTP ${res.status}：${detail}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new LLMError('LLM_BAD_RESPONSE', '模型返回内容不是合法 JSON');
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new LLMError('LLM_BAD_RESPONSE', '模型返回缺少 choices[0].message.content 字段');
  }

  return {
    model: data.model || model,
    mode: 'api',
    text,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? null,
      completion_tokens: data.usage?.completion_tokens ?? null,
      total_tokens: data.usage?.total_tokens ?? null,
      note: '来自模型接口 usage 字段',
    },
  };
}

/** Mock 占位实现：模拟成功 / 超时 / 接口不可用 */
async function callMockLLM({ messages, mock = {} }) {
  const mode = mock.mode || 'ok';
  if (mode === 'timeout') {
    await delay(mock.timeoutMs ?? 3000);
    throw new LLMError('LLM_TIMEOUT', `模型调用超时（超过 ${mock.timeoutMs ?? 3000}ms 无响应）`, { simulated: true });
  }
  if (mode === 'error') {
    throw new LLMError('LLM_SERVICE_UNAVAILABLE', '模型服务当前不可用（模拟 502 服务不可用）', { simulated: true });
  }

  const text = mock.reply || mockGenerate(mock.ctx || {}, messages);
  return {
    model: 'mock-llm（占位，未接入真实模型）',
    mode: 'mock',
    text,
    usage: {
      prompt_tokens_estimate: estimateTokens(messages.map((m) => m.content).join('')),
      completion_tokens_estimate: estimateTokens(text),
      note: '估算值：按 1 汉字 ≈ 1 token 简化口径',
    },
  };
}

/**
 * Mock 生成器：模拟模型「依据资料回答」。
 * - RAG 组（ctx.chunks 非空）：取相关性最高片段的标题作为方案基础，
 *   食材名严格取自库存清单（不虚构），references 引用真实资料编号；
 * - RAG 组检索无结果（ctx.useRag 且 chunks 为空）：明确提示资料不足，不编造；
 * - 直接组（无资料要求）：仅基于库存生成通用方案，references 为空。
 * 注意：这是占位实现，用于演示链路与校验，不代表真实模型回答质量。
 */
export function mockGenerate(ctx, messages) {
  const inventory = ctx.inventory || [];
  const prefs = ctx.preferences || {};
  const chunks = ctx.chunks || [];
  const usable = inventory.filter((i) => i.status === 'available');

  // 1. 无可用库存 → 信息不足（先于资料判断）
  if (usable.length === 0) {
    return JSON.stringify({
      error: 'INSUFFICIENT_INFO',
      message: '当前没有可食用的库存食材，无法生成料理方案，请先补充食材。',
    });
  }

  // 2. RAG 组但检索无结果 → 资料不足，不编造回答或引用
  if (ctx.useRag && chunks.length === 0) {
    return JSON.stringify({
      error: 'INSUFFICIENT_DOCS',
      message: '检索未找到与问题相关的知识库资料，无法依据资料回答，建议换个问题或补充资料。',
    });
  }

  // 3. RAG 组有资料 → 依据相关性最高片段生成（食材严格取自库存）
  if (chunks.length > 0) {
    const top = chunks[0];
    const tagHit = usable.filter((i) =>
      (top.chunk.tags || []).some((t) => i.name.includes(t) || t.includes(i.name))
    );
    const used = (tagHit.length > 0 ? tagHit : usable.slice(0, 2)).map((i) => ({
      name: i.name,
      quantity: Math.min(i.quantity, 1),
      unit: i.unit,
    }));
    return JSON.stringify({
      title: `${top.chunk.title}（模拟回答）`,
      reason: `依据知识库片段 ${top.chunk.id} 与当前库存生成`,
      cooking_minutes: prefs.max_minutes || 20,
      used_items: used,
      required_purchases: [],
      optional_purchases: ['盐'],
      steps: [
        '准备上述食材并清洗处理（模拟步骤，来自资料片段）',
        '按知识库对应做法进行烹饪',
        '调味后出锅，注意食材用量与人数匹配',
      ],
      references: chunks.map((c) => c.chunk.id).slice(0, 3),
    });
  }

  // 4. 直接组（无资料要求）→ 基于库存的通用方案
  const used = usable.slice(0, 2).map((i) => ({
    name: i.name,
    quantity: Math.min(i.quantity, 1),
    unit: i.unit,
  }));
  return JSON.stringify({
    title: '库存食材家常方案（模拟回答）',
    reason: '基于当前库存生成的通用方案（未提供检索资料）',
    cooking_minutes: prefs.max_minutes || 20,
    used_items: used,
    required_purchases: [],
    optional_purchases: ['盐'],
    steps: ['清洗并处理食材', '按家常做法烹饪', '调味出锅'],
    references: [],
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
