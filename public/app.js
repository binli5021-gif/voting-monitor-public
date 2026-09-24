const app = document.querySelector('#app');
let token = sessionStorage.getItem('voteToken');
let operatorId = sessionStorage.getItem('operatorId');
let snapshot = null;
let selectedPoint = '一号投票点';
let selectedGroup = '';
let query = '';
let refreshTimer;
let listScrollTop = 0;
let pendingRefresh = false;
const pendingIds = new Set();
const addressColorMap = new Map();
const addressColorCount = 10;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';

function renderLogin(error = '') {
  app.innerHTML = `<main class="login-screen"><form class="login-card" id="loginForm"><h1>投票登记</h1><p>请输入登录账号和密码进入系统</p><label class="field">登录账号<input name="operatorId" maxlength="3" placeholder="例如 wlx 或 001" required /></label><label class="field">密码<input name="password" type="password" placeholder="请输入密码" required /></label><div class="error">${esc(error)}</div><button class="primary">登录</button></form></main>`;
  document.querySelector('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(form)) });
      const result = await response.json();
      if (!response.ok) return renderLogin(result.error);
      token = result.token; operatorId = result.operatorId;
      sessionStorage.setItem('voteToken', token); sessionStorage.setItem('operatorId', operatorId);
      await load();
    } catch { renderLogin('无法连接服务器，请检查服务是否启动'); }
  });
}

async function load() {
  const response = await fetch('/api/bootstrap', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) { token = null; sessionStorage.clear(); return renderLogin('登录已失效，请重新登录'); }
  snapshot = await response.json();
  render();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    try {
      const latest = await fetch('/api/bootstrap', { headers: { Authorization: `Bearer ${token}` } });
      if (latest.ok) {
        snapshot = await latest.json();
        const searchFocused = document.activeElement?.classList?.contains('search');
        if (searchFocused) pendingRefresh = true;
        else render();
      }
    } catch { /* 网络短暂中断时保留当前画面，下一轮继续刷新 */ }
  }, 5000);
}

function points() {
  const available = new Set(snapshot.people.map((person) => person.point));
  const standardOrder = ['一号投票点', '二号投票点', '三号投票点', '四号投票点'];
  return standardOrder.filter((point) => available.has(point));
}
function groups(point) { return [...new Set(snapshot.people.filter((person) => person.point === point).map((person) => person.group))].filter(Boolean); }
function countLabel(records) {
  const remaining = records.filter((person) => !person.voted).length;
  return `<span class="muted">${records.length}人</span><span class="remaining-count">（未投票 ${remaining}人）</span>`;
}
function addressColor(address) {
  if (!addressColorMap.has(address)) addressColorMap.set(address, addressColorMap.size % addressColorCount);
  return addressColorMap.get(address);
}
const addressCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
function compareAddress(left, right) {
  const leftParts = String(left || '').match(/\d+|[^\d]+/g) || [];
  const rightParts = String(right || '').match(/\d+|[^\d]+/g) || [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] || '';
    const b = rightParts[index] || '';
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      const difference = Number(a) - Number(b);
      if (difference) return difference;
    } else {
      const difference = addressCollator.compare(a, b);
      if (difference) return difference;
    }
  }
  return 0;
}
function visiblePeople() {
  const normalized = query.trim().toLowerCase();
  return snapshot.people.filter((person) => {
    const inSelection = normalized || (person.point === selectedPoint && (!selectedGroup || person.group === selectedGroup));
    const inSearch = !normalized || [person.name, person.address, person.idCard, person.phone, person.note].some((field) => String(field || '').toLowerCase().includes(normalized));
    return inSelection && inSearch;
  }).sort((left, right) => compareAddress(left.address, right.address) || addressCollator.compare(left.name || '', right.name || ''));
}

function selectionText() {
  return query.trim() ? '全库检索' : `${selectedPoint}${selectedGroup ? ` · ${selectedGroup}` : ''}`;
}

