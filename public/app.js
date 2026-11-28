'use strict';

/* ---------------- 环境 ---------------- */
const NATIVE = false; /* 打包时由 sync-web 替换成 true */
const BASE = NATIVE ? 'https://150.158.1.111/pig/' : '';
const api = (p) => BASE + p;

const $ = (id) => document.getElementById(id);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/* ---------------- 状态 ---------------- */
let S = null;          // 站视图
let ME = null;         // 我的收集
let CODE = localStorage.getItem('pig.code') || '';
let UID = localStorage.getItem('pig.uid') || '';
let es = null;
let tickTimer = null;
let focusOpen = true;   // 全屏专注界面是否展开（收起后不要被 tick 拉回来）

/* ---------------- 网络 ---------------- */
async function call(path, opts = {}) {
  const res = await fetch(api(path), {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(UID ? { 'X-Pig-Uid': UID } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (res.ok && body.uid) { UID = body.uid; localStorage.setItem('pig.uid', UID); }
  if (res.ok && body.code) { CODE = body.code; localStorage.setItem('pig.code', CODE); }
  return { status: res.status, body };
}

async function refresh() {
  if (!CODE) return;
  const { status, body } = await call(`api/state?code=${encodeURIComponent(CODE)}`);
  if (status !== 200) {
    if (status === 404) { localStorage.removeItem('pig.code'); CODE = ''; showJoin('站码失效了，重新进一次'); }
    return;
  }
  S = body;
  ME = body.me;
  render();
}

/* ---------------- 天空 ---------------- */
const cv = $('sky');
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = Math.min(devicePixelRatio || 1, 2);

function resize() {
  W = innerWidth; H = innerHeight;
  cv.width = Math.round(W * DPR);
  cv.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawSky();
}

function phaseOf(h) {
  if (h < 4.5) return 'night';
  if (h < 7.5) return 'dawn';
  if (h < 17) return 'day';
  if (h < 20) return 'dusk';
  return 'night';
}
function lightOf(h) {
  if (h >= 4.5 && h <= 7.5) return 0.06 + ((h - 4.5) / 3) * 0.94;
  if (h > 7.5 && h < 17) return 1;
  if (h >= 17 && h <= 20) return 1 - ((h - 17) / 3) * 0.94;
  return 0.06;
}

const SKY = {
  night: [[7, 9, 15], [11, 15, 25], [19, 25, 37]],
  dawn: [[24, 22, 34], [82, 60, 60], [164, 110, 76]],
  day: [[82, 86, 84], [138, 136, 124], [198, 190, 170]],
  dusk: [[28, 24, 34], [92, 58, 54], [176, 104, 62]],
};

let FORCE_H = null;
function drawSky() {
  const now = new Date();
  const h = FORCE_H != null ? FORCE_H : now.getHours() + now.getMinutes() / 60;
  const phase = phaseOf(h);
  const light = lightOf(h);
  const cols = SKY[phase];
  const k = 0.55 + light * 0.45;
  const gy = H * 0.58;

  const g = ctx.createLinearGradient(0, 0, 0, gy);
  g.addColorStop(0, `rgb(${cols[0].map((c) => Math.round(c * k)).join(',')})`);
  g.addColorStop(0.55, `rgb(${cols[1].map((c) => Math.round(c * k)).join(',')})`);
  g.addColorStop(1, `rgb(${cols[2].map((c) => Math.round(c * k)).join(',')})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, gy);

  // 星
  if (light < 0.5) {
    const a = (1 - light * 2) * 0.7;
    ctx.save();
    for (let i = 0; i < 70; i++) {
      const x = ((i * 97.31) % 1) * W;
      const y = ((i * 41.77) % 1) * gy * 0.85;
      const s = ((i * 13.7) % 1) * 1.2 + 0.3;
      ctx.fillStyle = `rgba(207,214,220,${a * (0.3 + ((i * 7.3) % 1) * 0.7)})`;
      ctx.fillRect(x, y, s, s);
    }
    ctx.restore();
  }

  // 日月
  const t = clamp((h - 4.5) / 15, 0, 1);
  const isDay = h >= 4.5 && h <= 20;
  if (isDay && light > 0.12) {
    const x = W * (0.08 + 0.84 * t);
    const y = gy - Math.sin(Math.PI * t) * H * 0.42;
    const r = Math.min(W, H) * 0.016;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const sg = ctx.createRadialGradient(x, y, 0, x, y, r * 14);
    sg.addColorStop(0, `rgba(255,224,176,${0.30 * light})`);
    sg.addColorStop(0.22, `rgba(255,206,150,${0.13 * light})`);
    sg.addColorStop(1, 'rgba(255,190,130,0)');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(x, y, r * 14, 0, 6.2832); ctx.fill();
    const dg = ctx.createRadialGradient(x, y, 0, x, y, r * 1.6);
    dg.addColorStop(0, `rgba(255,250,238,${0.42 + light * 0.2})`);
    dg.addColorStop(0.75, `rgba(255,240,214,${0.2 + light * 0.1})`);
    dg.addColorStop(1, 'rgba(255,236,200,0)');
    ctx.fillStyle = dg;
    ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, 6.2832); ctx.fill();
    ctx.restore();
  } else {
    const mt = ((h + 12) % 24) / 24;
    const x = W * (0.12 + 0.76 * mt);
    const y = gy - Math.sin(Math.PI * mt) * H * 0.36;
    if (y < gy - 8) {
      const r = Math.min(W, H) * 0.02;
      ctx.fillStyle = 'rgba(226,238,248,.6)';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
      ctx.fillStyle = `rgba(${cols[0].join(',')},.85)`;
      ctx.beginPath(); ctx.arc(x - r * 0.42, y - r * 0.28, r * 0.86, 0, 6.2832); ctx.fill();
    }
  }

  // 山
  const layers = [
    { y: gy - 120, amp: 26, col: `rgba(26,34,42,${0.72})`, f: 0.0018, ph: 0.7, rim: 0.09 },
    { y: gy - 74, amp: 20, col: `rgba(16,21,27,${0.92})`, f: 0.0028, ph: 2.1, rim: 0.06 },
    { y: gy - 30, amp: 13, col: 'rgba(9,12,16,1)', f: 0.0044, ph: 4.3, rim: 0.03 },
  ];
  for (const L of layers) {
    const pts = [];
    for (let x = -20; x <= W + 20; x += 10) {
      pts.push([x, L.y + Math.sin(x * L.f + L.ph) * L.amp
        + Math.sin(x * L.f * 2.7 + L.ph * 3) * L.amp * 0.32
        + Math.sin(x * L.f * 0.4 + 1.7) * L.amp * 0.5]);
    }
    ctx.fillStyle = L.col;
    ctx.beginPath();
    ctx.moveTo(-20, H); ctx.lineTo(-20, pts[0][1]);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(W + 20, H); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(178,206,214,${L.rim * (0.4 + light * 0.6)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.stroke();
  }

  // 地面
  const gg = ctx.createLinearGradient(0, gy - 10, 0, H);
  gg.addColorStop(0, `rgb(${Math.round(14 + light * 8)},${Math.round(18 + light * 8)},${Math.round(24 + light * 6)})`);
  gg.addColorStop(0.45, 'rgba(9,12,17,1)');
  gg.addColorStop(1, 'rgba(5,7,10,1)');
  ctx.fillStyle = gg;
  ctx.fillRect(0, gy - 10, W, H - gy + 10);

  // 地面等高线，越近越疏
  ctx.save();
  for (let i = 0; i < 10; i++) {
    const t = i / 10;
    const yy = gy + Math.pow(t, 1.8) * (H - gy);
    const a = (0.045 - t * 0.035) * (0.4 + light * 0.6);
    if (a <= 0.002) continue;
    ctx.strokeStyle = `rgba(160,185,200,${a})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 16) {
      const dy = Math.sin(x * 0.006 + i * 1.7) * (2 + t * 9) + Math.sin(x * 0.0013 + i) * (3 + t * 12);
      if (x === 0) ctx.moveTo(x, yy + dy); else ctx.lineTo(x, yy + dy);
    }
    ctx.stroke();
  }
  ctx.restore();

  // 暗角
  const vg = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.28, W / 2, H * 0.5, Math.max(W, H) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,.5)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // 地平线雾
  const hz = ctx.createLinearGradient(0, gy - 90, 0, gy + 8);
  hz.addColorStop(0, 'rgba(150,175,190,0)');
  hz.addColorStop(0.7, `rgba(150,175,190,${0.04 + light * 0.05})`);
  hz.addColorStop(1, 'rgba(150,175,190,0)');
  ctx.fillStyle = hz;
  ctx.fillRect(0, gy - 90, W, 100);
}

/* ---------------- 渲染 ---------------- */
function render() {
  if (!S) return;
  const now = new Date();
  $('h-clock').textContent =
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · ${weatherLine()}`;

  const me = S.members.find((m) => m.uid === UID);
  $('h-streak').textContent = (me && me.streak) || 0;

  // 朋友条
  const fr = $('friends');
  fr.innerHTML = S.members.map((m) => {
    const p = m.presence || {};
    const isMe = m.uid === UID;
    let cls = 'fr';
    let right = '';
    if (p.state === 'focusing' && p.endsAt > Date.now()) {
      cls += ' focus';
      right = `<b data-ends="${p.endsAt}">--:--</b>`;
    } else if (!m.cameToday) {
      right = '<span style="opacity:.45">今天还没来</span>';
    } else if (isMe) {
      cls += ' me';
      right = '<span style="opacity:.45">我</span>';
    }
    return `<div class="${cls}"><i></i>${esc(m.name)}${right}</div>`;
  }).join('');

  // 猪
  const mine = Object.entries((ME && ME.cards) || {})
    .map(([id, c]) => ({ id: +id, ...c }))
    .sort((a, b) => (b.ex - a.ex) || (b.lastAt - a.lastAt))
    .slice(0, 6);

  const sig = mine.map((c) => c.id + ':' + c.ex).join('|');
  if (sig !== pigsSig) {
    pigsSig = sig;
    $('pigs').innerHTML = mine.map((c, i) => {
      const name = c.title || ('#' + c.id);
      const tx = pigOffsets.get(c.id) || 0;
      const dur = (3.2 + (i % 3) * 0.55).toFixed(1);
      const delay = (i * 0.43).toFixed(2);
      return `<div class="pig" data-id="${c.id}"
        style="--bob:${dur}s;--bd:${delay}s;--tx:${tx}px;--r1:${(i % 2 ? 1.4 : -1.4)}deg;--r2:${(i % 2 ? -1.4 : 1.4)}deg">
        <div class="ph"><img src="${api('img/' + c.id + '.jpg')}" alt="" loading="lazy">
        ${c.ex > 0 ? `<span class="ex">EX${c.ex}</span>` : ''}
        <span class="zz">z</span></div>
        <div class="nm">${esc(name)}</div>
      </div>`;
    }).join('');
    applySleep();
  }
  $('empty-hint').classList.toggle('hidden', mine.length > 0);

  // 底部
  const drawnToday = me && me.cameToday;
  const tickets = (ME && ME.tickets) || 0;
  const bd = $('b-draw');
  bd.classList.toggle('done', drawnToday && tickets <= 0);
  $('d-sub').textContent = drawnToday ? (tickets > 0 ? `${tickets} 张券` : '明天再来') : '今天免费';
  $('k-sub').textContent = `${S.collected}/${S.total}`;
  $('b-book').querySelector('i').textContent = `${S.collected}/${S.total}`;

  updateFocusUI();
}

function weatherLine() {
  const h = new Date().getHours();
  const p = phaseOf(h);
  return { night: '夜', dawn: '黎明', day: '白天', dusk: '黄昏' }[p];
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 让猪活着 ---------------- */
let pigsSig = '';
const pigOffsets = new Map();
let wanderTimer = null;

function applySleep() {
  const h = new Date().getHours();
  const night = h >= 22 || h < 6;
  document.querySelectorAll('.pig').forEach((el) => el.classList.toggle('sleep', night));
}

function startWander() {
  clearInterval(wanderTimer);
  wanderTimer = setInterval(() => {
    if (document.hidden) return;
    const els = [...document.querySelectorAll('.pig')];
    if (!els.length) return;
    const f = focusState();
    const calm = f && f.endsAt > Date.now();
    // 你在专注的时候，它们安静下来陪着你
    if (calm && Math.random() < 0.75) return;
    const el = els[Math.floor(Math.random() * els.length)];
    const id = +el.dataset.id;
    const cur = pigOffsets.get(id) || 0;
    let next = cur + (Math.random() * 46 - 23);
    next = Math.max(-27, Math.min(27, next));
    if (Math.abs(next - cur) < 7) return;
    pigOffsets.set(id, next);
    el.style.setProperty('--tx', next.toFixed(1) + 'px');
  }, 3200);
}

function hop(el) {
  el.classList.remove('hop');
  void el.offsetWidth;          // 强制重排，让动画能重复触发
  el.classList.add('hop');
  setTimeout(() => el.classList.remove('hop'), 620);

  const h = document.createElement('span');
  h.className = 'heart';
  h.textContent = '♥';
  el.appendChild(h);
  setTimeout(() => h.remove(), 1000);
}

/* ---------------- 专注计时 ---------------- */
function focusState() {
  try { return JSON.parse(localStorage.getItem('pig.focus') || 'null'); }
  catch { return null; }
}
function saveFocus(f) {
  if (f) localStorage.setItem('pig.focus', JSON.stringify(f));
  else localStorage.removeItem('pig.focus');
}

function updateFocusUI() {
  const f = focusState();
  const btn = $('b-focus');
  const sub = $('f-sub');
  if (f && f.endsAt > Date.now()) {
    const left = Math.max(0, f.endsAt - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    const txt = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    btn.classList.add('live');
    btn.firstChild.textContent = txt;
    sub.textContent = '进行中';
    $('f-time').textContent = txt;
    $('focus').classList.toggle('hidden', !focusOpen);
  } else {
    btn.classList.remove('live');
    btn.firstChild.textContent = '专注';
    sub.textContent = '+1 券';
    $('focus').classList.add('hidden');
    if (f) settleFocus();   // 到点了但还没结算
  }

  // 朋友条上的倒计时
  document.querySelectorAll('[data-ends]').forEach((el) => {
    const left = Math.max(0, (+el.dataset.ends) - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  });
}

async function startFocus(minutes) {
  const { status, body } = await call('api/focus/start', {
    method: 'POST', body: JSON.stringify({ minutes }),
  });
  if (status !== 200) { toast('开始失败'); return; }
  saveFocus({ id: body.focus.id, start: body.focus.start, endsAt: body.focus.endsAt, minutes });
  scheduleNotify(body.focus.endsAt, minutes);
  focusOpen = true;
  updateFocusUI();
  toast(`${minutes} 分钟，开始`);
}

let settling = false;
async function settleFocus() {
  if (settling) return;
  const f = focusState();
  if (!f) return;
  settling = true;
  try {
    const { body } = await call('api/focus/end', { method: 'POST', body: JSON.stringify({}) });
    saveFocus(null);
    cancelNotify();
    focusOpen = true;
    if (body.settled) {
      toast(`完成 · 券 +${body.granted}${body.capped ? '（已满 5 张）' : ''}`);
      refresh();
    } else {
      toast('这次没有结算');
    }
  } catch { /* 网络失败就留着，下次再试 */ }
  settling = false;
}

/* 本地通知：让系统在到点时叫醒你，不依赖 JS */
async function scheduleNotify(endsAt, minutes) {
  const C = window.Capacitor;
  const LN = C && C.Plugins && C.Plugins.LocalNotifications;
  if (!LN) return;
  try {
    let perm = await LN.checkPermissions();
    if (perm.display !== 'granted') perm = await LN.requestPermissions();
    if (perm.display !== 'granted') return;
    await LN.cancel({ notifications: [{ id: 1001 }] }).catch(() => {});
    await LN.schedule({
      notifications: [{
        id: 1001,
        title: '专注结束',
        body: `${minutes} 分钟到了，回去看看你的猪。`,
        scheduleAt: new Date(endsAt),
      }],
    });
  } catch (e) { console.warn('通知失败', e); }
}
async function cancelNotify() {
  const C = window.Capacitor;
  const LN = C && C.Plugins && C.Plugins.LocalNotifications;
  if (!LN) return;
  try { await LN.cancel({ notifications: [{ id: 1001 }] }); } catch { /* ignore */ }
}

/* ---------------- 抽卡 ---------------- */
let drawing = false;
async function doDraw() {
  if (drawing) return;
  drawing = true;
  const ov = $('draw');
  const card = $('card');
  card.classList.remove('flip', 'rare', 'legend');
  $('c-img').removeAttribute('src');
  $('d-hint').textContent = '抽…';
  ov.classList.remove('hidden');

  const { status, body } = await call('api/draw', { method: 'POST', body: '{}' });
  if (status !== 200) {
    ov.classList.add('hidden');
    drawing = false;
    toast(body.message || '抽不了');
    if (status === 402) refresh();
    return;
  }

  const c = body.card;
  $('c-img').src = api(`img/${c.id}.jpg`);
  $('c-name').textContent = c.title;
  const rn = { common: '常见', rare: '稀有', legend: '传说' }[c.rarity];
  $('c-tag').textContent = body.isNew ? `${rn} · 新的` : `${rn} · 第 ${c.count} 次`;
  if (c.rarity !== 'common') card.classList.add(c.rarity);

  setTimeout(() => {
    card.classList.add('flip');
    $('d-hint').textContent = body.free ? '今天免费的一抽' : '用掉 1 张券';
    if (c.rarity === 'legend' && navigator.vibrate) navigator.vibrate([30, 60, 120]);
    else if (c.rarity === 'rare' && navigator.vibrate) navigator.vibrate(30);
  }, 420);

  S = body.state;
  ME = S.me;
  render();
  drawing = false;
}

/* ---------------- 图鉴 ---------------- */
let bookLimit = 60;
function openBook() {
  bookLimit = 60;
  renderBook();
  $('book').classList.remove('hidden');
}
function renderBook() {
  const cards = (ME && ME.cards) || {};
  const unlocked = Object.keys(cards).map(Number)
    .sort((a, b) => (cards[b].ex - cards[a].ex) || (cards[b].lastAt - cards[a].lastAt));
  const have = unlocked.length;
  $('k-have').textContent = have;
  $('k-total').textContent = '/' + S.total;

  const cells = unlocked.slice(0, bookLimit).map((id) => `
    <div class="bk" data-id="${id}"><img src="${api('img/' + id + '.jpg')}" loading="lazy" alt="">
    ${cards[id].ex > 0 ? `<span class="bex">EX${cards[id].ex}</span>` : ''}</div>`).join('');

  const lockCount = Math.max(0, bookLimit - have);
  const locks = Array.from({ length: lockCount }, () => '<div class="bk lock">·</div>').join('');

  $('book-grid').innerHTML = cells + locks;
  $('k-more').style.display = bookLimit >= S.total ? 'none' : '';
}

/* ---------------- 界面切换 ---------------- */
function showJoin(err) {
  $('main').classList.add('hidden');
  $('join').classList.remove('hidden');
  if (err) $('j-err').textContent = err;
}

function showMain() {
  $('join').classList.add('hidden');
  $('main').classList.remove('hidden');
  render();
}

/* ---------------- 事件 ---------------- */
$('j-go').addEventListener('click', async () => {
  const name = $('j-name').value.trim();
  const code = $('j-code').value.trim().toUpperCase();
  if (!name) { $('j-err').textContent = '先填个名字'; return; }
  $('j-err').textContent = '';
  const { status, body } = await call('api/join', {
    method: 'POST', body: JSON.stringify({ name, code }),
  });
  if (status !== 200) { $('j-err').textContent = body.message || '进不去'; return; }
  CODE = body.code; localStorage.setItem('pig.code', CODE);
  UID = body.uid; localStorage.setItem('pig.uid', UID);
  S = body.state; ME = S.me;
  showMain();
  connect();
  heartbeat();
});

$('b-draw').addEventListener('click', doDraw);

$('b-focus').addEventListener('click', () => {
  const f = focusState();
  if (f && f.endsAt > Date.now()) { focusOpen = true; $('focus').classList.remove('hidden'); return; }
  openFocusPicker();
});

function openFocusPicker() {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="focus-box">
    <div class="f-label">专注多久</div>
    <div class="f-actions" style="margin-top:30px">
      <button class="ghost" data-m="25">25 分钟<br><span style="font-size:8px;opacity:.6">+1 券</span></button>
      <button class="ghost" data-m="45">45 分钟<br><span style="font-size:8px;opacity:.6">+2 券</span></button>
    </div>
    <div style="margin-top:26px"><button class="ghost" data-x>算了</button></div>
  </div>`;
  ov.addEventListener('click', (e) => {
    const m = e.target.closest('[data-m]');
    if (m) { ov.remove(); startFocus(+m.dataset.m); return; }
    if (e.target.closest('[data-x]') || e.target === ov) ov.remove();
  });
  document.body.appendChild(ov);
}

$('f-min').addEventListener('click', () => {
  focusOpen = false;
  $('focus').classList.add('hidden');
});
let stopArmed = false;
let stopTimer = null;
$('f-stop').addEventListener('click', async () => {
  const btn = $('f-stop');

  // 不用原生 confirm：某些 WebView 会静默吞掉，点了像没反应
  if (!stopArmed) {
    stopArmed = true;
    btn.textContent = '再点一次';
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => { stopArmed = false; btn.textContent = '放弃'; }, 2600);
    return;
  }
  stopArmed = false;
  clearTimeout(stopTimer);
  btn.textContent = '放弃';

  // 先本地收尾，网络失败也不至于卡在界面里
  saveFocus(null);
  cancelNotify();
  focusOpen = false;
  $('focus').classList.add('hidden');
  updateFocusUI();
  toast('已放弃');

  try {
    await call('api/focus/end', { method: 'POST', body: JSON.stringify({ abandon: true }) });
  } catch (e) { console.warn('放弃上报失败', e); }
  refresh();
});

