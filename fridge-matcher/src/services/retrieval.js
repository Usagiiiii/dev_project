import { loadKnowledgeBase } from './knowledgeBase.js';

/**
 * 关键词检索模块（实验5 2.4）
 *
 * 选择理由：
 * 1) 本项目坚持零第三方依赖，纯 JS 可实现的确定性检索便于解释与测试；
 * 2) 知识库仅 12 条，BM25 线性打分即可满足性能要求（O(N) 扫描）；
 * 3) 向量检索依赖 embedding 模型，与「LLM 接口先空出」的策略一致，
 *    后续接入 API 后可在此处扩展 embedding 打分（见 RetrievalResult）。
 *
 * 检索方法：中文 2-gram（二元组）特征 + 简化 BM25。
 * - 对文档文本与查询做相同的字符特征化：连续汉字按 2-gram 切分，保留单字兜底；
 * - 用 BM25 公式对每个特征打分（tf、idf、长度归一化）；
 * - 返回按相关性降序的 Top-k 片段，并附命中特征作为排序依据（可解释）。
 */

const STOP_FEATURES = new Set([
  // 单字停用词（虽然当前特征只保留 2-gram，保留单字表便于后续扩展）
  '的', '是', '了', '在', '有', '和', '与', '或', '吗', '呢', '啊', '吧',
  // 常见功能词 2-gram：与食材/料理无关，避免宽泛命中
  '什么', '怎么', '如何', '这样', '那样', '这个', '那个', '哪些', '哪里',
  '今天', '明天', '昨天', '可以', '能够', '做法', '适合', '能做', '知道',
  '请问', '一下', '一个', '一种', '东西',
]);

/**
 * 提取查询/文档的 2-gram 特征集合（去停用词）。
 * 说明：仅保留 2-gram 而不保留单字，避免"天""水"等高频单字带来的
 * 宽泛命中噪音（例如"明天天气怎么样"不应命中任何知识库片段）。
 */
export function extractFeatures(text) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  if (clean.length < 2) return [];
  const features = new Set();
  for (let i = 0; i + 1 < clean.length; i++) {
    const bi = clean.slice(i, i + 2);
    if (!STOP_FEATURES.has(bi)) features.add(bi);
  }
  return [...features];
}

/** 计算单个文档的 BM25 得分 */
function bm25Score(queryFeatures, docText, docLen, avgDocLen, df, totalDocs, k1 = 1.5, b = 0.75) {
  const text = docText.replace(/\s/g, '');
  let score = 0;
  const matched = [];
  for (const f of queryFeatures) {
    const count = text.split(f).length - 1;
    if (count === 0) continue;
    const tf = count;
    const idf = Math.log(1 + (totalDocs - df[f] + 0.5) / (df[f] + 0.5));
    const norm = k1 * (1 - b + b * (docLen / avgDocLen));
    score += idf * (tf * (k1 + 1)) / (tf + norm);
    matched.push(f);
  }
  return { score, matched };
}

/**
 * 从知识库构建领域特征表（tags 并集 + 标题中不含助词的 2-gram）。
 * 用于「领域过滤」：查询特征必须命中领域词才算与知识库相关，
 * 避免"的做""适合"等无信息量功能词造成宽泛命中（例如"佛跳墙的做法"不应命中任何片段）。
 */
function buildDomainFeatures(chunks) {
  const set = new Set();
  for (const c of chunks) {
    for (const t of c.tags || []) {
      if (t.length >= 2) set.add(t);
    }
    for (const f of extractFeatures(c.title)) {
      if (!f.includes('的') && !f.includes('是') && !f.includes('在') && !f.includes('有')) {
        set.add(f);
      }
    }
  }
  return set;
}

/**
 * 关键词检索：返回按相关性降序的片段。
 * @param {string} query 用户问题
 * @param {{topK?: number, minScore?: number}} options
 * @returns {Promise<Array<{chunk: object, score: number, matched: string[]}>>}
 */
export async function search(query, options = {}) {
  const { topK = 3, minScore = 0.1 } = options;
  const { chunks } = loadKnowledgeBase();

  const queryFeatures = extractFeatures(query);
  if (queryFeatures.length === 0) return [];

  // 领域过滤：查询特征未命中任何知识库领域词 → 视为无相关资料（不强行返回片段）
  const domain = buildDomainFeatures(chunks);
  const hasDomainHit = queryFeatures.some((f) => domain.has(f));
  if (!hasDomainHit) return [];

  // 统计文档频率 df 与平均长度
  const df = {};
  let totalLen = 0;
  for (const c of chunks) {
    const feats = new Set(extractFeatures(c.doc_text));
    for (const f of feats) df[f] = (df[f] || 0) + 1;
    totalLen += c.doc_text.replace(/\s/g, '').length;
  }
  const avgDocLen = totalLen / chunks.length;

  const scored = chunks
    .map((chunk) => {
      const { score, matched } = bm25Score(
        queryFeatures,
        chunk.doc_text,
        chunk.doc_text.replace(/\s/g, '').length,
        avgDocLen,
        df,
        chunks.length
      );
      return { chunk, score, matched };
    })
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

/** 检索结果占位说明：接入向量检索时在此返回 embedding 相似度排序 */
export const RETRIEVAL_MODE = 'bm25_keyword';
