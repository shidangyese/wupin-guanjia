'use strict';
/* ============================================================
   物品管家 · 本地优先的物品/保质期管理
   数据全部保存在浏览器 localStorage，不上传任何服务器
   ============================================================ */

/* ---------- 小工具 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const pad2 = n => String(n).padStart(2, '0');
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

const fmtISO = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today0 = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
function addMonths(d, n) { // 自动处理月末溢出（1/31 + 1个月 = 2/28）
  const y = d.getFullYear(), m = d.getMonth() + n, day = d.getDate();
  return new Date(y, m, Math.min(day, daysInMonth(y, m)));
}
const daysUntil = iso => Math.round((parseISO(iso) - today0()) / 864e5);
const daysSince = iso => Math.round((today0() - parseISO(iso)) / 864e5);
function relDays(d) { return d < 0 ? `已过期 ${-d} 天` : d === 0 ? '今天到期' : d === 1 ? '明天到期' : `剩 ${d} 天`; }
const dateStamp = () => fmtISO(today0()).replace(/-/g, '');

/* ---------- 数据 ---------- */
const STORE_KEY = 'wupin-guanjia-v1';
const DEFAULT_CATEGORIES = [
  { id: 'cat-food', name: '食品', icon: '🍎', color: '#f59e0b' },
  { id: 'cat-med', name: '药品', icon: '💊', color: '#ef4444' },
  { id: 'cat-daily', name: '日用品', icon: '🧴', color: '#10b981' },
  { id: 'cat-other', name: '其他', icon: '📦', color: '#64748b' },
];
const DEFAULT_LOCATIONS = [
  { id: 'loc-fridge', name: '冰箱冷藏' },
  { id: 'loc-cabinet', name: '厨房橱柜' },
  { id: 'loc-medbox', name: '家庭药箱' },
];
const DEFAULT_SETTINGS = { remindDays: 7, notifyEnabled: false, theme: 'auto', lastNotifyDate: '' };

function migrate(d) {
  d = d || {};
  d.items = Array.isArray(d.items) ? d.items : [];
  d.categories = Array.isArray(d.categories) && d.categories.length ? d.categories : clone(DEFAULT_CATEGORIES);
  d.locations = Array.isArray(d.locations) ? d.locations : clone(DEFAULT_LOCATIONS);
  d.settings = Object.assign(clone(DEFAULT_SETTINGS), d.settings || {});
  d.doseLog = d.doseLog || {}; // 服用提醒发送记录：'物品id|日期|时间' -> true
  d.items.forEach(it => {
    it.quantity = it.quantity ?? 1;
    it.unit = it.unit || '';
    it.notes = it.notes || '';
    it.dosePerDay = it.dosePerDay || null;
    it.doseTimes = Array.isArray(it.doseTimes) ? it.doseTimes : [];
    it.cycleDays = it.cycleDays ?? null;   // 周期更换：每 N 天换一次
    it.cycleAnchor = it.cycleAnchor || null; // 上次更换 / 开始使用日期
  });
  return d;
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { console.warn('数据读取失败，已重置', e); }
  return migrate({});
}
let db = load();
const save = () => localStorage.setItem(STORE_KEY, JSON.stringify(db));

/* ---------- 派生数据 ---------- */
const catById = id => db.categories.find(c => c.id === id);
const locById = id => db.locations.find(l => l.id === id);
const LONG_SHELF_DAYS = 180; // 保质期 ≥180 天（约6个月）视为长保，按剩 1/6 提醒；否则按剩 1/3
const itemRemindDays = it => {
  const v = it.remindDays;
  return v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;
};
// 保质期总天数：仅当登记了生产日期＋保质期时可知
function shelfTotalDays(it) {
  if (!it.productionDate || !it.shelfLifeValue) return null;
  const exp = expiryOf(it);
  if (!exp) return null;
  return Math.max(1, Math.round((parseISO(exp) - parseISO(it.productionDate)) / 864e5));
}
// 临期提醒线（天）：单独设置 > 按比例（有保质期时长时） > 全局天数
function remindThresholdDays(it) {
  const manual = itemRemindDays(it);
  if (manual != null) return manual;
  const total = shelfTotalDays(it);
  if (total == null) return Number(db.settings.remindDays);
  return Math.max(1, Math.ceil(total / (total >= LONG_SHELF_DAYS ? 6 : 3)));
}
function expiryOf(it) {
  if (it.expiryDate) return it.expiryDate;
  if (it.productionDate && it.shelfLifeValue) {
    const p = parseISO(it.productionDate);
    const v = Number(it.shelfLifeValue);
    const u = it.shelfLifeUnit || 'day';
    let r;
    if (u === 'day') r = addDays(p, v);
    else if (u === 'week') r = addDays(p, v * 7);
    else if (u === 'month') r = addMonths(p, v);
    else r = addMonths(p, v * 12);
    return fmtISO(r);
  }
  return null;
}
function computeExpiryFromProduction(prodISO, value, unit) {
  const p = parseISO(prodISO);
  if (unit === 'day') return fmtISO(addDays(p, value));
  if (unit === 'week') return fmtISO(addDays(p, value * 7));
  if (unit === 'month') return fmtISO(addMonths(p, value));
  return fmtISO(addMonths(p, value * 12));
}
function statusOf(it) {
  const exp = expiryOf(it);
  if (!exp) return { code: 'none', exp: null, d: null, th: null };
  const d = daysUntil(exp);
  const th = remindThresholdDays(it);
  const code = d < 0 ? 'expired' : d <= th ? 'soon' : 'ok';
  return { code, exp, d, th };
}
const STATUS_TEXT = { expired: '已过期', soon: '临期', ok: '正常', none: '无到期日' };
/* 周期更换：anchor + cycleDays 为下次更换日；d≤3 天即进入提醒 */
function cycleInfo(it) {
  if (!it.cycleDays || !it.cycleAnchor) return null;
  const due = fmtISO(addDays(parseISO(it.cycleAnchor), Number(it.cycleDays)));
  const d = daysUntil(due);
  const state = d < 0 ? 'due' : d === 0 ? 'today' : d <= 3 ? 'near' : 'later';
  return { due, d, state };
}
function attentionItems() {
  const arr = [];
  db.items.forEach(it => {
    const st = statusOf(it);
    if (st.code === 'expired' || st.code === 'soon') arr.push({ it, st, kind: 'expiry', d: st.d });
    const cy = cycleInfo(it);
    if (cy && cy.d <= 3 && !arr.some(x => x.it.id === it.id)) arr.push({ it, st, kind: 'cycle', d: cy.d, cy });
  });
  return arr.sort((a, b) => a.d - b.d);
}

/* ---------- 主题 ---------- */
const media = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = db.settings.theme || 'auto';
  const dark = t === 'dark' || (t === 'auto' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#22211b' : '#5e7256';
}
media.addEventListener('change', () => { if ((db.settings.theme || 'auto') === 'auto') applyTheme(); });

