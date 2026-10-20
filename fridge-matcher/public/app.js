const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const msg = data?.error?.message || `请求失败 (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function levelLabel(level) {
  const map = {
    needs_confirm: '需人工确认',
    expired: '已过期',
    critical: '今天优先',
    warn: '尽快处理',
    ok: '状态正常',
    unknown: '日期未知',
    consumed: '已消耗',
    discarded: '已丢弃',
  };
  return map[level] || level;
}

async function loadInventory() {
  const { data } = await api('/api/ingredients');
  const list = $('#priority-list');
  list.innerHTML = '';
  if (!data.length) {
    list.innerHTML = '<li>还没有记录食材。请新增或加载样例数据。</li>';
    return;
  }
  for (const item of data) {
    const li = document.createElement('li');
    const days =
      item.days_left === null || item.days_left === undefined
        ? '日期未知'
        : item.days_left < 0
          ? `已过期 ${-item.days_left} 天`
          : `剩余 ${item.days_left} 天`;
    li.innerHTML = `
      <div>
        <strong>${item.name}</strong>
        <div class="meta">${item.quantity}${item.unit} · ${days}${item.notes ? ' · ' + item.notes : ''}</div>
      </div>
      <div>
        <span class="badge ${item.life_level}">${levelLabel(item.life_level)}</span>
        ${
          item.status === 'needs_confirm'
            ? `<button class="small" data-confirm="${item.id}">人工确认</button>`
            : ''
        }
      </div>`;
    list.appendChild(li);
  }
  list.querySelectorAll('[data-confirm]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/ingredients/${btn.dataset.confirm}/confirm`, { method: 'POST', body: '{}' });
        $('#inventory-msg').textContent = '已人工确认，可参与推荐';
        await loadInventory();
      } catch (e) {
        $('#inventory-msg').className = 'msg error';
        $('#inventory-msg').textContent = e.message;
      }
    });
  });
}

async function loadPreferences() {
  const { data } = await api('/api/preferences');
  const form = $('#form-pref');
  form.taste.value = data.taste || '清淡';
  form.servings.value = data.servings;
  form.max_minutes.value = data.max_minutes;
  form.allergens.value = (data.allergens || []).join(',');
  form.only_use_inventory.checked = !!data.only_use_inventory;
  form.max_purchases.value = data.max_purchases;
}

