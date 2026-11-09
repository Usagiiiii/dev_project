/**
 * 工具层演示脚本（对应实验报告 ▲图2）
 * 依次演示 TOOL-01~06 的行为：Schema 校验、白名单、三个工具的直测与错误拦截。
 * 运行：node scripts/tool-demo.js
 */
import { executeTool, validateArgs, TOOL_REGISTRY } from '../src/services/tools.js';
import { getDb, closeDb } from '../src/db.js';

getDb();

const line = (text) => console.log(`\n==== ${text} ====`);

async function showError(label, fn) {
  try {
    await fn();
    console.log(`${label}：未抛出错误（不符合预期）`);
  } catch (err) {
    console.log(`${label}：${err.name}(${err.code}) — ${err.message}`);
  }
}

/* ---------------------------------------------------------------- */
line('TOOL-01 Schema 校验：正确参数通过，错误类型/缺失必填/越界被拦截');
const cases = [
  ['正确参数 {ingredients:["番茄","鸡蛋"], top_k:3}', TOOL_REGISTRY.search_recipe.schema, { ingredients: ['番茄', '鸡蛋'], top_k: 3 }],
  ['类型错误 {ingredients:"番茄"}', TOOL_REGISTRY.search_recipe.schema, { ingredients: '番茄' }],
  ['缺失必填 {}', TOOL_REGISTRY.search_recipe.schema, {}],
  ['越界 {ingredients:["番茄"], top_k:99}', TOOL_REGISTRY.search_recipe.schema, { ingredients: ['番茄'], top_k: 99 }],
  ['元素缺字段 {items:[{name:"番茄",unit:"个"}]}', TOOL_REGISTRY.mark_consumed.schema, { items: [{ name: '番茄', unit: '个' }] }],
];
for (const [label, schema, args] of cases) {
  const r = validateArgs(schema, args);
  console.log(r.ok ? `✔ ${label} → 通过` : `✘ ${label} → 拦截：${r.errors.join('；')}`);
}

/* ---------------------------------------------------------------- */
line('TOOL-02 白名单：模型生成的任意工具名被 UNKNOWN_TOOL 拦截');
await showError('executeTool("delete_food", {})', () => executeTool('delete_food', {}));

/* ---------------------------------------------------------------- */
line('TOOL-03 工具直测（只读）：query_inventory 返回全部库存与寿命等级');
const inv = await executeTool('query_inventory', {});
console.log(`返回 count=${inv.data.count}`);
console.table(
  inv.data.items.map((i) => ({ 名称: i.name, 数量: `${i.quantity}${i.unit}`, 剩余天数: i.days_left, 寿命等级: i.life_level, 状态: i.status }))
);

/* ---------------------------------------------------------------- */
line('TOOL-04 工具直测（只读）：search_recipe 检索命中番茄炒蛋 KB-07');
const rec = await executeTool('search_recipe', { ingredients: ['番茄', '鸡蛋'], top_k: 3 });
for (const r of rec.data.results) {
  console.log(`  ${r.id}  ${r.title}  score=${r.score}`);
}
console.log(`命中 KB-07：${rec.data.results.some((r) => r.id === 'KB-07') ? '是' : '否'}`);

/* ---------------------------------------------------------------- */
line('TOOL-05 工具直测（错误参数）：top_k 越界返回 INVALID_ARGS');
await showError('search_recipe({ingredients:["番茄"], top_k:99})', () =>
  executeTool('search_recipe', { ingredients: ['番茄'], top_k: 99 })
);

/* ---------------------------------------------------------------- */
line('TOOL-06 权限边界：写工具无确认回调时被 CONFIRM_REQUIRED 拦截');
await showError('mark_consumed(..., confirm=null)', () =>
  executeTool('mark_consumed', { items: [{ name: '番茄', quantity: 2, unit: '个' }] }, { confirm: null })
);
const after = await executeTool('query_inventory', {});
const tomato = after.data.items.find((i) => i.name === '番茄');
console.log(`拦截后库存未变化：番茄仍为 ${tomato.quantity}${tomato.unit}`);

closeDb();