/* ---------- 导航与渲染 ---------- */
const NAV = [
  { id: 'dash', icon: '🏠', label: '概览' },
  { id: 'items', icon: '📋', label: '物品' },
  { id: 'cats', icon: '🏷️', label: '分类' },
  { id: 'locs', icon: '📍', label: '位置' },
  { id: 'settings', icon: '⚙️', label: '设置' },
];
const TITLES = { dash: '概览', items: '全部物品', cats: '分类管理', locs: '位置管理', settings: '设置' };
let view = 'dash';
const filters = { q: '', status: 'all', cat: 'all', loc: 'all', sort: 'expiry' };

function renderNav() {
  const html = NAV.map(n =>
    `<button class="nav-item${n.id === view ? ' active' : ''}" data-action="nav" data-view="${n.id}"><span class="ico">${n.icon}</span><span>${n.label}</span></button>`
  ).join('');
  $('#nav').innerHTML = html;
  $('#bottomnav').innerHTML = html;
}
function navigate(v) {
  view = v;
  renderNav();
  $('#page-title').textContent = TITLES[v];
  renderMain();
  window.scrollTo(0, 0);
}
function renderMain() {
  const m = $('#main');
  if (view === 'dash') m.innerHTML = viewDash();
  else if (view === 'items') { m.innerHTML = viewItemsShell(); bindItemsToolbar(); renderItemList(); }
  else if (view === 'cats') m.innerHTML = viewCats();
  else if (view === 'locs') m.innerHTML = viewLocs();
  else m.innerHTML = viewSettings();
  updateBell();
}
function updateBell() {
  const n = attentionItems().length;
  const b = $('#bell-badge');
  if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

/* ---------- 概览 ---------- */
const statTile = (icon, label, num, cls) =>
  `<div class="stat card ${cls}"><div class="stat-top"><span class="stat-icon">${icon}</span><span class="stat-label">${label}</span></div><div class="stat-num">${num}</div></div>`;

/* 按时段返回问候语（小标签 + 趣味大标题） */
function greeting() {
  const d = new Date();
  const h = d.getHours();
  const wd = '周' + '日一二三四五六'.charAt(d.getDay());
  const en = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
  let head, sub;
  if (h < 5) { head = '夜深啦，冰箱在做梦呢'; sub = '早点休息，明天再整理也好'; }
  else if (h < 11) { head = '早上好，开箱大吉！'; sub = '新的一天，先看看有什么快到期'; }
  else if (h < 13) { head = '快过期的，先吃掉！'; sub = '趁着新鲜，中午安排一下'; }
  else if (h < 18) { head = '补货小能手，就是你！'; sub = '顺手补补货，晚上不慌'; }
  else { head = '这就是..冰箱的实力吗！'; sub = '今天也要好好收纳呀'; }
  return { label: `${wd} · ${en}`, head, sub };
}

function viewDash() {
  const countBy = code => db.items.filter(it => statusOf(it).code === code).length;
  const total = db.items.length, soon = countBy('soon'), expired = countBy('expired');
  const att = attentionItems();
  const doseItems = db.items.filter(it => it.dosePerDay && statusOf(it).code !== 'expired');
  const g = greeting();
  return `
  <div class="greet"><div class="greet-label">${g.label}</div><div class="greet-hi">${g.head}</div><div class="greet-sub">${g.sub}</div></div>
  ${att.length ? `<div class="alert-banner ${expired > 0 ? 'bad' : 'warn'}">
    <span>⏰ 有 ${att.length} 件物品需要关注：${expired} 件已过期，${soon} 件临期</span>
    <button class="link" data-action="goto-attention">查看 →</button>
  </div>` : ''}
  <div class="stat-grid">
    ${statTile('📦', '物品总数', total, '')}
    ${statTile('⏳', '临期', soon, soon ? 'warn' : '')}
    ${statTile('🚨', '已过期', expired, expired ? 'bad' : '')}
    ${statTile('📍', '存放位置', db.locations.length, '')}
  </div>
  <section class="card section">
    <div class="sec-head"><h2>⏰ 需要关注</h2>${att.length > 8 ? `<button class="link" data-action="goto-attention">全部 ${att.length} 件 →</button>` : ''}</div>
    ${att.length
      ? `<div class="item-list">${att.slice(0, 8).map(x => itemRow(x.it, x.st)).join('')}</div>${att.length > 8 ? `<div class="more-hint">还有 ${att.length - 8} 件…</div>` : ''}`
      : `<div class="empty-mini">🎉 暂无临期或过期物品，一切安好</div>`}
  </section>
  ${doseItems.length ? `<section class="card section">
    <div class="sec-head"><h2>💊 每日服用提醒</h2></div>
    <div class="row-list">${doseItems.map(doseRow).join('')}</div>
    <p class="muted-small" style="margin:10px 0 0">到设定时间会弹系统通知（应用需处于打开状态）；错过的时间点会在打开后补提一次。</p>
  </section>` : ''}
  ${total === 0 ? `<section class="card section"><div class="empty">
    <div class="empty-emoji">📦</div><h3>还没有登记物品</h3>
    <p>登记药品、食品等物品的存放位置和保质期，到期前自动提醒你。<br>也可以到「设置 → 填入示例数据」先看看效果。</p>
    <button class="btn primary" data-action="add-item">＋ 添加第一件物品</button>
  </div></section>` : ''}`;
}

/* ---------- 物品列表 ---------- */
const CHIPS = [['all', '全部'], ['attention', '需关注'], ['soon', '临期'], ['expired', '已过期'], ['ok', '正常'], ['none', '无日期']];

function chipsHTML() {
  const c = { all: db.items.length, soon: 0, expired: 0, ok: 0, none: 0 };
  db.items.forEach(it => { c[statusOf(it).code]++; });
  c.attention = attentionItems().length; // 含到期/临期/该更换的耗材
  return CHIPS.map(([v, t]) =>
    `<button class="chip${filters.status === v ? ' active' : ''}" data-st="${v}">${t}${c[v] ? `<b>${c[v]}</b>` : ''}</button>`).join('');
}
function viewItemsShell() {
  const catOpts = ['<option value="all">全部分类</option>',
    ...db.categories.map(c => `<option value="${c.id}"${filters.cat === c.id ? ' selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`)].join('');
  const locOpts = ['<option value="all">全部位置</option>',
    ...db.locations.map(l => `<option value="${l.id}"${filters.loc === l.id ? ' selected' : ''}>${esc(l.name)}</option>`)].join('');
  const sortOpts = [['expiry', '按到期日（近→远）'], ['expiry-desc', '按到期日（远→近）'], ['created', '按添加时间（新→旧）'], ['name', '按名称']]
    .map(([v, t]) => `<option value="${v}"${filters.sort === v ? ' selected' : ''}>${t}</option>`).join('');
  const chips = chipsHTML();
  return `
  <div class="toolbar">
    <input id="q" class="search" type="search" placeholder="🔍 搜索名称、备注、位置…" value="${esc(filters.q)}">
    <div class="chips" id="status-chips">${chips}</div>
    <div class="select-row">
      <select id="f-cat">${catOpts}</select>
      <select id="f-loc">${locOpts}</select>
      <select id="f-sort">${sortOpts}</select>
    </div>
  </div>
  <div id="list-count" class="muted-small"></div>
  <div id="item-list"></div>`;
}
function bindItemsToolbar() {
  $('#q').addEventListener('input', e => { filters.q = e.target.value; renderItemList(); });
  $('#status-chips').addEventListener('click', e => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    filters.status = b.dataset.st;
    renderItemList();
  });
  $('#f-cat').addEventListener('change', e => { filters.cat = e.target.value; renderItemList(); });
  $('#f-loc').addEventListener('change', e => { filters.loc = e.target.value; renderItemList(); });
  $('#f-sort').addEventListener('change', e => { filters.sort = e.target.value; renderItemList(); });
}
function filteredItems() {
  const q = filters.q.trim().toLowerCase();
  const arr = db.items.filter(it => {
    const st = statusOf(it);
    if (filters.status === 'attention') {
      const cy = cycleInfo(it);
      if (!(st.code === 'expired' || st.code === 'soon') && !(cy && cy.d <= 3)) return false;
    }
    else if (filters.status !== 'all' && st.code !== filters.status) return false;
    if (filters.cat !== 'all' && it.categoryId !== filters.cat) return false;
    if (filters.loc !== 'all' && it.locationId !== filters.loc) return false;
    if (q) {
      const hay = [it.name, it.notes, locById(it.locationId)?.name, catById(it.categoryId)?.name].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (filters.sort === 'expiry') {
    arr.sort((a, b) => {
      const ea = expiryOf(a), eb = expiryOf(b);
      if (!ea && !eb) return 0; if (!ea) return 1; if (!eb) return -1;
      return ea.localeCompare(eb);
    });
  } else if (filters.sort === 'expiry-desc') {
    arr.sort((a, b) => {
      const ea = expiryOf(a), eb = expiryOf(b);
      if (!ea && !eb) return 0; if (!ea) return 1; if (!eb) return -1;
      return eb.localeCompare(ea);
    });
  } else if (filters.sort === 'created') {
    arr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  } else {
    arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }
  return arr;
}
function renderItemList() {
  const listEl = $('#item-list');
  if (!listEl) return;
  const arr = filteredItems();
  $('#list-count').textContent = `共 ${arr.length} 件${arr.length !== db.items.length ? `（全部 ${db.items.length} 件）` : ''}`;
  const chipsEl = $('#status-chips');
  if (chipsEl) chipsEl.innerHTML = chipsHTML();
  listEl.innerHTML = arr.length ? arr.map(it => itemRow(it, statusOf(it))).join('') : `<div class="empty">
    <div class="empty-emoji">🔍</div><h3>没有匹配的物品</h3>
    <p>试试更换筛选条件</p>
    ${db.items.length === 0 ? '<button class="btn primary" data-action="add-item">＋ 添加物品</button>' : ''}
  </div>`;
}
function itemRow(it, st) {
  const cat = catById(it.categoryId);
  const loc = locById(it.locationId);
  const qty = it.quantity != null && it.quantity !== '' ? `<span class="item-qty">×${esc(it.quantity)}${esc(it.unit || '')}</span>` : '';
  const opened = it.openedDate && daysSince(it.openedDate) >= 0 ? ` · 🕑 已开封 ${daysSince(it.openedDate)} 天` : '';
  const dose = it.dosePerDay ? ` · ⏰ 每日 ${it.dosePerDay} 次` : '';
  const cy = cycleInfo(it);
  const cycleMeta = it.cycleDays ? ` · 🔁 每 ${esc(it.cycleDays)} 天更换` : '';
  const badge = st.code === 'none' ? '无到期日' : esc(relDays(st.d));
  const cycleBadge = cy && cy.d <= 30
    ? `<span class="st-badge cy-${cy.state}" title="每 ${esc(it.cycleDays)} 天更换 · 下次 ${cy.due}">${cy.d < 0 ? '🔁 该更换了' : cy.d === 0 ? '🔁 今天更换' : `🔁 ${cy.d} 天后更换`}</span>`
    : '';
  const iconStyle = cat ? ` style="background:${esc(cat.color)}1c;border:1px solid ${esc(cat.color)}45"` : '';
  const barIcon = `<span class="item-icon"${iconStyle}>${cat ? esc(cat.icon) : '📦'}</span>`;
  let bar = '';
  const total = shelfTotalDays(it);
  if (total != null && it.productionDate) {
    const elapsed = Math.min(100, Math.max(0, Math.round(((today0() - parseISO(it.productionDate)) / (total * 864e5)) * 100)));
    bar = `<span class="item-bar" title="保质期已过去 ${elapsed}%"><i style="width:${elapsed}%"></i></span>`;
  }
  return `<button class="item-card st-${st.code}" data-action="edit-item" data-id="${it.id}">
    ${barIcon}
    <span class="item-main">
      <span class="item-name">${esc(it.name)}${qty}</span>
      <span class="item-meta">📍 ${loc ? esc(loc.name) : '未指定'} · ${cat ? esc(cat.name) : '未分类'}${it.notes ? ' · ' + esc(truncate(it.notes, 14)) : ''}${opened}${dose}${cycleMeta}</span>
    </span>
    <span class="item-side">
      <span class="st-badge">${badge}</span>
      ${cycleBadge}
      <span class="item-date">${st.exp || ''}</span>
    </span>
    ${bar}
  </button>`;
}
function doseRow(it) {
  const cat = catById(it.categoryId);
  const times = (it.doseTimes || []).map(t => `<span class="time-chip">${esc(t)}</span>`).join('');
  return `<button class="row-card row-btn" data-action="edit-item" data-id="${it.id}">
    <span class="cat-icon" style="background:var(--brand-weak)">${cat ? esc(cat.icon) : '💊'}</span>
    <span class="row-main"><b>${esc(it.name)}</b><span class="muted-small">每天 ${it.dosePerDay} 次${it.notes ? ' · ' + esc(truncate(it.notes, 14)) : ''}</span></span>
    <span class="dose-times">${times}</span>
  </button>`;
}

/* ---------- 分类管理 ---------- */
function viewCats() {
  const rows = db.categories.map(c => {
    const n = db.items.filter(i => i.categoryId === c.id).length;
    return `<div class="row-card">
      <span class="cat-icon" style="background:${esc(c.color)}22;border:1px solid ${esc(c.color)}55">${esc(c.icon)}</span>
      <span class="row-main"><b>${esc(c.name)}</b><span class="muted-small">${n} 件物品</span></span>
      <button class="icon-btn" data-action="edit-cat" data-id="${c.id}" title="编辑">✏️</button>
      <button class="icon-btn" data-action="del-cat" data-id="${c.id}" title="删除">🗑️</button>
    </div>`;
  }).join('');
  return `<section class="card section">
    <div class="sec-head"><h2>🏷️ 分类</h2><button class="btn small primary" data-action="add-cat">＋ 新建分类</button></div>
    <p class="muted-small">给物品归类，例如药品、食品、调味料、清洁用品…</p>
    <div class="row-list">${rows}</div>
  </section>`;
}
function openCatForm(id) {
  const c = id ? catById(id) : null;
  const layer = openModal(`
    <h3 class="modal-title">${c ? '编辑分类' : '新建分类'}</h3>
    <form id="cat-form">
      <div class="field"><label>名称</label><input name="name" required maxlength="12" value="${esc(c?.name || '')}" placeholder="如：调味料"></div>
      <div class="form-grid2">
        <div class="field"><label>图标（emoji）</label><input name="icon" maxlength="4" value="${esc(c?.icon || '📦')}" placeholder="📦"></div>
        <div class="field"><label>颜色</label><input type="color" name="color" value="${esc(c?.color || '#64748b')}"></div>
      </div>
      <div class="modal-btns">
        <button type="button" class="btn" data-action="close-modal">取消</button>
        <span class="grow"></span>
        <button class="btn primary">保存</button>
      </div>
    </form>`);
  if (window.innerWidth >= 880) layer.querySelector('[name=name]').focus();
  $('#cat-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const data = { name: String(f.get('name')).trim(), icon: String(f.get('icon')).trim() || '📦', color: f.get('color') };
    if (!data.name) return toast('请填写分类名称', 'warn');
    if (c) Object.assign(c, data); else db.categories.push({ id: uid(), ...data });
    save(); closeModalAll(); renderMain();
    toast(c ? '已更新分类' : `已创建「${data.name}」`);
  });
}
async function delCat(id) {
  const c = catById(id);
  if (!c) return;
  const n = db.items.filter(i => i.categoryId === id).length;
  if (n > 0) return toast(`「${c.name}」下还有 ${n} 件物品，请先移动到其他分类`, 'warn');
  if (db.categories.length <= 1) return toast('至少保留一个分类', 'warn');
  if (!(await confirmBox(`删除分类「${c.name}」？`))) return;
  db.categories = db.categories.filter(x => x.id !== id);
  save(); renderMain(); toast('已删除');
}

/* ---------- 位置管理 ---------- */
function viewLocs() {
  const rows = db.locations.map(l => {
    const n = db.items.filter(i => i.locationId === l.id).length;
    return `<div class="row-card">
      <span class="cat-icon" style="background:var(--brand-weak)">📍</span>
      <span class="row-main"><b>${esc(l.name)}</b><span class="muted-small">${n} 件物品</span></span>
      <button class="icon-btn" data-action="edit-loc" data-id="${l.id}" title="编辑">✏️</button>
      <button class="icon-btn" data-action="del-loc" data-id="${l.id}" title="删除">🗑️</button>
    </div>`;
  }).join('');
  return `<section class="card section">
    <div class="sec-head"><h2>📍 存放位置</h2><button class="btn small primary" data-action="add-loc">＋ 新建位置</button></div>
    <p class="muted-small">位置可以是冰箱、橱柜、药箱、储物间、阳台柜…越具体越好找。</p>
    <div class="row-list">${rows || '<div class="empty-mini">还没有位置，点右上角新建</div>'}</div>
  </section>`;
}
function openLocForm(id) {
  const l = id ? locById(id) : null;
  const layer = openModal(`
    <h3 class="modal-title">${l ? '编辑位置' : '新建位置'}</h3>
    <form id="loc-form">
      <div class="field"><label>位置名称</label><input name="name" required maxlength="20" value="${esc(l?.name || '')}" placeholder="如：冰箱冷冻室"></div>
      <div class="modal-btns">
        <button type="button" class="btn" data-action="close-modal">取消</button>
        <span class="grow"></span>
        <button class="btn primary">保存</button>
      </div>
    </form>`);
  if (window.innerWidth >= 880) layer.querySelector('[name=name]').focus();
  $('#loc-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = String(new FormData(e.target).get('name')).trim();
    if (!name) return toast('请填写位置名称', 'warn');
    if (l) Object.assign(l, { name }); else db.locations.push({ id: uid(), name });
    save(); closeModalAll(); renderMain();
    toast(l ? '已更新位置' : `已创建「${name}」`);
  });
}
async function delLoc(id) {
  const l = locById(id);
  if (!l) return;
  const n = db.items.filter(i => i.locationId === id).length;
  if (!(await confirmBox(`删除位置「${l.name}」？${n ? `其下 ${n} 件物品将变为「未指定」。` : ''}`))) return;
  db.locations = db.locations.filter(x => x.id !== id);
  db.items.forEach(it => { if (it.locationId === id) it.locationId = null; });
  filters.loc = 'all';
  save(); renderMain(); toast('已删除');
}

/* ---------- 物品表单 ---------- */
function openItemForm(id) {
  const it = id ? db.items.find(x => x.id === id) : null;
  const exp = it ? expiryOf(it) : '';
  const isProd = !!(it && it.productionDate);
  const doseOn = (it?.doseTimes?.length || 0) > 0;
  const cycleOn = !!(it?.cycleDays && it?.cycleAnchor);
  const doseRows = (doseOn ? it.doseTimes : ['09:00']).map(t =>
    `<div class="dose-row"><input type="time" name="doseTime" value="${esc(t)}"><button type="button" class="icon-btn" data-del-time title="删除这个时间点">✕</button></div>`).join('');
  const catTags = db.categories.map((c, i) => {
    const on = it ? it.categoryId === c.id : i === 0;
    return `<button type="button" class="cat-tag${on ? ' on' : ''}" data-cat="${c.id}">${esc(c.icon)} ${esc(c.name)}</button>`;
  }).join('');
  const locOpts = ['<option value="">未指定</option>',
    ...db.locations.map(l => `<option value="${l.id}"${it?.locationId === l.id ? ' selected' : ''}>${esc(l.name)}</option>`),
    '<option value="__new__">＋ 新建位置…</option>'].join('');
  const units = ['个', '盒', '瓶', '袋', '罐', '包', '支', '片', '箱', '桶', '升', '毫升', '克', '千克'];
  const unitList = units.map(u => `<option value="${u}">`).join('');
  const lifeUnits = [['day', '天'], ['week', '周'], ['month', '月'], ['year', '年']].map(([v, t]) =>
    `<option value="${v}"${(it?.shelfLifeUnit || 'day') === v ? ' selected' : ''}>${t}</option>`).join('');

  const layer = openModal(`
    <h3 class="modal-title">${it ? '编辑物品' : '添加物品'}</h3>
    <form id="item-form">
      <div class="field"><label>名称 *</label><input name="name" required maxlength="40" value="${esc(it?.name || '')}" placeholder="如：阿莫西林、鲜牛奶"></div>
      <div class="field"><label>分类 *</label>
        <div class="cat-tags" id="cat-tags">${catTags}</div>
        <input type="hidden" name="categoryId" value="${esc(it?.categoryId || (db.categories[0] ? db.categories[0].id : ''))}">
      </div>
      <div class="field"><label>数量 / 单位</label><div class="qty-row">
        <input type="number" name="quantity" min="0" step="any" value="${esc(it?.quantity ?? 1)}">
        <input name="unit" list="unit-list" maxlength="6" value="${esc(it?.unit || '')}" placeholder="单位">
        <datalist id="unit-list">${unitList}</datalist>
      </div></div>
      <div class="field"><label>存放位置</label>
        <select name="locationId" id="loc-select">${locOpts}</select>
        <input id="new-loc" class="hidden" style="margin-top:8px" placeholder="输入新位置名称，如：阳台储物柜" maxlength="20">
      </div>
      <div class="field"><label>有效期登记方式</label>
        <div class="seg">
          <label class="seg-item"><input type="radio" name="expmode" value="direct" ${!isProd ? 'checked' : ''}><span>直接填到期日</span></label>
          <label class="seg-item"><input type="radio" name="expmode" value="prod" ${isProd ? 'checked' : ''}><span>生产日期＋保质期</span></label>
        </div>
        <p class="muted-small" id="prop-hint" style="margin:8px 0 0"></p>
      </div>
      <div class="field" id="row-direct" ${isProd ? 'hidden' : ''}><label>到期日期</label><input type="date" name="expiryDate" value="${exp || ''}"></div>
      <div class="field" id="row-prod" ${isProd ? '' : 'hidden'}>
        <div class="form-grid2">
          <div class="field"><label>生产日期</label><input type="date" name="productionDate" value="${esc(it?.productionDate || '')}"></div>
          <div class="field"><label>保质期时长</label><div class="qty-row">
            <input type="number" name="shelfLifeValue" min="0" step="1" value="${esc(it?.shelfLifeValue ?? '')}" placeholder="如 18">
            <select name="shelfLifeUnit">${lifeUnits}</select>
          </div></div>
        </div>
      </div>
      <div class="form-grid2">
        <div class="field"><label>开封日期（选填）</label><input type="date" name="openedDate" value="${esc(it?.openedDate || '')}"></div>
        <div class="field"><label>单独提醒天数</label><input type="number" name="remindDays" min="0" max="365" value="${esc(it?.remindDays ?? '')}" placeholder="留空自动计算"></div>
      </div>
      <div class="field">
        <label class="check-line"><input type="checkbox" id="dose-on" ${doseOn ? 'checked' : ''}> 每日服用提醒（维生素、药品等，次数不限）</label>
        <div id="dose-list" class="${doseOn ? '' : 'hidden'}" style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
          ${doseRows}
          <div><button type="button" class="btn small" id="dose-add">＋ 添加时间点</button></div>
        </div>
      </div>
      <div class="field">
        <label class="check-line"><input type="checkbox" id="cycle-on" ${cycleOn ? 'checked' : ''}> 周期更换提醒（牙刷、滤芯、毛巾等耗材）</label>
        <div id="cycle-fields" class="${cycleOn ? '' : 'hidden'}" style="margin-top:8px">
          <div class="form-grid2">
            <div class="field"><label>更换周期（天）</label><input type="number" name="cycleDays" min="1" max="3650" value="${esc(it?.cycleDays ?? '')}" placeholder="如 90"></div>
            <div class="field"><label>上次更换 / 开始使用</label><input type="date" name="cycleAnchor" value="${esc(it?.cycleAnchor || '')}"></div>
          </div>
          <p class="muted-small" id="cycle-hint" style="margin:4px 0 8px"></p>
          <button type="button" class="btn small" data-action="cycle-done">✓ 今天已更换</button>
        </div>
      </div>
      <div class="field"><label>备注</label><textarea name="notes" rows="2" maxlength="200" placeholder="如：开封后请尽快服用">${esc(it?.notes || '')}</textarea></div>
      <div class="modal-btns">
        ${it ? `<button type="button" class="btn danger-ghost" data-action="del-item" data-id="${it.id}">删除</button>` : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-action="close-modal">取消</button>
        <button class="btn primary">保存</button>
      </div>
    </form>`);

  const form = $('#item-form');
  const locSel = $('#loc-select'), newLoc = $('#new-loc');
  locSel.addEventListener('change', () => newLoc.classList.toggle('hidden', locSel.value !== '__new__'));
  form.querySelectorAll('input[name=expmode]').forEach(r => r.addEventListener('change', () => {
    const prod = form.elements.expmode.value === 'prod';
    $('#row-direct').hidden = prod;
    $('#row-prod').hidden = !prod;
  }));
  $('#dose-on').addEventListener('change', e => $('#dose-list').classList.toggle('hidden', !e.target.checked));
  $('#dose-add').addEventListener('click', () => {
    const row = document.createElement('div');
    row.className = 'dose-row';
    row.innerHTML = '<input type="time" name="doseTime" value="12:00"><button type="button" class="icon-btn" data-del-time title="删除这个时间点">✕</button>';
    $('#dose-list').insertBefore(row, $('#dose-add').parentElement);
  });
  $('#dose-list').addEventListener('click', e => {
    const b = e.target.closest('[data-del-time]');
    if (!b) return;
    const rows = $$('#dose-list .dose-row');
    if (rows.length <= 1) { rows[0].querySelector('input').value = '09:00'; return toast('至少保留一个时间点', 'warn'); }
    b.closest('.dose-row').remove();
  });
  $('#cycle-on').addEventListener('change', e => {
    $('#cycle-fields').classList.toggle('hidden', !e.target.checked);
    updateCycleHint();
  });
  const updateCycleHint = () => {
    const hint = $('#cycle-hint');
    const cd = Number(form.elements.cycleDays.value);
    const anchor = form.elements.cycleAnchor.value;
    if (!cd || cd <= 0 || !anchor) {
      hint.textContent = '设置周期和上次更换日期后，快到日子会自动提醒你更换耗材。';
      return;
    }
    const due = fmtISO(addDays(parseISO(anchor), cd));
    const d = daysUntil(due);
    hint.textContent = d < 0 ? `下次更换：${due}（已超 ${-d} 天，记得更换）`
      : d === 0 ? `下次更换：${due}（就是今天）`
      : `下次更换：${due}（剩 ${d} 天）`;
  };
  ['cycleDays', 'cycleAnchor'].forEach(n => form.elements[n].addEventListener('input', updateCycleHint));
  updateCycleHint();
  const updatePropHint = () => {
    const hint = $('#prop-hint');
    if (form.elements.expmode.value !== 'prod') {
      hint.textContent = '直接填到期日的物品：按「单独提醒天数」或全局默认天数提醒。';
      return;
    }
    const prod = form.elements.productionDate.value;
    const v = Number(form.elements.shelfLifeValue.value);
    if (!prod || !v || v <= 0) {
      hint.textContent = '登记生产日期＋保质期后自动按比例提醒：不足 6 个月的剩 1/3 时提醒，6 个月及以上的剩 1/6 时提醒。';
      return;
    }
    const expStr = computeExpiryFromProduction(prod, v, form.elements.shelfLifeUnit.value);
    const total = Math.max(1, Math.round((parseISO(expStr) - parseISO(prod)) / 864e5));
    const isLong = total >= LONG_SHELF_DAYS;
    const th = Math.max(1, Math.ceil(total / (isLong ? 6 : 3)));
    const override = itemRemindDays({ remindDays: form.elements.remindDays.value }) != null;
    hint.textContent = `保质期共 ${total} 天（${isLong ? '长保' : '短保'}：剩 1/${isLong ? 6 : 3} 时提醒，≈ 提前 ${th} 天）${override ? ' · 已被单独提醒天数覆盖' : ''}`;
  };
  ['productionDate', 'shelfLifeValue', 'shelfLifeUnit', 'remindDays'].forEach(n =>
    form.elements[n].addEventListener('input', updatePropHint));
  $('#cat-tags').addEventListener('click', e => {
    const b = e.target.closest('.cat-tag');
    if (!b) return;
    $$('#cat-tags .cat-tag').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    form.elements.categoryId.value = b.dataset.cat;
  });
  form.querySelectorAll('input[name=expmode]').forEach(r => r.addEventListener('change', updatePropHint));
  updatePropHint();
  if (window.innerWidth >= 880) layer.querySelector('[name=name]').focus();

  form.addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(form);
    const name = String(f.get('name')).trim();
    if (!name) return toast('请填写名称', 'warn');
    const mode = form.elements.expmode.value;
    let expiryDate = null, productionDate = null, shelfLifeValue = null, shelfLifeUnit = null;
    if (mode === 'direct') {
      // 到期日可留空：没有到期日的物品（如只用周期更换的耗材）显示"无到期日"
      expiryDate = String(f.get('expiryDate') || '') || null;
    } else {
      productionDate = String(f.get('productionDate') || '') || null;
      const v = Number(f.get('shelfLifeValue'));
      if (!productionDate || !v || v <= 0) return toast('请填写生产日期和保质期时长', 'warn');
      shelfLifeValue = v;
      shelfLifeUnit = String(f.get('shelfLifeUnit'));
      expiryDate = computeExpiryFromProduction(productionDate, v, shelfLifeUnit);
    }
    let locationId = String(f.get('locationId') || '');
    if (locationId === '__new__') {
      const nm = String(newLoc.value).trim();
      if (!nm) return toast('请输入新位置名称', 'warn');
      let exist = db.locations.find(l => l.name === nm);
      if (!exist) { exist = { id: uid(), name: nm }; db.locations.push(exist); }
      locationId = exist.id;
    }
    const rdRaw = String(f.get('remindDays') || '').trim();
    const doseOnNow = $('#dose-on').checked;
    const doseTimes = doseOnNow ? $$('#dose-list input[type="time"]').map(i => i.value).filter(Boolean).sort() : [];
    if (doseOnNow && !doseTimes.length) return toast('请至少填写一个提醒时间', 'warn');
    const cycleOnNow = $('#cycle-on').checked;
    const cycleDaysRaw = Number(f.get('cycleDays'));
    const cycleAnchorRaw = String(f.get('cycleAnchor') || '').trim();
    const data = {
      name,
      categoryId: String(f.get('categoryId')),
      locationId: locationId || null,
      quantity: String(f.get('quantity')) === '' ? null : Number(f.get('quantity')),
      unit: String(f.get('unit') || '').trim(),
      expiryDate, productionDate, shelfLifeValue, shelfLifeUnit,
      openedDate: String(f.get('openedDate') || '') || null,
      remindDays: rdRaw === '' ? null : Number(rdRaw),
      dosePerDay: doseTimes.length || null,
      doseTimes,
      cycleDays: cycleOnNow && cycleDaysRaw > 0 ? cycleDaysRaw : null,
      cycleAnchor: cycleOnNow && cycleDaysRaw > 0 ? (cycleAnchorRaw || fmtISO(today0())) : null,
      notes: String(f.get('notes') || '').trim(),
      updatedAt: new Date().toISOString(),
    };
    if (it) Object.assign(it, data);
    else db.items.push({ id: uid(), createdAt: new Date().toISOString(), ...data });
    save(); closeModalAll(); renderMain();
    toast(it ? '已保存' : `已添加「${name}」`);
    checkDoses(); // 若当天剂量时间已过，立即补提
  });
}
async function delItem(id) {
  const it = db.items.find(x => x.id === id);
  if (!it) return;
  if (!(await confirmBox(`删除「${it.name}」？此操作不可恢复。`))) return;
  db.items = db.items.filter(x => x.id !== id);
  save(); closeModalAll(); renderMain();
  toast(`已删除「${it.name}」`);
}

