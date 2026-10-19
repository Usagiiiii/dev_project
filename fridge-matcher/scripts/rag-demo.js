/**
 * RAG 命令行演示入口（实验5 2.6）
 *
 * 用法：
 *   node scripts/rag-demo.js "问题" [--no-rag] [--top-k 3] [--mock-timeout] [--mock-error]
 * 示例：
 *   node scripts/rag-demo.js "冰箱里有青菜和鸡蛋，能做什么菜？"
 *   node scripts/rag-demo.js "番茄和鸡蛋能做什么？" --no-rag
 *
 * 说明：LLM 接口为占位实现（默认 mock），不发起真实网络请求；
 * 设置 LLM_MODE=api + LLM_API_URL + LLM_API_KEY 可切换到 API 接入点骨架。
 */
import { ask, getKbOverview } from '../src/services/ragService.js';
import { sampleChunks } from '../src/services/knowledgeBase.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};

async function main() {
  const question = args.find((a) => !a.startsWith('--')) || '冰箱里有青菜和鸡蛋，能做什么菜？';

  console.log('========================================');
  console.log('实验5 RAG 最小链路演示（LLM 接口占位 / mock）');
  console.log('========================================');

  if (args.length === 0) {
    const kb = getKbOverview();
    console.log(`\n知识库：${kb.stats.chunk_count} 个片段，共 ${kb.stats.total_chars} 字符，切分策略：${kb.stats.strategy}`);
    console.log('抽查片段（用于核对切分质量）：');
    for (const s of sampleChunks(3)) {
      console.log(`  [${s.id}] ${s.title}（${s.content_len} 字）来源：${s.source}`);
    }
  }

  const result = await ask(question, {
    useRag: !flag('--no-rag'),
    topK: Number(flagValue('--top-k')) || 3,
    mock: flag('--mock-timeout') ? { mode: 'timeout', timeoutMs: 200 } : flag('--mock-error') ? { mode: 'error' } : {},
  });

  console.log(`\n问题：${result.question}`);
  console.log(`模式：${result.source === 'rag' ? 'RAG（带检索资料）' : '直接模型（无资料）'}`);
  console.log(`模型：${result.model}`);
  console.log(`耗时：${result.elapsed_ms} ms`);

  if (result.source === 'rag') {
    console.log('\n检索片段（Top-k）：');
    for (const c of result.chunks) {
      console.log(`  [${c.id}] ${c.title}（score=${c.score.toFixed(3)}，命中：${c.matched.join('、')}）`);
    }
  }

  console.log('\n上下文工程：');
  console.log(`  Prompt v${result.prompt?.version}（${result.prompt?.kind === 'rag' ? 'RAG 组' : '直接组'}），字符数 ${result.prompt?.context_chars}，Token 估算 ${result.prompt?.prompt_tokens_estimate}`);
  for (const i of result.audit?.issues || []) console.log(`  - ${i}`);

  console.log('\n回答：');
  if (result.ok && result.answer) {
    console.log(JSON.stringify(result.answer, null, 2));
  } else {
    console.log(`（未通过校验或模型不可用）${JSON.stringify(result.guard_issues || result.error || {})}`);
  }

  if (result.guard_issues?.length) {
    console.log('\n校验问题：');
    for (const i of result.guard_issues) console.log(`  [${i.code}] ${i.message}`);
  }
}

main().catch((err) => {
  console.error('运行失败：', err);
  process.exit(1);
});