function renderPlans(payload) {
  const issuesEl = $('#issues');
  const plansEl = $('#plans');
  issuesEl.innerHTML = '';
  plansEl.innerHTML = '';

  for (const issue of payload.issues || []) {
    const div = document.createElement('div');
    div.className = 'item';
    div.textContent = `[${issue.code}] ${issue.message}`;
    issuesEl.appendChild(div);
  }

  if (!payload.plans?.length) {
    plansEl.innerHTML = '<p class="hint">暂无可用方案。</p>';
    return;
  }

  for (const plan of payload.plans) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <h3>${plan.title}</h3>
      <div class="meta">${plan.reason} · 约 ${plan.cooking_minutes} 分钟 · 来源：${plan.source}</div>
      <strong>消耗库存</strong>
      <ul>${plan.used_items.map((u) => `<li>${u.name} ${u.quantity}${u.unit}</li>`).join('')}</ul>
      <strong>必需补购</strong>
      <ul>${
        plan.required_purchases.length
          ? plan.required_purchases.map((p) => `<li>${p.name} ${p.quantity}${p.unit}</li>`).join('')
          : '<li>无</li>'
      }</ul>
      <strong>步骤</strong>
      <ul>${plan.steps.map((s) => `<li>${s}</li>`).join('')}</ul>
      <button type="button" data-confirm-plan="${plan.id}">确认执行并更新库存</button>`;
    plansEl.appendChild(card);
  }

  plansEl.querySelectorAll('[data-confirm-plan]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const result = await api(`/api/plans/${btn.dataset.confirmPlan}/confirm`, {
          method: 'POST',
          body: JSON.stringify({ consume: true }),
        });
        $('#plan-msg').className = 'msg';
        $('#plan-msg').textContent = `已确认「${result.data.plan.title}」，库存已更新`;
        await loadInventory();
        btn.disabled = true;
        btn.textContent = '已确认';
      } catch (e) {
        $('#plan-msg').className = 'msg error';
        $('#plan-msg').textContent = e.message;
      }
    });
  });
}

$('#form-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.quantity = Number(body.quantity);
  body.allow_duplicate = true;
  try {
    await api('/api/ingredients', { method: 'POST', body: JSON.stringify(body) });
    e.target.reset();
    e.target.unit.value = '把';
    e.target.quantity.value = '1';
    $('#inventory-msg').className = 'msg';
    $('#inventory-msg').textContent = '食材已保存';
    await loadInventory();
  } catch (err) {
    $('#inventory-msg').className = 'msg error';
    $('#inventory-msg').textContent = err.message;
  }
});

$('#form-pref').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    taste: fd.get('taste'),
    servings: Number(fd.get('servings')),
    max_minutes: Number(fd.get('max_minutes')),
    allergens: String(fd.get('allergens') || '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
    only_use_inventory: !!fd.get('only_use_inventory'),
    max_purchases: Number(fd.get('max_purchases')),
    cookware: ['炒锅', '锅'],
  };
  try {
    await api('/api/preferences', { method: 'PUT', body: JSON.stringify(body) });
    $('#pref-msg').className = 'msg';
    $('#pref-msg').textContent = '偏好已保存';
  } catch (err) {
    $('#pref-msg').className = 'msg error';
    $('#pref-msg').textContent = err.message;
  }
});

/** 渲染一次 RAG / 直接模型问答结果（实验5：来源、检索片段、回答或错误） */
function renderRagAnswer(r) {
  const el = $('#rag-result');
  el.innerHTML = '';
  const meta = `来源：${r.source} · 模型：${r.model}（${r.mode}）· Prompt ${r.prompt?.version || '?'} · 耗时 ${r.elapsed_ms}ms`;

  if (!r.ok) {
    el.innerHTML = `<div class="card rag-error">
      <div class="meta">${meta}</div>
      <p><strong>模型不可用（${r.error?.code}）</strong>：${r.error?.message}</p>
      <p class="hint">已按失败处理降级返回，可检查 .env 中 LLM_API_URL / LLM_API_KEY / LLM_MODEL 配置。</p>
    </div>`;
    return;
  }

  if (r.chunks?.length) {
    const chips = r.chunks.map((c) => `<span class="chip">${c.id} · ${c.title}（${c.score.toFixed(2)}）</span>`).join('');
    el.insertAdjacentHTML('beforeend', `<div class="rag-chunks">检索片段：${chips}</div>`);
  } else if (r.source === 'rag') {
    el.insertAdjacentHTML('beforeend', '<div class="rag-chunks">检索片段：无（资料不足，模型将按规则提示）</div>');
  }

  if (r.answer?.error) {
    el.insertAdjacentHTML('beforeend', `<div class="card rag-error">
      <div class="meta">${meta}</div>
      <p><strong>${r.answer.error}</strong>：${r.answer.message}</p>
      ${r.guard_issues?.length ? `<p class="hint">校验提示：${r.guard_issues.map((i) => `[${i.code}] ${i.message}`).join('；')}</p>` : ''}
    </div>`);
    return;
  }

  const a = r.answer;
  const refs = a.references?.length
    ? a.references.map((x) => `<span class="chip ref">${x}</span>`).join('')
    : '<span class="hint">无引用</span>';
  const purchases = (a.required_purchases?.length || a.optional_purchases?.length)
    ? `<strong>补购</strong><ul>
        ${(a.required_purchases || []).map((p) => `<li>${p.name} ${p.quantity}${p.unit}（必需）</li>`).join('')}
        ${(a.optional_purchases || []).map((p) => `<li>${p.name} ${p.quantity}${p.unit}（可选）</li>`).join('')}
      </ul>`
    : '';
  el.insertAdjacentHTML('beforeend', `<article class="card rag-answer">
    <div class="meta">${meta}</div>
    <h3>${a.title || '(未命名方案)'}</h3>
    <p class="meta">${a.reason || ''}</p>
    <p class="meta">约 ${a.cooking_minutes ?? '?'} 分钟</p>
    <strong>消耗库存</strong>
    <ul>${(a.used_items || []).map((u) => `<li>${u.name} ${u.quantity}${u.unit}</li>`).join('')}</ul>
    ${purchases}
    <strong>步骤</strong>
    <ol>${(a.steps || []).map((s) => `<li>${s}</li>`).join('')}</ol>
    <p class="meta">引用：${refs}</p>
  </article>`);
  if (r.guard_issues?.length) {
    el.insertAdjacentHTML('beforeend', `<p class="hint">校验提示：${r.guard_issues.map((i) => `[${i.code}] ${i.message}`).join('；')}</p>`);
  }
}

$('#form-rag').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const question = String(fd.get('question') || '').trim();
  if (!question) return;
  const useRag = !!fd.get('use_rag');
  const btn = e.target.querySelector('button[type="submit"]');
  const msg = $('#rag-msg');
  btn.disabled = true;
  btn.textContent = '思考中…（真实模型约 2~10 秒）';
  msg.className = 'msg';
  msg.textContent = '正在调用模型…';
  try {
    const res = await api('/api/rag/ask', {
      method: 'POST',
      body: JSON.stringify({ question, use_rag: useRag, top_k: 3 }),
    });
    renderRagAnswer(res.data);
    msg.textContent = `生成完成，来源：${res.data.source} · 模型：${res.data.model} · Prompt ${res.data.prompt?.version}`;
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '提问';
  }
});

$('#btn-generate').addEventListener('click', async () => {
  try {
    await $('#form-pref').requestSubmit?.();
    const fd = new FormData($('#form-pref'));
    const body = {
      preferences: {
        taste: fd.get('taste'),
        servings: Number(fd.get('servings')),
        max_minutes: Number(fd.get('max_minutes')),
        allergens: String(fd.get('allergens') || '')
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
      only_use_inventory: !!fd.get('only_use_inventory'),
      max_purchases: Number(fd.get('max_purchases')),
    };
    // 确保偏好先写入
    await api('/api/preferences', {
      method: 'PUT',
      body: JSON.stringify({
        ...body.preferences,
        only_use_inventory: body.only_use_inventory,
        max_purchases: body.max_purchases,
        cookware: ['炒锅', '锅'],
      }),
    });
    const result = await api('/api/plans/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    renderPlans(result);
    $('#plan-msg').className = 'msg';
    $('#plan-msg').textContent = `生成完成，来源：${result.source}`;
  } catch (err) {
    $('#plan-msg').className = 'msg error';
    $('#plan-msg').textContent = err.message;
  }
});

$('#btn-seed').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/dev/seed', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || '导入失败');
    $('#inventory-msg').textContent = `已导入样例 ${data.count} 条`;
    await loadInventory();
    await loadPreferences();
  } catch (e) {
    $('#inventory-msg').className = 'msg error';
    $('#inventory-msg').textContent = e.message;
  }
});

$('#btn-clear').addEventListener('click', async () => {
  try {
    await fetch('/api/dev/clear', { method: 'POST' });
    $('#inventory-msg').textContent = '库存已清空';
    $('#plans').innerHTML = '';
    $('#issues').innerHTML = '';
    await loadInventory();
  } catch (e) {
    $('#inventory-msg').className = 'msg error';
    $('#inventory-msg').textContent = e.message;
  }
});

loadInventory().catch((e) => {
  $('#inventory-msg').className = 'msg error';
  $('#inventory-msg').textContent = e.message;
});
loadPreferences().catch(() => {});