/* ---------- 设置 ---------- */
function viewSettings() {
  const s = db.settings;
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  const isFile = location.protocol === 'file:';
  return `
  <section class="card section">
    <h2>⏰ 临期提醒</h2>
    <div class="field" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:6px">
      <label style="margin:0">提前提醒天数</label>
      <div class="stepper">
        <button type="button" data-action="stepper" data-d="-1">−</button>
        <b id="rd-val">${esc(s.remindDays)}</b>
        <button type="button" data-action="stepper" data-d="1">＋</button>
      </div>
    </div>
    <p class="muted-small">直接填到期日的物品：到期前 ${esc(s.remindDays)} 天内标为「临期」。登记了「生产日期＋保质期」的物品自动按比例提醒：保质期不足 6 个月的，剩 1/3 时提醒；6 个月及以上的，剩 1/6 时提醒。单个物品可用「单独提醒天数」覆盖。</p>
    <div class="toggle-row">
      <div><b>桌面通知</b><p class="muted-small">应用打开期间：临期/过期提醒每天 1 次；服用提醒按设定时间弹出，错过的时间点会在打开后补提一次。</p></div>
      <button class="btn small ${s.notifyEnabled ? '' : 'primary'}" data-action="toggle-notify">${s.notifyEnabled ? '已开启 ✓' : '开启'}</button>
    </div>
    ${perm === 'denied' ? '<p class="hint-bad">通知权限已被浏览器拒绝，请在浏览器地址栏的网站设置中允许通知。</p>' : ''}
    ${isFile ? '<p class="hint">当前是直接双击打开（file://），不支持系统通知；其他功能不受影响。想用通知请用「启动手机访问.bat」或托管方式打开。</p>' : ''}
  </section>
  <section class="card section">
    <h2>🎨 外观</h2>
    <div class="seg">
      ${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, t]) =>
        `<label class="seg-item"><input type="radio" name="theme" value="${v}" ${s.theme === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
    </div>
  </section>
  <section class="card section">
    <h2>💾 数据</h2>
    <p class="muted-small">数据仅保存在本设备浏览器中。换设备、换浏览器或重装系统前，请先「导出备份」。</p>
    <div class="btn-col">
      <button class="btn" data-action="export-json">⬇️ 导出备份（JSON）</button>
      <button class="btn" data-action="export-csv">⬇️ 导出表格（CSV，Excel 可打开）</button>
      <button class="btn" data-action="import-json">⬆️ 导入备份（JSON）</button>
      <input type="file" id="import-file" accept=".json,application/json" class="hidden">
      <button class="btn" data-action="seed-demo">🧪 填入示例数据（看看效果）</button>
      <button class="btn danger-ghost" data-action="clear-all">🗑️ 清空全部数据</button>
    </div>
  </section>
  <section class="card section">
    <h2>ℹ️ 关于</h2>
    <p class="muted-small">物品管家 v1 · 本地离线优先的物品保质期管理工具。<br>数据 100% 存在你的设备上，不会上传到任何服务器。</p>
  </section>`;
}

/* ---------- 提醒 ---------- */
function notifyTick(force = false) {
  const today = fmtISO(today0());
  if (!force && db.settings.lastNotifyDate === today) return;
  const att = attentionItems();
  db.settings.lastNotifyDate = today;
  save();
  if (!att.length || !db.settings.notifyEnabled) return;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const lines = att.slice(0, 5).map(x => x.kind === 'cycle'
        ? `· ${x.it.name}：${x.d < 0 ? `该更换了（超 ${-x.d} 天）` : x.d === 0 ? '今天该更换' : `剩 ${x.d} 天该更换`}`
        : `· ${x.it.name}（${relDays(x.st.d)}）`).join('\n');
      const body = `${lines}${att.length > 5 ? `\n…等共 ${att.length} 件` : ''}`;
      new Notification(`📦 物品管家：${att.length} 件物品需要关注`, { body, tag: 'wupin-reminder' });
    }
  } catch (e) { /* 忽略通知失败 */ }
}
/* ---------- 每日服用提醒 ---------- */
const nowHM = () => { const n = new Date(); return `${pad2(n.getHours())}:${pad2(n.getMinutes())}`; };
function pruneDoseLog(today) {
  const cutoff = fmtISO(addDays(today0(), -2));
  for (const k of Object.keys(db.doseLog)) {
    if ((k.split('|')[1] || '') < cutoff) delete db.doseLog[k];
  }
}
// 每 30 秒检查一次：把今天已到点、尚未提醒过的剂量汇总为一条通知/提示
function checkDoses() {
  const today = fmtISO(today0());
  const hm = nowHM();
  const due = [];
  db.items.forEach(it => {
    if (!it.dosePerDay || !(it.doseTimes || []).length) return;
    if (statusOf(it).code === 'expired') return; // 已过期物品不再提醒服用
    it.doseTimes.forEach((t, idx) => {
      if (hm >= t) {
        const key = `${it.id}|${today}|${t}`;
        if (!db.doseLog[key]) due.push({ it, t, idx, key });
      }
    });
  });
  if (!due.length) return;
  due.forEach(d => { db.doseLog[d.key] = true; });
  pruneDoseLog(today);
  save();
  const ord = d => (d.it.dosePerDay > 1 ? `第 ${d.idx + 1} 次` : '');
  toast(`💊 服用提醒：${due.map(d => `${d.it.name} ${d.t} ${ord(d)}`).join('、').trim()}`, 'ok', 6000);
  try {
    if (db.settings.notifyEnabled && 'Notification' in window && Notification.permission === 'granted') {
      const lines = due.slice(0, 5).map(d => `· ${d.it.name}（${d.t} ${ord(d)}）`.replace('（）', '')).join('\n');
      new Notification(`💊 服用提醒（${due.length} 条）`, { body: lines, tag: 'wupin-dose-' + Date.now() });
    }
  } catch (e) { /* 忽略通知失败 */ }
}

async function toggleNotify() {
  if (db.settings.notifyEnabled) {
    db.settings.notifyEnabled = false;
    save(); renderMain(); toast('已关闭桌面通知');
    return;
  }
  if (location.protocol === 'file:') return toast('当前打开方式不支持通知，请用「启动手机访问.bat」或托管方式打开', 'warn');
  if (!('Notification' in window)) return toast('此浏览器不支持桌面通知', 'warn');
  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; }
  }
  if (perm !== 'granted') return toast('未获得通知权限', 'warn');
  db.settings.notifyEnabled = true;
  save(); renderMain();
  notifyTick(true);
  toast('已开启桌面通知');
}

/* ---------- 数据导入导出 ---------- */
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportJSON() {
  const payload = { app: 'wupin-guanjia', version: 1, exportedAt: new Date().toISOString(), data: db };
  downloadFile(`物品管家备份-${dateStamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  toast('已导出备份文件');
}
function exportCSV() {
  const head = ['名称', '分类', '存放位置', '数量', '单位', '到期日期', '剩余天数', '状态', '生产日期', '保质期', '开封日期', '提前提醒天数', '每日提醒', '周期更换', '备注', '添加时间'];
  const q = v => {
    v = v == null ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const unitText = { day: '天', week: '周', month: '个月', year: '年' };
  const rows = db.items.map(it => {
    const st = statusOf(it);
    const cat = catById(it.categoryId), loc = locById(it.locationId);
    const shelf = it.shelfLifeValue ? `${it.shelfLifeValue}${unitText[it.shelfLifeUnit] || '天'}` : '';
    const dose = it.dosePerDay ? `${it.dosePerDay}次/天（${(it.doseTimes || []).join('、')}）` : '';
    const cy = cycleInfo(it);
    const cyc = it.cycleDays ? `每${it.cycleDays}天${cy ? `（下次 ${cy.due}）` : ''}` : '';
    return [it.name, cat?.name || '', loc?.name || '', it.quantity ?? '', it.unit,
      st.exp || '', st.d ?? '', STATUS_TEXT[st.code], it.productionDate || '', shelf,
      it.openedDate || '', it.remindDays ?? '', dose, cyc, it.notes, (it.createdAt || '').slice(0, 10)].map(q).join(',');
  });
  downloadFile(`物品管家-${dateStamp()}.csv`, '\uFEFF' + [head.map(q).join(','), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
  toast('已导出 CSV');
}
function bindImportInput() {
  const inp = $('#import-file');
  inp.addEventListener('change', async () => {
    const file = inp.files[0];
    inp.value = '';
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      const data = d && d.data ? d.data : d;
      if (!data || !Array.isArray(data.items)) throw new Error('格式不正确');
      const ok = await confirmBox(`导入「${file.name}」将覆盖当前数据（${db.items.length} → ${data.items.length} 件物品）。确定继续？`, { okText: '覆盖导入' });
      if (!ok) return;
      db = migrate(data);
      save(); applyTheme(); renderMain();
      toast(`已导入 ${db.items.length} 件物品`);
    } catch (err) {
      toast('导入失败：文件格式不正确', 'warn');
    }
  });
}
async function clearAll() {
  if (!db.items.length) return toast('当前没有物品数据', 'warn');
  const ok = await confirmBox(`确定清空吗？将删除全部 ${db.items.length} 件物品，分类与位置恢复为默认。此操作不可恢复！`, { okText: '全部清空' });
  if (!ok) return;
  db.items = [];
  db.categories = clone(DEFAULT_CATEGORIES);
  db.locations = clone(DEFAULT_LOCATIONS);
  Object.assign(filters, { q: '', status: 'all', cat: 'all', loc: 'all' });
  save(); renderMain(); toast('已清空');
}
function seedDemo() {
  const doSeed = () => {
    const ensureLoc = name => {
      let l = db.locations.find(x => x.name === name);
      if (!l) { l = { id: uid(), name }; db.locations.push(l); }
      return l.id;
    };
    const demo = [
      { name: '鲜牛奶', categoryId: 'cat-food', loc: '冰箱冷藏', prodAgo: 2, shelfDays: 3, quantity: 2, unit: '盒', notes: '早餐喝' },
      { name: '酸奶', categoryId: 'cat-food', loc: '冰箱冷藏', prodAgo: 2, shelfDays: 7, quantity: 4, unit: '杯' },
      { name: '全麦面包', categoryId: 'cat-food', loc: '厨房橱柜', prodAgo: 3, shelfDays: 6, quantity: 1, unit: '袋' },
      { name: '阿莫西林胶囊', categoryId: 'cat-med', loc: '家庭药箱', prodAgo: 367, shelfMonths: 12, quantity: 1, unit: '盒', notes: '处方药，遵医嘱' },
      { name: '维生素C片', categoryId: 'cat-med', loc: '家庭药箱', prodAgo: 300, shelfMonths: 16, quantity: 1, unit: '瓶', dosePerDay: 2, doseTimes: ['09:00', '21:00'], notes: '随餐服用' },
      { name: '洗衣液', categoryId: 'cat-daily', loc: '阳台储物柜', quantity: 1, unit: '桶' },
      { name: '牙刷', categoryId: 'cat-daily', loc: '卫生间', cycleDays: 90, anchorAgo: 95, quantity: 1, unit: '支', notes: '牙医建议三个月一换' },
    ];
    const now = new Date().toISOString();
    demo.forEach(d => db.items.push({
      id: uid(), name: d.name, categoryId: d.categoryId,
      locationId: ensureLoc(d.loc), quantity: d.quantity, unit: d.unit,
      expiryDate: null,
      productionDate: d.prodAgo == null ? null : fmtISO(addDays(today0(), -d.prodAgo)),
      shelfLifeValue: d.shelfDays || d.shelfMonths || null,
      shelfLifeUnit: d.shelfDays ? 'day' : (d.shelfMonths ? 'month' : null),
      openedDate: null, remindDays: null,
      dosePerDay: d.dosePerDay || null, doseTimes: d.doseTimes || [],
      cycleDays: d.cycleDays || null,
      cycleAnchor: d.anchorAgo != null ? fmtISO(addDays(today0(), -d.anchorAgo)) : null,
      notes: d.notes || '',
      createdAt: now, updatedAt: now,
    }));
    save(); renderMain();
    toast('已添加示例数据');
  };
  if (!db.items.length) return doSeed();
  confirmBox('将追加 6 件示例物品（不影响现有数据），继续？', { okText: '添加', danger: false }).then(ok => { if (ok) doSeed(); });
}

/* ---------- 弹窗 / 确认 / Toast ---------- */
function openModal(html) {
  const layer = document.createElement('div');
  layer.className = 'modal-layer';
  layer.innerHTML = `<div class="modal"><div class="sheet-handle"></div>${html}</div>`;
  layer.addEventListener('click', e => { if (e.target === layer) closeTopModal(); });
  $('#modal-root').appendChild(layer);
  document.body.classList.add('noscroll');
  return layer;
}
function closeTopModal() {
  const root = $('#modal-root');
  const last = root.lastElementChild;
  if (!last) return;
  last.remove();
  if (!root.children.length) document.body.classList.remove('noscroll');
}
function closeModalAll() {
  $('#modal-root').innerHTML = '';
  document.body.classList.remove('noscroll');
}
function confirmBox(message, { okText = '删除', danger = true } = {}) {
  return new Promise(resolve => {
    const layer = openModal(`
      <h3 class="modal-title">确认操作</h3>
      <p class="confirm-msg">${esc(message)}</p>
      <div class="modal-btns">
        <span class="grow"></span>
        <button class="btn" data-x="cancel">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-x="ok">${esc(okText)}</button>
      </div>`);
    layer.querySelector('[data-x=cancel]').onclick = () => { closeTopModal(); resolve(false); };
    layer.querySelector('[data-x=ok]').onclick = () => { closeTopModal(); resolve(true); };
  });
}
let toastTimer;
function toast(msg, type = 'ok', duration = 2600) {
  $('#toast-root').innerHTML = `<div class="toast ${type}">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast-root').innerHTML = ''; }, duration);
}

/* ---------- 事件分发 ---------- */
const ACTIONS = {
  'nav': el => navigate(el.dataset.view),
  'goto-attention': () => {
    Object.assign(filters, { q: '', status: 'attention', cat: 'all', loc: 'all', sort: 'expiry' });
    navigate('items');
  },
  'add-item': () => openItemForm(),
  'edit-item': el => openItemForm(el.dataset.id),
  'del-item': el => delItem(el.dataset.id),
  'close-modal': () => closeTopModal(),
  'add-cat': () => openCatForm(),
  'edit-cat': el => openCatForm(el.dataset.id),
  'del-cat': el => delCat(el.dataset.id),
  'add-loc': () => openLocForm(),
  'edit-loc': el => openLocForm(el.dataset.id),
  'del-loc': el => delLoc(el.dataset.id),
  'stepper': el => {
    const d = Number(el.dataset.d);
    db.settings.remindDays = Math.min(365, Math.max(1, Number(db.settings.remindDays) + d));
    save(); renderMain();
  },
  'toggle-notify': () => toggleNotify(),
  'cycle-done': () => {
    const f = document.querySelector('#item-form');
    if (!f) return;
    f.elements.cycleAnchor.value = fmtISO(today0());
    f.elements.cycleAnchor.dispatchEvent(new Event('input', { bubbles: true }));
    toast('已把「上次更换」改为今天，记得点保存');
  },
  'export-json': () => exportJSON(),
  'export-csv': () => exportCSV(),
  'import-json': () => $('#import-file').click(),
  'seed-demo': () => seedDemo(),
  'clear-all': () => clearAll(),
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('change', e => {
  if (e.target.name === 'theme') {
    db.settings.theme = e.target.value;
    save(); applyTheme();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTopModal(); });

/* ---------- 启动 ---------- */
function init() {
  applyTheme();
  renderNav();
  navigate('dash');
  notifyTick();
  checkDoses();
  setInterval(() => notifyTick(), 3600 * 1000); // 应用开着时每小时检查一次到期情况
  setInterval(() => checkDoses(), 30 * 1000);   // 应用开着时每 30 秒检查一次服用提醒
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { notifyTick(); checkDoses(); }
  });
  bindImportInput();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