function renderRows() {
  const rows = visiblePeople().map((person) => {
    const pending = pendingIds.has(person.id);
    return `<tr class="person-row household-${addressColor(person.address)} ${person.voted ? 'voted' : ''}" data-person-row="${esc(person.id)}"><td class="action-cell"><button class="action ${person.voted ? 'undo' : ''}" data-action="${person.voted ? 'undo' : 'vote'}" data-id="${esc(person.id)}" ${pending ? 'disabled' : ''}>${pending ? '提交中…' : (person.voted ? '撤销' : '点击投票')}</button></td><td class="address-cell household-${addressColor(person.address)}">${esc(person.address)}</td><td><div class="person-name">${esc(person.name)}</div></td><td class="mobile-main household-${addressColor(person.address)}"><span>${esc(person.address)}</span><strong>${esc(person.name)}</strong></td><td class="phone-cell">${esc(person.phone) || '<span class="muted">未填写</span>'}</td><td class="idcard-cell">${esc(person.idCard) || '<span class="muted">未填写</span>'}</td><td>${esc(person.note) || '<span class="muted">—</span>'}</td><td><span class="status ${person.voted ? 'done' : ''}">${person.voted ? `已投票 · ${esc(person.operatorId)}<br><span class="muted">${formatTime(person.votedAt)}</span>` : '未投票'}</span></td><td class="mobile-details"><div><span>证件</span>${esc(person.idCard) || '未填写'}</div><div><span>电话</span>${esc(person.phone) || '未填写'}</div><div><span>备注</span>${esc(person.note) || '—'}</div></td></tr>`;
  }).join('');
  return rows || '<tr><td colspan="7" class="empty">没有找到匹配人员</td></tr>';
}

function bindPersonRows() {
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); changeStatus(button.dataset.id, button.dataset.action); }));
  document.querySelectorAll('[data-person-row]').forEach((row) => row.addEventListener('click', () => row.classList.toggle('expanded')));
}

function updateSearchResults() {
  const tbody = document.querySelector('tbody');
  if (!tbody) return render();
  tbody.innerHTML = renderRows();
  document.querySelectorAll('.search').forEach((input) => {
    if (input.value !== query) input.value = query;
  });
  document.querySelectorAll('.selection').forEach((element) => {
    element.textContent = `${selectionText()} · ${visiblePeople().length}人`;
  });
  bindPersonRows();
}

async function importWorkbook(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const response = await fetch('/api/import', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData });
    const result = await response.json();
    if (!response.ok) return window.alert(result.error || 'Excel 导入失败');
    const names = result.preview.map((person) => `${person.name}（${person.point}）`).join('、');
    const confirmed = window.confirm(`已读取 ${result.summary.total} 人，包含 ${result.summary.points} 个投票点和 ${result.summary.groups} 个分组。\n\n预览：${names}${result.summary.total > result.preview.length ? '……' : ''}\n\n确认后将替换当前人员名单，并清空当前投票状态和操作记录。是否继续？`);
    if (!confirmed) return;
    const confirmResponse = await fetch('/api/import/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ importToken: result.importToken }) });
    const confirmedResult = await confirmResponse.json();
    if (!confirmResponse.ok) return window.alert(confirmedResult.error || '确认导入失败');
    snapshot = confirmedResult.snapshot;
    selectedPoint = snapshot.people[0]?.point || '';
    selectedGroup = '';
    query = '';
    render();
    window.alert(confirmedResult.message);
  } catch {
    window.alert('无法完成导入，请确认这是电脑端本地服务，并检查网络连接');
  }
}

function bindImportControls() {
  const downloadButton = document.querySelector('#download-template');
  const importButton = document.querySelector('#import-excel');
  const fileInput = document.querySelector('#import-file');
  downloadButton?.addEventListener('click', () => {
    window.location.href = `/api/import-template?token=${encodeURIComponent(token)}`;
  });
  importButton?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const [file] = fileInput.files || [];
    fileInput.value = '';
    if (file) await importWorkbook(file);
  });
}

