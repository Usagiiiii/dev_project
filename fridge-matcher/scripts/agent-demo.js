/**
 * 实验6 CLI 演示：真实模型 + 真实工具 + 终端人工确认
 *
 * 用法：
 *   node scripts/agent-demo.js "用冰箱里的临期食材做今晚的菜，并记录消耗"
 *   （不传参数时使用默认任务）
 *
 * 展示内容：
 *   - 每一步：模型请求的工具与参数、工具执行结果、需要确认时的操作提示；
 *   - 人工确认：mark_consumed（修改数据）执行前询问 y/n，拒绝或超时不执行；
 *   - 最终：模型给出的料理方案、程序对成功标准的复核结果与运行日志路径。
 */
import readline from 'node:readline';
import { runAgentTask } from '../src/services/harness.js';
import { getPreferences } from '../src/services/preferenceService.js';

/** 终端人工确认回调：展示操作内容与影响，等待 y/n，30 秒无响应视为拒绝 */
function makeCliConfirm() {
  return async ({ tool, summary }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        rl.close();
        resolve(false); // 超时视为拒绝
      }, 30000);
      rl.question(`\n⚠ 需要确认：工具「${tool}」→ ${summary}。\n  执行吗？(y/n，30秒无响应视为拒绝) `, (ans) => {
        clearTimeout(timer);
        rl.close();
        const a = String(ans || '').trim().toLowerCase();
        resolve(a === 'y' || a === 'yes' || a === '是' || a === '同意');
      });
    });
  };
}

const task = process.argv[2] || '用冰箱里的临期食材做今晚的菜，并记录消耗';

console.log(`\n=== 实验6 Agent 演示 ===`);
console.log(`任务目标：${task}`);
console.log(`用户偏好：${JSON.stringify(getPreferences())}`);

const run = await runAgentTask(task, { confirm: makeCliConfirm() });

console.log(`\n--- 运行轨迹（共 ${run.total_steps} 步）---`);
for (const s of run.steps) {
  if (s.kind === 'tool') {
    console.log(`[${s.step}] 调用工具 ${s.tool}  args=${JSON.stringify(s.args)}`);
    if (s.ok) console.log(`     → OK：${s.result}（${s.latency_ms}ms）`);
    else console.log(`     → 失败[${s.error_code}]：${s.message}`);
  } else if (s.kind === 'final') {
    console.log(`[${s.step}] 模型给出最终方案`);
  } else if (s.kind === 'llm_error') {
    console.log(`[${s.step}] 模型调用失败[${s.error_code}]`);
  } else if (s.kind === 'parse_error') {
    console.log(`[${s.step}] 输出无法解析[${s.error_code}]`);
  }
}

console.log(`\n--- 最终方案 ---`);
if (run.final) {
  if (run.final.error) {
    console.log(`无法完成：${run.final.error} - ${run.final.message}`);
  } else {
    console.log(`菜名：${run.final.title}`);
    console.log(`耗时：${run.final.cooking_minutes} 分钟`);
    console.log(`消耗食材：${(run.final.used_items || []).map((i) => `${i.name}×${i.quantity}${i.unit}`).join('、')}`);
    console.log(`步骤：`);
    (run.final.steps || []).forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    if (run.final.references?.length) console.log(`引用：${run.final.references.join(', ')}`);
    if (run.final.message) console.log(`说明：${run.final.message}`);
  }
} else {
  console.log('（模型未给出最终方案）');
}

console.log(`\n--- 结果 ---`);
console.log(`状态：${run.status}   success=${run.success}`);
if (run.success_issues?.length) {
  console.log(`复核未通过项：`);
  run.success_issues.forEach((i) => console.log(`  - [${i.code}] ${i.message}`));
}
if (run.note) console.log(`备注：${run.note}`);
console.log(`耗时：${run.elapsed_ms}ms`);
console.log(`运行日志：${run.log_path}`);
