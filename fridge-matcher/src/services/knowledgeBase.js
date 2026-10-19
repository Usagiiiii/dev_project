import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_PATH = path.resolve(__dirname, '../../data/knowledge_base.json');

/**
 * 知识库加载与切分模块（实验5 2.3）
 *
 * 切分策略：按条目切分——knowledge_base.json 中每个 chunk 本身就是一条
 * 来源明确的独立资料，不做跨条目切分，相邻片段之间无重叠。
 * 片段元数据：id / title / source / tags / content / 字符数。
 */
export function loadKnowledgeBase() {
  const raw = fs.readFileSync(KB_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data.chunks) || data.chunks.length === 0) {
    throw new Error('知识库为空或格式错误');
  }
  return { meta: data._meta || {}, chunks: data.chunks.map(enrichChunk) };
}

/** 为片段补充派生元数据：字符数（不含空白）与检索用文档文本 */
function enrichChunk(chunk) {
  const contentLen = chunk.content.replace(/\s/g, '').length;
  return {
    ...chunk,
    content_len: contentLen,
    doc_text: [chunk.title, ...(chunk.tags || []), chunk.content].join(' '),
  };
}

/** 抽查指定数量的片段并返回元数据（用于人工核对切分质量） */
export function sampleChunks(count = 3) {
  const { chunks } = loadKnowledgeBase();
  // 均匀抽样而非只取前 N 条，覆盖不同位置的片段
  const step = Math.max(1, Math.floor(chunks.length / count));
  const picked = [];
  for (let i = 0; i < chunks.length && picked.length < count; i += step) {
    picked.push({
      id: chunks[i].id,
      title: chunks[i].title,
      source: chunks[i].source,
      content_len: chunks[i].content_len,
      content: chunks[i].content,
      tags: chunks[i].tags,
    });
  }
  return picked;
}

/** 统计知识库整体规模，用于上下文工程与实验记录 */
export function kbStats() {
  const { meta, chunks } = loadKnowledgeBase();
  return {
    chunk_count: chunks.length,
    total_chars: chunks.reduce((s, c) => s + c.content_len, 0),
    overlap: false,
    strategy: meta.chunk_strategy || '按条目切分',
  };
}

export { KB_PATH };