$('b-book').addEventListener('click', openBook);
$('k-more').addEventListener('click', () => { bookLimit += 60; renderBook(); });

$('b-station').addEventListener('click', () => {
  $('s-code').textContent = S.code;
  $('s-members').innerHTML = S.members.map((m) => {
    const p = m.presence || {};
    const cls = p.state === 'focusing' ? 'sm focus' : (m.cameToday ? 'sm on' : 'sm');
    return `<div class="${cls}"><i></i><b>${esc(m.name)}</b><em>${m.count} 只</em></div>`;
  }).join('');
  $('station').classList.remove('hidden');
});

$('s-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(S.code); toast('站码已复制'); }
  catch { toast(S.code); }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) {
    e.target.closest('.overlay')?.classList.add('hidden');
  }
  const ms = e.target.closest('#mascot');
  if (ms) { hop(ms); return; }

  const pig = e.target.closest('.pig');
  if (pig) {
    hop(pig);
    const id = +pig.dataset.id;
    setTimeout(() => openViewer(id), 430);
  }
  const bk = e.target.closest('.bk:not(.lock)');
  if (bk) openViewer(+bk.dataset.id);
});

function openViewer(id) {
  const c = (ME.cards || {})[id];
  if (!c) return;
  $('v-img').src = api(`img/${id}.jpg`);
  $('v-name').textContent = c.title || ('#' + id);
  $('v-sub').textContent = `抽到 ${c.count} 次 · EX ${c.ex}`;
  $('viewer').classList.remove('hidden');
}