function render() {
  if (!snapshot) return;
  const currentList = document.querySelector('.table-wrap');
  if (currentList) listScrollTop = currentList.scrollTop;
  const focusedSearch = document.activeElement?.classList?.contains('search') ? document.activeElement : null;
  const focusedSearchState = focusedSearch ? {
    id: focusedSearch.id,
    start: focusedSearch.selectionStart,
    end: focusedSearch.selectionEnd,
  } : null;
  const pointButtons = points().map((point) => { const records = snapshot.people.filter((person) => person.point === point); return `<button class="point-btn ${point === selectedPoint ? 'active' : ''}" data-point="${esc(point)}">${esc(point)} ${countLabel(records)}</button>`; }).join('');
  const groupButtons = groups(selectedPoint).map((group) => { const records = snapshot.people.filter((person) => person.point === selectedPoint && person.group === group); return `<button class="group-btn ${group === selectedGroup ? 'active' : ''}" data-group="${esc(group)}">${esc(group)} ${countLabel(records)}</button>`; }).join('');
  const rows = renderRows();
  app.innerHTML = `<div class="shell"><header class="topbar"><h1>投票登记与实时统计</h1><div class="operator"><span>当前操作员：<strong>${esc(operatorId)}</strong></span><div class="data-tools"><button class="outline" id="download-template">下载导入模板</button><button class="outline" id="import-excel">导入 Excel</button><input id="import-file" type="file" accept=".xlsx,.xls" hidden /></div><button class="outline" id="logout">退出登录</button></div></header><section class="content"><div class="stats"><div class="stat"><span class="stat-label">总人数</span><strong class="stat-value">${snapshot.summary.total}</strong></div><div class="stat"><span class="stat-label">已投票</span><strong class="stat-value">${snapshot.summary.voted}</strong></div><div class="stat"><span class="stat-label">未投票</span><strong class="stat-value">${snapshot.summary.remaining}</strong></div><div class="stat"><span class="stat-label">当前投票率</span><strong class="stat-value">${(snapshot.summary.rate * 100).toFixed(1)}%</strong></div></div><div class="layout"><aside class="panel nav-panel"><h2 class="panel-title">选择投票点</h2><div class="point-row">${pointButtons}</div><div class="group-list">${groupButtons}</div><div class="mobile-toolbar"><input id="search-mobile" class="search" value="${esc(query)}" placeholder="先按地址查找，也可搜索姓名、电话或备注" /><span class="selection">${query.trim() ? '全库检索' : `${esc(selectedPoint)}${selectedGroup ? ` · ${esc(selectedGroup)}` : ''}`} · ${visiblePeople().length}人</span></div></aside><section class="workspace"><div class="panel toolbar desktop-toolbar"><input id="search" class="search" value="${esc(query)}" placeholder="先按地址查找，也可搜索姓名、电话或备注" /><span class="selection">${query.trim() ? '全库检索' : `${esc(selectedPoint)}${selectedGroup ? ` · ${esc(selectedGroup)}` : ''}`} · ${visiblePeople().length}人</span></div><div class="panel table-wrap"><table><thead><tr><th class="action-col">操作</th><th>地址</th><th>姓名</th><th class="phone-col">电话</th><th class="idcard-col">身份证号</th><th>备注</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div><div class="panel logs"><h2 class="panel-title">最近操作记录</h2>${snapshot.logs.length ? snapshot.logs.slice(0, 12).map((log) => `<div class="log"><span class="log-action ${log.action === 'undo' ? 'undo' : ''}">${log.action === 'undo' ? '已撤销' : '已登记'}</span><span>${esc(log.personName)} · 操作员 ${esc(log.operatorId)}</span><span class="muted">${formatTime(log.at)}</span></div>`).join('') : '<div class="empty">暂无操作记录</div>'}</div></section></div></section></div>`;
  const scrollBox = document.querySelector('.table-wrap');
  let syncIndicator = null;
  if (scrollBox) {
    const indicator = document.createElement('div');
    indicator.className = 'scroll-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.innerHTML = '<span></span>';
    scrollBox.append(indicator);
    const thumb = indicator.querySelector('span');
    syncIndicator = () => {
      const maxScroll = scrollBox.scrollHeight - scrollBox.clientHeight;
      const trackHeight = Math.max(0, scrollBox.clientHeight - 16);
      const thumbHeight = maxScroll > 0
        ? Math.max(22, trackHeight * scrollBox.clientHeight / scrollBox.scrollHeight)
        : trackHeight;
      const maxOffset = Math.max(0, trackHeight - thumbHeight);
      const offset = maxScroll > 0 ? maxOffset * scrollBox.scrollTop / maxScroll : 0;
      indicator.classList.toggle('visible', maxScroll > 0);
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${offset}px)`;
    };
    scrollBox.addEventListener('scroll', syncIndicator, { passive: true });
  }
  if (scrollBox) scrollBox.scrollTo(0, listScrollTop);
  syncIndicator?.();
  if (focusedSearchState) {
    const activeSearch = document.querySelector(`#${focusedSearchState.id}`);
    activeSearch?.focus({ preventScroll: true });
    if (activeSearch && focusedSearchState.start !== null && focusedSearchState.end !== null) {
      activeSearch.setSelectionRange(focusedSearchState.start, focusedSearchState.end);
    }
  }
  document.querySelectorAll('.search').forEach((input) => {
    const updateSearch = (event) => {
      query = event.target.value;
      updateSearchResults();
    };
    input.addEventListener('compositionstart', () => { input.dataset.composing = 'true'; });
    input.addEventListener('compositionend', (event) => {
      delete input.dataset.composing;
      updateSearch(event);
    });
    input.addEventListener('input', (event) => {
      if (input.dataset.composing === 'true') return;
      updateSearch(event);
    });
    input.addEventListener('blur', () => {
      if (pendingRefresh) {
        pendingRefresh = false;
        render();
      }
    });
  });
  document.querySelectorAll('[data-point]').forEach((button) => button.addEventListener('click', () => { selectedPoint = button.dataset.point; selectedGroup = ''; listScrollTop = 0; render(); }));
  document.querySelectorAll('[data-group]').forEach((button) => button.addEventListener('click', () => { selectedGroup = button.dataset.group; listScrollTop = 0; render(); }));
  bindPersonRows();
  bindImportControls();
  document.querySelector('#logout').addEventListener('click', () => { clearInterval(refreshTimer); sessionStorage.clear(); token = null; renderLogin(); });
}

async function changeStatus(personId, action) {
  pendingIds.add(personId); render();
  try {
    const response = await fetch('/api/vote', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ personId, action }) });
    const result = await response.json();
    if (!response.ok) { snapshot = result.snapshot || snapshot; render(); window.alert(result.error); return; }
    const person = snapshot.people.find((item) => item.id === result.changed.personId);
    if (person) Object.assign(person, { voted: result.changed.voted, operatorId: result.changed.operatorId, votedAt: result.changed.votedAt });
    const delta = result.changed.voted ? 1 : -1;
    snapshot.summary.voted = Math.max(0, snapshot.summary.voted + delta);
    snapshot.summary.remaining = snapshot.summary.total - snapshot.summary.voted;
    snapshot.summary.rate = snapshot.summary.total ? snapshot.summary.voted / snapshot.summary.total : 0;
    snapshot.updatedAt = result.updatedAt;
    render();
  } finally {
    pendingIds.delete(personId);
    render();
  }
}

if (token && operatorId) load(); else renderLogin();
