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