$('draw').addEventListener('click', () => {
  if (!$('card').classList.contains('flip')) return;
  $('draw').classList.add('hidden');
  refresh();
});

/* ---------------- 实时 ---------------- */
function connect() {
  if (es) { try { es.close(); } catch {} }
  if (!CODE) return;
  es = new EventSource(api(`api/stream?code=${encodeURIComponent(CODE)}`));
  es.addEventListener('message', (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'feed') pushFeed(m.text);
      if (m.type === 'presence') refresh();
    } catch {}
  });
  es.onerror = () => { /* 浏览器会自动重连 */ };
}

function pushFeed(text) {
  const el = document.createElement('div');
  el.className = 'fd';
  el.textContent = text;
  $('feed').appendChild(el);
  setTimeout(() => el.remove(), 5000);
  while ($('feed').children.length > 3) $('feed').firstChild.remove();
}

let hbTimer = null;
function heartbeat() {
  clearInterval(hbTimer);
  hbTimer = setInterval(() => {
    if (document.hidden || !CODE) return;
    const f = focusState();
    call('api/presence', {
      method: 'POST',
      body: JSON.stringify({ state: f && f.endsAt > Date.now() ? 'focusing' : 'idle' }),
    }).catch(() => {});
  }, 30000);
}

/* 回到前台：补算专注 + 刷新 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const f = focusState();
  if (f && Date.now() >= f.endsAt) settleFocus();
  else updateFocusUI();
  refresh();
  if (!es || es.readyState === 2) connect();
});

/* ---------------- 启动 ---------------- */
function setupNative() {
  const C = window.Capacitor;
  if (!C || !C.Plugins) return;
  const App = C.Plugins.App;
  if (App && App.addListener) {
    App.addListener('backButton', () => {
      const open = [...document.querySelectorAll('.overlay:not(.hidden)')].pop();
      if (open) { open.classList.add('hidden'); return; }
      if (App.exitApp) App.exitApp();
    });
    App.addListener('resume', () => {
      const f = focusState();
      if (f && Date.now() >= f.endsAt) settleFocus();
      else updateFocusUI();
      refresh();
      if (!es || es.readyState === 2) connect();
    });
  }
  const SB = C.Plugins.StatusBar;
  if (SB) {
    try { SB.setStyle({ style: 'DARK' }); SB.setBackgroundColor({ color: '#05070a' }); } catch (_) {}
  }
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('on'), 2200);
}

