/**
 * 对比测试：直接模型组 vs RAG 组（实验5 2.5）
 *
 * 固定问题集（7 个，覆盖单片段可答 / 多片段综合 / 资料无答案 / 超出范围）：
 *   1-3 单片段可答；4 安全类单片段；5 多片段综合；6 资料无答案；7 超出任务范围。
 *
 * 两组使用相同问题、相同模型（LLM_MODE=api 时为真实 API 模型，否则 mock）、
 * 相同主要参数（temperature=0.3, maxTokens=800）与相同基本输出格式（JSON）；
 * 差异仅在于：RAG 组注入检索资料并要求引用来源，直接组不提供资料。
 * 每次测试使用独立上下文，互不影响。
 *
 * 用法：node scripts/rag-compare.js
 * 输出：控制台统一对比表 + data/rag-compare-result.json（结构化记录）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask } from '../src/services/ragService.js';
import { getLLMMode } from '../src/services/modelClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.resolve(__dirname, '../data/rag-compare-result.json');

const QUESTIONS = [
  { id: 'Q1', question: '冰箱里只有青菜和鸡蛋，能做什么菜？', type: '单片段可答', expect: '青菜蛋花汤类方案，引用 KB-06' },
  { id: 'Q2', question: '番茄和鸡蛋能做什么家常菜？', type: '单片段可答', expect: '番茄炒蛋类方案，引用 KB-07' },
  { id: 'Q3', question: '豆腐怎么做好吃？', type: '单片段可答', expect: '家常豆腐类方案，引用 KB-08' },
  { id: 'Q4', question: '食材有异味、发黏，还能吃吗？', type: '安全类', expect: '提示不可食用，引用 KB-09' },
  { id: 'Q5', question: '怎样减少冰箱里的食材浪费？', type: '多片段综合', expect: '临期优先+搭配原则，引用 KB-10/11' },
  { id: 'Q6', question: '明天天气怎么样，适合吃什么？', type: '资料无答案', expect: '资料不足提示，不编造' },
  { id: 'Q7', question: '教我做佛跳墙的做法', type: '超出范围', expect: '资料不足提示，不编造' },
];

function shortAnswer(result) {
  if (!result.ok || !result.answer) {
    return result.answer?.message || result.guard_issues?.map((i) => i.message).join('；') || result.error?.message || '（不可用）';
  }
  if (result.answer.error) {
    return `${result.answer.error}: ${result.answer.message}`;
  }
  return result.answer.title || '(无标题)';
}

function refsOf(result) {
  return (result.answer?.references || []).join(',') || '—';
}

async function main() {
  const rows = [];
  for (const q of QUESTIONS) {
    const direct = await ask(q.question, { useRag: false });
    const rag = await ask(q.question, { useRag: true, topK: 3 });
    rows.push({
      ...q,
      direct_answer: shortAnswer(direct),
      direct_refs: refsOf(direct),
      direct_ms: direct.elapsed_ms,
      direct_issues: (direct.guard_issues || []).map((i) => i.code),
      rag_answer: shortAnswer(rag),
      rag_refs: refsOf(rag),
      rag_chunks: rag.chunks.map((c) => c.id).join(','),
      rag_ms: rag.elapsed_ms,
      rag_issues: (rag.guard_issues || []).map((i) => i.code),
      // 人工判断列（实验记录时填写）：
      judge_direct_correctness: '',
      judge_rag_correctness: '',
      judge_rag_ref_reliable: '',
    });
    console.log(`[${q.id}] 完成 direct / rag（${q.type}）`);
  }

  const modelName = getLLMMode() === 'api' ? process.env.LLM_MODEL : 'mock';
  console.log('\n================ 对比测试结果（LLM 为 ' + modelName + '） ================');
  console.log('编号 | 类型 | 期望 | 直接组回答 | 直接组引用 | RAG组回答 | RAG组引用 | RAG检索片段 | 直接ms | RAG ms');
  for (const r of rows) {
    console.log(
      `${r.id} | ${r.type} | ${r.expect}\n    直接: ${r.direct_answer} [${r.direct_refs}] ${r.direct_ms}ms\n    RAG : ${r.rag_answer} [${r.rag_refs}] 片段=${r.rag_chunks} ${r.rag_ms}ms`
    );
  }
  console.log('====================================================================');
  console.log(`说明：模型为 ${modelName}（${getLLMMode() === 'api' ? '真实 API 调用' : 'mock 占位'}），回答为模型实际输出；`);
  console.log(`     人工判断列（正确性/要点遗漏/无依据/引用可靠性）请在实验文档表格中填写。`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({ generated_at: new Date().toISOString(), mode: getLLMMode() === 'api' ? `api:${process.env.LLM_MODEL}` : 'mock', rows }, null, 2), 'utf8');
  console.log(`\n结构化结果已保存：${OUT_FILE}`);
}

main().catch((err) => {
  console.error('对比测试失败：', err);
  process.exit(1);
});