async function boot() {
  if (NATIVE) setupNative();
  resize();
  startWander();
  setInterval(applySleep, 60000);
  addEventListener('resize', resize);
  tickTimer = setInterval(() => {
    updateFocusUI();
    const m = new Date().getMinutes();
    if (m === 0) drawSky();
  }, 1000);
  setInterval(drawSky, 60000);

  // 邀请链接：?c=站码 预填，?n=名字 直接进
  const q = new URLSearchParams(location.search);
  if (q.get('h') != null) { FORCE_H = parseFloat(q.get('h')); drawSky(); }
  const qc = (q.get('c') || '').toUpperCase();
  const qn = q.get('n') || '';
  if (qc) $('j-code').value = qc;
  if (qn) $('j-name').value = qn;
  if (qc && qn && !CODE) {
    history.replaceState(null, '', location.pathname);
    $('j-go').click();
    return;
  }
  if (qc) history.replaceState(null, '', location.pathname + '?c=' + qc);

  if (!CODE) { showJoin(); return; }

  const { status, body } = await call(`api/state?code=${encodeURIComponent(CODE)}`);
  if (status !== 200) { showJoin('站码失效了，重新进一次'); return; }
  S = body; ME = body.me;
  showMain();
  connect();
  heartbeat();
  if (q.get('open') === 'book') openBook();

  const f = focusState();
  if (f && Date.now() >= f.endsAt) settleFocus();
}

boot();
