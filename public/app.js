'use strict';

/* ---------------- 环境 ---------------- */
const NATIVE = false; /* 打包时由 sync-web 替换成 true */
const BASE = NATIVE ? 'https://150.158.1.111/pig/' : '';
const api = (p) => BASE + p;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const imgOf = (id) => api('img/' + id + '.jpg');

const MODES = [[25, 5], [45, 15]];                       // 专注 / 休息
const RARITY = { common: '常见', rare: '稀有', legend: '传说' };
const KEY_F = 'pig.focus', KEY_B = 'pig.brk';

let UID = localStorage.getItem('pig.uid') || '';
let CODE = localStorage.getItem('pig.code') || '';
let ME = null, S = null;
let es = null, pit = null;
let planting = null;
let focusOpen = true;
let soundOn = localStorage.getItem('pig.sound') !== '0';
let forcedWeather = '';        // ?w=rain 调试/预览用

/* 服务器时钟偏移：endsAt 是服务器时间，必须换成「我这边的时间」再比较，
   否则两边时钟差几分钟就会出现「刚点开始就说结束」。 */
let SRV_SKEW = 0;
const nowMs = () => Date.now() + SRV_SKEW;

/* 连续专注（自动番茄钟）：默认关，可在「我」里打开 */
let autoCycle = localStorage.getItem('pig.autocycle') !== '0';
let lastMinutes = parseInt(localStorage.getItem('pig.lastmin') || '25', 10) || 25;
let roundsWanted = clampInt(parseInt(localStorage.getItem('pig.rounds') || '2', 10), 1, 6) || 2;
let cycle = (() => { try { return JSON.parse(localStorage.getItem('pig.cycle') || 'null'); } catch { return null; } })();
function clampInt(v, a, b) { return Math.min(b, Math.max(a, Number.isFinite(v) ? v : a)); }
function saveCycle() { write('pig.cycle', cycle); }
let focusGen = 0;        // 每开始一次专注 +1，用来丢弃迟到的旧结算
let focusingNow = false; // 专注时猪会安静一点，陪在旁边

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const write = (k, v) => { if (v) localStorage.setItem(k, JSON.stringify(v)); else localStorage.removeItem(k); };

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/* ---------------- 网络 ---------------- */
async function call(p, body, method = 'POST') {
  let res;
  try {
    res = await fetch(api(p), {
      method,
      headers: { 'Content-Type': 'application/json', ...(UID ? { 'X-Pig-Uid': UID } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  } catch {
    return { status: 0, body: { error: 'network', message: '连不上服务器，看看网络' } };
  }
  let data;
  try { data = await res.json(); } catch { data = { error: 'bad', message: '服务器没正常回话' }; }
  const sn = data && (data.now || (data.me && data.me.now));
  if (sn) SRV_SKEW = sn - Date.now();
  if (res.status === 401 && p !== '/api/login' && p !== '/api/me') logout();
  return { status: res.status, body: data };
}

function adopt(me) { if (me) ME = me; }

async function refresh() {
  if (!UID) return;
  const r = await call('/api/state', null, 'GET');
  if (r.status !== 200) { if (r.status === 401 || r.status === 404) logout(); return; }
  S = r.body; ME = S.me;
  render();
}

function logout() {
  UID = ''; CODE = ''; ME = null; S = null;
  localStorage.removeItem('pig.uid'); localStorage.removeItem('pig.code');
  if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
  $('main').classList.add('hidden');
  $('login').classList.remove('hidden');
}

/* ---------------- 声音 ---------------- */
/* 现场合成一声「哼」：锯齿波下滑 + 低通 + 轻微颤音。
   不依赖任何音频文件，因此没有版权问题，也不会因为缺 oink.ogg 而静音。 */
let actx = null;
function audioCtx() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { actx = new AC(); } catch { return null; }
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}

function playOink(rate = 1) {
  if (!soundOn || !(ME && ME.flags.sound !== false)) return;
  const ctx = audioCtx();
  if (!ctx) return;
  try {
    const r = Math.min(1.9, Math.max(0.55, rate));
    const dur = 0.26 / r;
    const t = ctx.currentTime;
    const base = 150 + 90 * r;

    const osc = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();

    lp.type = 'lowpass';
    lp.frequency.value = 900 + 400 * r;
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base * 1.35, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.7, t + dur);

    lfo.frequency.value = 24 + 8 * r;
    lfoGain.gain.value = 22;
    lfo.connect(lfoGain).connect(osc.frequency);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(t); lfo.start(t);
    osc.stop(t + dur + 0.03); lfo.stop(t + dur + 0.03);
  } catch { /* 没有音频能力就安静 */ }
}
document.addEventListener('pointerdown', () => { audioCtx(); playOink(1.6); }, { once: true });

/* ---------------- 提示 ---------------- */
function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('on'), ms);
}
function pushFeed(text) {
  const el = document.createElement('div');
  el.className = 'fd';
  el.textContent = text;
  $('feed').appendChild(el);
  setTimeout(() => el.remove(), 5000);
  while ($('feed').children.length > 3) $('feed').firstChild.remove();
}

/* ---------------- 面板 ---------------- */
function openSheet(title, html) {
  $('sheet-title').textContent = title;
  $('sheet-bd').innerHTML = html;
  $('sheet-bd').scrollTop = 0;
  $('sheet-ov').classList.remove('hidden');
  return $('sheet-bd');
}
const closeSheet = () => $('sheet-ov').classList.add('hidden');

/* ---------------- 渲染 ---------------- */
function avatarOf(m) { return m.avatar ? imgOf(m.avatar) : BASE + 'assets/pig.gif'; }

function render() {
  if (!ME || !S) return;
  $('h-streak').textContent = ME.streak || 0;
  $('h-avatar-img').src = avatarOf(ME);

  // 朋友
  $('friends').innerHTML = S.members.map((m) => {
    const p = m.presence || { state: 'off' };
    let cls = 'fr', right = '';
    if (p.state === 'focusing') { cls += ' focus'; right = `<b data-ends="${p.endsAt}">${fmt(p.endsAt - nowMs())}</b>`; }
    else if (p.state === 'breaking') { cls += ' brk'; right = `<b data-ends="${p.endsAt}">${fmt(p.endsAt - nowMs())}</b>`; }
    else if (p.state === 'idle') cls += ' on';
    else { cls += ' off'; right = `<small>${m.cameToday ? '不在线' : '今天还没来'}</small>`; }
    return `<button class="${cls}" data-uid="${m.uid}" data-name="${esc(m.name)}"><img src="${avatarOf(m)}" alt="">${esc(m.name)}${right}</button>`;
  }).join('');

  // 植物：自己的 + 站里别人的
  const others = (S.gardens || []).filter((g) => g.uid !== ME.uid).flatMap((g) => g.plants);
  Scene.setPlants(ME.plants || [], others);

  // 种子
  const seeds = (ME.seeds || []).length;
  $('seed-btn').classList.toggle('hidden', seeds === 0);
  $('seed-n').textContent = seeds;

  // 底部
  $('d-sub').textContent = ME.cameToday ? (ME.tickets > 0 ? `${ME.tickets} 张券` : '明天再来') : '今天免费';
  $('b-draw').classList.toggle('done', ME.cameToday && ME.tickets <= 0);
  const openTodos = (ME.todos || []).filter((t) => !t.done).length;
  $('t-sub').textContent = `${openTodos} 条`;
  $('k-sub').textContent = `${Object.keys(ME.cards || {}).length} / ${S.total}`;

  timers();
}

/* 朋友条上的倒计时 */
function tickCountdowns() {
  document.querySelectorAll('#friends [data-ends]').forEach((el) => { el.textContent = fmt(+el.dataset.ends - nowMs()); });
}

/* ---------------- 专注 / 休息 ---------------- */
let settling = false;

async function startFocus(minutes, fresh = false) {
  const brk = (MODES.find(([f]) => f === minutes) || [minutes, 5])[1];
  lastMinutes = minutes;
  localStorage.setItem('pig.lastmin', String(minutes));
  if (fresh || !cycle) { cycle = { total: roundsWanted, done: 0, minutes }; saveCycle(); }
  const r = await call('/api/focus/start', { minutes });
  // 服务器已经有进行中的专注（换设备 / 清了缓存）：把它接过来，而不是干瞪眼
  if (r.status === 409) {
    const m = await call('/api/me', null, 'GET');
    const live = m.status === 200 && m.body.focus;
    if (live && live.endsAt > nowMs()) {
      ME = m.body;
      const pair = MODES.find(([x]) => x === live.minutes) || [live.minutes, 5];
      focusGen++;
      write(KEY_F, { id: live.id, start: live.start, endsAt: live.endsAt, minutes: live.minutes, break: pair[1] });
      focusOpen = true;
      $('focus').classList.remove('hidden');
      $('f-note').textContent = '这边也接上了，一起专注。';
      updateTomato();
      scheduleNotify(1001, live.endsAt, '专注结束', `${live.minutes} 分钟到了，回去看看你的猪。`);
      timers();
      toast('你已经在专注了，帮你接上', 2200);
      return;
    }
  }
  if (r.status !== 200) { toast(r.body.message || '开始失败'); return; }
  const f = r.body.focus;
  // 服务器没有真的给出一个「未来的结束时间」→ 不要当成已结束，先把状态拉回来
  if (!f || !(f.endsAt > nowMs() + 3000)) {
    const m = await call('/api/me', null, 'GET');
    if (m.status === 200) { ME = m.body; render(); }
    toast('时间没对上，刷新后再试一次', 2600);
    return;
  }
  focusGen++;
  write(KEY_F, { id: f.id, start: f.start, endsAt: f.endsAt, minutes, break: brk });
  if (r.body.resumed) toast('接着刚才那次继续');
  focusOpen = true;
  $('focus').classList.remove('hidden');
  $('f-note').textContent = '放下手机。猪在替你看着。';
  updateTomato();
  scheduleNotify(1001, f.endsAt, '专注结束', `${minutes} 分钟到了，回去看看你的猪。`);
  timers();
}

function updateTomato() {
  const el = $('f-tomato');
  if (!el) return;
  const done = (ME && ME.todayFocus && ME.todayFocus.count) || 0;
  const total = cycle ? cycle.total : 1;
  const idx = Math.min(total, (cycle ? cycle.done : 0) + 1);
  el.textContent = `第 ${idx} / ${total} 轮 · 今日第 ${done + 1} 个 · ${lastMinutes} 分钟`;
}

let lastSettleTry = 0;
async function settleFocus(force = false) {
  if (settling) return;
  const f = read(KEY_F);
  if (!f) return;
  if (!force && nowMs() < f.endsAt) return;            // 没到点绝不结算
  if (!force && Date.now() - lastSettleTry < 5000) return;
  lastSettleTry = Date.now();
  const gen = focusGen;
  settling = true;
  try {
    const r = await call('/api/focus/end', {});
    if (r.status !== 200) return;                 // 网络没通：留着，下次再结算
    if (gen !== focusGen) return;                 // 期间已经开始了新的一次，丢掉这次旧结算
    write(KEY_F, null);
    cancelNotify(1001);
    focusOpen = false;
    $('focus').classList.add('hidden');
    if (r.body.settled) {
      if (cycle) { cycle.done = Math.min(cycle.total, cycle.done + 1); saveCycle(); }
      adopt(r.body.me);
      const seed = r.body.seed;
      toast(`专注完成！券 +${r.body.granted}${seed ? `，得到一颗${seed.name}种子` : ''}`, 4200);
      playOink(1.3);
      pushFeed(`完成了一次 ${f.minutes} 分钟`);
      await startBreak(f.break || 5);
      await refresh();
    } else if (r.body.status === 'aborted') {
      cycle = null; saveCycle();
      adopt(r.body.me);
    }
  } finally {
    settling = false;
    timers();
  }
}

async function startBreak(minutes) {
  const r = await call('/api/break/start', { minutes });
  const endsAt = r.status === 200 && r.body.brk ? r.body.brk.endsAt : nowMs() + minutes * 60 * 1000;
  write(KEY_B, { endsAt, minutes });
  scheduleNotify(1002, endsAt, '休息结束', '起来动一动，回来接着专注。');
  toast(`休息 ${minutes} 分钟`, 2000);
}

async function endBreak(auto = false) {
  const b = read(KEY_B);
  if (!b) return;
  write(KEY_B, null);
  cancelNotify(1002);
  await call('/api/break/end', {});
  timers();
  if (auto && autoCycle && cycle && cycle.done < cycle.total) {
    toast(`休息结束，开始第 ${cycle.done + 1} / ${cycle.total} 轮`);
    startFocus(cycle.minutes);
  } else if (auto && cycle && cycle.done >= cycle.total) {
    cycle = null; saveCycle();
    toast('这一组番茄完成了，歇会儿吧', 2800);
  } else {
    toast('休息结束，继续吧');
  }
}

/* 每 500ms 看一眼本地的时间戳。不数秒，只算「到没到」。 */
function timers() {
  if (!UID) return;
  const now = nowMs();
  const f = read(KEY_F);
  const b = read(KEY_B);
  const btn = $('b-focus'), t = $('b-focus-t'), sub = $('f-sub');

  if (f && now < f.endsAt) {
    focusingNow = true;
    btn.className = 'dk focus live';
    t.textContent = fmt(f.endsAt - now);
    sub.textContent = '专注中 · 点开';
    $('f-time').textContent = fmt(f.endsAt - now);
    $('focus').classList.toggle('hidden', !focusOpen);
    updateTomato();
  } else if (f) {
    focusingNow = false;
    settleFocus();
  } else if (b && now < b.endsAt) {
    focusingNow = false;
    btn.className = 'dk focus brk';
    t.textContent = fmt(b.endsAt - now);
    sub.textContent = '休息中 · 点开';
    $('focus').classList.add('hidden');
  } else if (b) {
    endBreak(true);
  } else {
    focusingNow = false;
    btn.className = 'dk focus';
    t.textContent = '专注';
    sub.textContent = '25 / 45 分钟';
    $('focus').classList.add('hidden');
  }
  tickCountdowns();
}

function openFocusPicker() {
  const f = read(KEY_F), b = read(KEY_B);
  if (f && f.endsAt > nowMs()) { focusOpen = true; $('focus').classList.remove('hidden'); return; }

  let top = '';
  if (b && b.endsAt > nowMs()) {
    top = `<p class="note">正在休息，还剩 ${fmt(b.endsAt - nowMs())}。休息结束会提醒你。</p>
      <div class="row2"><button class="btn" id="skip-break">跳过休息，直接选</button></div>`;
  }
  const bd = openSheet('开始专注', `${top}
    <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin:4px 0 14px">
      <span style="font-size:13px;color:var(--dim)">一组做几轮</span>
      <button class="btn" id="rp-minus" style="min-width:0;width:46px;padding:8px 0">−</button>
      <b id="rp-n" style="font-size:18px;min-width:24px;text-align:center">${roundsWanted}</b>
      <button class="btn" id="rp-plus" style="min-width:0;width:46px;padding:8px 0">+</button>
    </div>
    ${MODES.map(([m, r]) => `
    <div class="row2"><button class="btn primary mode" data-m="${m}" style="height:72px">
      专注 ${m} 分钟<br><small style="font-weight:400;opacity:.85">之后休息 ${r} 分钟 · 券 +${m >= 45 ? 4 : 2}</small></button></div>`).join('')}
    <p class="note">专注结束自动休息，休息结束自动开下一轮，直到完成这一组。中途放弃没有奖励。</p>`);
  const rn = bd.querySelector('#rp-n');
  const setRounds = (v) => {
    roundsWanted = clampInt(v, 1, 6);
    localStorage.setItem('pig.rounds', String(roundsWanted));
    rn.textContent = roundsWanted;
  };
  bd.querySelector('#rp-minus').addEventListener('click', () => setRounds(roundsWanted - 1));
  bd.querySelector('#rp-plus').addEventListener('click', () => setRounds(roundsWanted + 1));
  bd.querySelector('[data-m="25"]').addEventListener('click', () => pick(25));
  bd.querySelector('[data-m="45"]').addEventListener('click', () => pick(45));
  const sk = bd.querySelector('#skip-break');
  if (sk) sk.addEventListener('click', async () => { write(KEY_B, null); cancelNotify(1002); await call('/api/break/end', {}); closeSheet(); openFocusPicker(); });

  async function pick(m) { write(KEY_B, null); cancelNotify(1002); closeSheet(); startFocus(m, true); }
}

/* 系统通知：由系统闹钟到点才响，不依赖页面还活着 */
async function scheduleNotify(id, at, title, body) {
  const C = window.Capacitor;
  const LN = C && C.Plugins && C.Plugins.LocalNotifications;
  if (!LN) return;
  const when = at - SRV_SKEW;                 // 服务器时间 → 本机时间
  if (!(when > Date.now() + 2000)) return;    // 已经过去的时间点不要立刻弹出来
  try {
    let perm = await LN.checkPermissions();
    if (perm.display !== 'granted') perm = await LN.requestPermissions();
    if (perm.display !== 'granted') return;
    await LN.cancel({ notifications: [{ id }] });
    await LN.schedule({ notifications: [{ id, title, body, schedule: { at: new Date(when), allowWhileIdle: true } }] });
  } catch (e) { console.warn('通知失败', e); }
}
async function cancelNotify(id) {
  const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  if (!LN) return;
  try { await LN.cancel({ notifications: [{ id }] }); } catch { /* ignore */ }
}

/* ---------------- 猪 ---------------- */
const pig = $('pig');
const pigS = { x: innerWidth / 2, y: 0, tx: 0, ty: 0, walking: false, until: 0, mode: 'idle', last: 0, dir: 1, ox: 0, oy: 0, vw: 0 };

/* 两张素材的画布和留白差很多：pig.gif 512×512 猪几乎占满，walk.gif 347×304 猪只占中间。
   按「非透明像素的实际包围盒」归一化，换成同样高度、脚底对齐，切换动作就不会跳。 */
const PIG_METRICS = {
  idle: { w: 512, h: 512, cx: 21, cy: 65, cw: 482, ch: 417 },
  walk: { w: 347, h: 304, cx: 26, cy: 72, cw: 307, ch: 219 },
};

function applyPigMode(mode) {
  const m = PIG_METRICS[mode] || PIG_METRICS.idle;
  const target = innerWidth < 420 ? 92 : 104;      // 希望猪身内容的高度
  const s = target / m.ch;
  pig.style.width = (m.w * s) + 'px';
  pig.style.height = (m.h * s) + 'px';
  pigS.ox = -((m.cx + m.cw / 2) - m.w / 2) * s;    // 让内容中心对准坐标
  pigS.oy = (m.h - (m.cy + m.ch)) * s - 3;         // 让脚底贴住地面
  pigS.vw = innerWidth;
}

function setPigMode(mode) {
  if (pigS.mode === mode) return;
  pigS.mode = mode;
  applyPigMode(mode);
  pig.src = BASE + (mode === 'walk' ? 'assets/walk.gif' : 'assets/pig.gif');
}

function pigTick(dt) {
  if (pigS.vw !== innerWidth) applyPigMode(pigS.mode);
  const WW = Scene.worldW();
  const gy = Scene.groundY();
  const range = Math.min(focusingNow ? 92 : 150, (innerHeight - gy) * 0.5);
  const y0 = gy + 70, now = performance.now();
  const half = 66;                                   // 猪身一半宽，别走出猪圈
  const hour = Scene.hour();
  const sleeping = hour >= 23 || hour < 6;
  $('zzz').classList.toggle('hidden', !sleeping || pigS.walking);

  if (!pigS.y) { pigS.y = y0 + range * 0.35; pigS.x = WW / 2; }
  $('zzz').style.left = (pigS.x - Scene.camX() + 26) + 'px';
  $('zzz').style.top = (pigS.y - 108) + 'px';

  if (pigS.walking) {
    const dx = pigS.tx - pigS.x, dy = pigS.ty - pigS.y;
    const dist = Math.hypot(dx, dy);
    const sp = 44 * (sleeping ? 0.45 : 1) * (focusingNow ? 0.6 : 1);
    if (dist < 3) {
      pigS.walking = false; setPigMode('idle');
      pigS.until = now + (focusingNow ? 6000 : 1800) + Math.random() * (sleeping ? 10000 : 4200);
    } else {
      pigS.x = clamp(pigS.x + (dx / dist) * sp * dt, half, WW - half);
      pigS.y += (dy / dist) * sp * dt;
      if (Math.abs(dx) > 1) pigS.dir = dx < 0 ? 1 : -1;    // 素材本身朝左
    }
  } else if (now > pigS.until) {
    // 随机动作：走一走 / 原地蹦一下 / 转个身看看
    const r = Math.random();
    if (r < 0.14) {
      hopPig();
      pigS.until = now + 800 + Math.random() * 900;
    } else if (r < 0.30) {
      pigS.dir = Math.random() < 0.5 ? 1 : -1;
      pigS.until = now + 1400 + Math.random() * 2000;
    } else {
      pigS.tx = half + Math.random() * Math.max(20, WW - half * 2);
      pigS.ty = y0 + Math.random() * range;
      pigS.walking = true; setPigMode('walk');
    }
  }
  pig.style.left = (pigS.x - Scene.camX() + pigS.ox) + 'px';
  pig.style.top = (pigS.y + pigS.oy) + 'px';
  pig.style.scale = pigS.dir > 0 ? '1 1' : '-1 1';
}

let bubbleTimer = null;
function say(text) {
  const b = $('bubble');
  const r = pig.getBoundingClientRect();
  b.textContent = text;
  b.classList.remove('hidden');
  b.style.left = (r.left + r.width / 2) + 'px';
  b.style.top = (r.top - 8) + 'px';
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => b.classList.add('hidden'), 2200);
}

function hopPig() {
  pig.classList.remove('hop');
  void pig.offsetWidth;
  pig.classList.add('hop');
  setTimeout(() => pig.classList.remove('hop'), 620);
}

const LINES = ['哼哼。', '今天也要加油。', '地里又长草了。', '你来了。', '抽到新的了吗？', '我想吃胡萝卜。', '别摸了，该专注了。', '朋友那边还好吗？'];
const NIGHT_LINES = ['呼……', '（睡着了）', 'z z'];
pig.addEventListener('click', (e) => {
  e.stopPropagation();
  hopPig();
  playOink(0.9 + Math.random() * 0.3);
  const hour = Scene.hour();
  say((hour >= 23 || hour < 6) ? NIGHT_LINES[Math.floor(Math.random() * NIGHT_LINES.length)]
    : LINES[Math.floor(Math.random() * LINES.length)]);
});

/* ---------------- 抽卡 ---------------- */
let drawing = false;
async function doDraw() {
  if (drawing) return;
  drawing = true;
  const card = $('card');
  card.classList.remove('flip', 'rare', 'legend');
  $('c-img').removeAttribute('src');
  $('d-hint').textContent = '抽…';
  $('draw').classList.remove('hidden');
  $('draw').dataset.ready = '';

  const r = await call('/api/draw');
  drawing = false;
  if (r.status !== 200) {
    $('draw').classList.add('hidden');
    toast(r.body.message || '抽不了');
    if (r.status === 402) refresh();
    return;
  }
  const c = r.body.card;
  adopt(r.body.me);
  $('c-img').src = imgOf(c.id);
  $('c-name').textContent = c.title;
  $('c-tag').textContent = r.body.isNew ? `${RARITY[c.rarity]} · 新的！` : `${RARITY[c.rarity]} · 第 ${c.count} 次，EX ${c.ex}`;
  if (c.rarity !== 'common') card.classList.add(c.rarity);
  $('d-hint').textContent = r.body.free ? '今天免费的一抽' : '用掉 1 张券';

  setTimeout(() => {
    card.classList.add('flip');
    delete $('draw').dataset.ready;
    playOink(c.rarity === 'legend' ? 1.5 : 1.1);
    if (navigator.vibrate) navigator.vibrate(c.rarity === 'legend' ? [40, 60, 120] : 25);
  }, 450);
  refresh();
}

/* ---------------- 图鉴：小球池 ---------------- */
function openBook() {
  if (!pit) {
    pit = new BallPit($('pit'), imgOf);
    pit.onTap = (b) => openViewer(b.cardId || b.id, b.level);
  }
  const items = Object.entries(ME.cards || {}).map(([id, c]) => ({ id: Number(id), count: c.count, rarity: c.rarity, title: c.title, ex: c.ex }));
  $('pit-n').textContent = items.length;
  $('pit-ov').classList.remove('hidden');
  pit.resize();
  pit.setItems(items);
  pit.reset();                 // 每次打开都从一级开始落
  pit.open();
}

function openViewer(id, level) {
  const c = (ME.cards || {})[id];
  if (!c) return;
  $('v-img').src = imgOf(id);
  $('v-name').textContent = c.title || ('#' + id);
  $('v-sub').textContent = `Lv${level || 1} · 抽到 ${c.count} 次 · EX ${c.ex} · ${RARITY[c.rarity]}`;
  $('viewer').classList.remove('hidden');
}

/* ---------------- 种子 / 植物 ---------------- */
const PLANT_EMOJI = { sunflower: '🌻', tulip: '🌷', carrot: '🥕', daisy: '🌼', strawberry: '🍓', pumpkin: '🎃', mushroom: '🍄', watermelon: '🍉', corn: '🌽' };
const emojiOf = (sp) => PLANT_EMOJI[sp] || '🌱';

function openSeeds() {
  const seeds = ME.seeds || [];
  if (!seeds.length) { toast('没有种子。完成一次专注就会得到一颗。'); return; }
  const groups = {};
  for (const s of seeds) (groups[s.species] ||= []).push(s);
  const rows = Object.values(groups).map((g) => ({ species: g[0].species, name: g[0].name, ids: g.map((x) => x.id) }));
  const bd = openSheet('种点什么', `<p class="note">相同的种子会合并成一栏。选一种，然后点一下地选位置。种下后 2 小时长满，点植物可以浇水施肥。</p>
    <div class="list">${rows.map((r) => `<div class="item"><span style="font-size:22px">${emojiOf(r.species)}</span><b>${r.name}</b><small>×${r.ids.length}</small><button class="mini pink" data-seed="${r.ids[0]}">种下</button></div>`).join('')}</div>
    <div class="sec">地里（${(ME.plants || []).length} / 16）</div>
    ${(ME.plants || []).length ? `<div class="list">${ME.plants.map((p) => `<div class="item" data-plant="${p.id}"><span style="font-size:20px">${emojiOf(p.species)}</span><b>${p.name}</b><small>${Math.round(p.growth * 100)}%</small><button class="del" data-pull="${p.id}" title="拔掉">✕</button></div>`).join('')}</div>` : '<p class="note">还空着。</p>'}`);
  bd.querySelectorAll('[data-seed]').forEach((b) => b.addEventListener('click', () => {
    planting = b.dataset.seed;
    closeSheet();
    $('plant-tip').classList.remove('hidden');
  }));
  bd.querySelectorAll('[data-pull]').forEach((b) => b.addEventListener('click', async () => {
    const r = await call('/api/plant/remove', { id: b.dataset.pull });
    if (r.status === 200) { adopt(r.body.me); refresh(); openSeeds(); toast('拔掉了'); }
  }));
  bd.querySelectorAll('[data-plant]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-pull]')) return;
    const p = (ME.plants || []).find((x) => x.id === el.dataset.plant);
    if (p) openPlant(p);
  }));
}

/* 植物详情：成长进度、水分、施肥 */
function openPlant(p) {
  const pct = Math.round(p.growth * 100);
  const wet = Math.round((p.water == null ? 0.4 : p.water) * 100);
  const bd = openSheet(p.name, `
    <div class="tiles">
      <div class="tile"><b>${pct}%</b><span>成长</span></div>
      <div class="tile"><b>${wet}%</b><span>水分</span></div>
    </div>
    <div style="height:10px;border-radius:6px;background:#efe6dc;overflow:hidden;margin:12px 0">
      <i style="display:block;height:100%;width:${pct}%;background:linear-gradient(90deg,#9ad97f,#5fc26d)"></i>
    </div>
    <div class="row2">
      <button class="btn" id="pl-water">浇水</button>
      <button class="btn" id="pl-fert">施肥</button>
    </div>
    <p class="note">浇水每 10 分钟一次，施肥每小时一次；水分和肥料都会加快成长。</p>`);
  const act = async (path, okMsg) => {
    const r = await call(path, { id: p.id });
    if (r.status !== 200) { toast(r.body.message || '还不行'); return; }
    adopt(r.body.me);
    toast(okMsg);
    if (r.body.plant) openPlant(r.body.plant);
  };
  bd.querySelector('#pl-water').addEventListener('click', () => act('/api/plant/water', '浇好水了'));
  bd.querySelector('#pl-fert').addEventListener('click', () => act('/api/plant/fertilize', '施好肥了'));
}

async function doPlant(x) {
  const id = planting;
  planting = null;
  $('plant-tip').classList.add('hidden');
  const r = await call('/api/plant', { id, x });
  if (r.status !== 200) { toast(r.body.message || '种不了'); return; }
  adopt(r.body.me);
  playOink(1.4);
  toast(`种下了一颗${r.body.plant.name}`);
  refresh();
}

/* 猪圈可以左右拖动；点空地种植物，点植物看生长状态 */
let camDrag = null, camMoved = false;
$('main').addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, #pig, #friends, header, #plant-tip')) return;
  camDrag = { last: e.clientX, moved: 0 };
  camMoved = false;
});
$('main').addEventListener('pointermove', (e) => {
  if (!camDrag) return;
  const dx = e.clientX - camDrag.last;
  camDrag.last = e.clientX;
  camDrag.moved += Math.abs(dx);
  if (camDrag.moved > 6) { camMoved = true; Scene.panBy(-dx); }
});
function finishSceneTap(e) {
  if (!camDrag) return;
  const wasDrag = camMoved;
  camDrag = null; camMoved = false;
  if (wasDrag) return;
  if (e.target.closest('button, #pig, #friends, header, #plant-tip')) return;
  if (planting) {
    if (e.clientY < Scene.groundY() + 20) { toast('要种在地上'); return; }
    const worldX = Scene.screenToWorld(e.clientX);
    doPlant(clamp(worldX / Scene.worldW(), 0.03, 0.97));
    return;
  }
  const hit = Scene.hitPlant(e.clientX, e.clientY);
  if (hit) openPlant(hit);
}
$('main').addEventListener('pointerup', finishSceneTap);
$('main').addEventListener('pointercancel', () => { camDrag = null; camMoved = false; });
$('plant-cancel').addEventListener('click', () => { planting = null; $('plant-tip').classList.add('hidden'); });
$('seed-btn').addEventListener('click', openSeeds);

/* ---------------- 待办 ---------------- */
function openTodo() {
  const todos = ME.todos || [];
  const left = ME.todoRewardMax - ME.todoRewarded;
  const bd = openSheet('待办', `<div class="inline"><input id="td-in" maxlength="40" placeholder="要做什么"><button class="btn primary" id="td-add" style="min-width:0;padding:12px 18px">加</button></div>
    <p class="note">完成一条待办 +1 张券，每天最多 ${ME.todoRewardMax} 条有奖励（今天还剩 ${left} 条）。</p>
    <div class="list" id="td-list">${todos.length ? todos.map((t) => todoRow(t)).join('') : '<p class="note">还没有待办。</p>'}</div>`);
  const add = async () => {
    const text = $('td-in').value.trim();
    if (!text) return;
    const r = await call('/api/todo', { text });
    if (r.status === 200) { adopt(r.body.me); refresh(); openTodo(); } else toast(r.body.message || '加不了');
  };
  bd.querySelector('#td-add').addEventListener('click', add);
  bd.querySelector('#td-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  bindTodo(bd);
}
function todoRow(t) {
  return `<div class="item"><button class="ok ${t.done ? 'on' : ''}" data-done="${t.id}">${t.done ? '✓' : ''}</button><b class="${t.done ? 'done' : ''}">${esc(t.text)}</b>${t.rewarded ? '<small>券 +1</small>' : ''}<button class="del" data-del="${t.id}">✕</button></div>`;
}
function bindTodo(bd) {
  bd.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => {
    const r = await call('/api/todo/done', { id: b.dataset.done });
    if (r.status !== 200) { toast(r.body.message || '不行'); return; }
    adopt(r.body.me);
    if (r.body.rewarded) { toast('完成！券 +1'); playOink(1.5); }
    else toast('完成了。今天的待办奖励已经领满了');
    refresh(); openTodo();
  }));
  bd.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    await call('/api/todo/del', { id: b.dataset.del });
    refresh(); openTodo();
  }));
}

/* ---------------- 统计 ---------------- */
const fmtMin = (m) => {
  const v = Math.round((Number(m) || 0) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

function bars(arr, cls) {
  const max = Math.max(1, ...arr);
  return `<div class="bars ${cls}">${arr.map((v, i) => `<i style="height:${Math.max(2, (v / max) * 100)}%" class="${cls === 'focus' && i === arr.length - 1 ? 'today' : ''}"></i>`).join('')}</div>`;
}

async function openStats() {
  const bd = openSheet('统计', '<p class="note">读取中…</p>');
  const r = await call('/api/stats', null, 'GET');
  if (r.status !== 200) { bd.innerHTML = `<p class="note">${esc(r.body.message || '读不到')}</p>`; return; }
  const s = r.body;
  const totalMin = Math.round((Number(s.total.minutes) || 0) * 10) / 10;
  const hours = Math.floor(totalMin / 60), mins = Math.round((totalMin % 60) * 10) / 10;
  const totalText = totalMin < 60 ? `${fmtMin(totalMin)} 分钟` : `${hours} 小时 ${fmtMin(mins)} 分`;
  bd.innerHTML = `
    <div class="tiles">
      <div class="tile"><b>${s.today.count} 次</b><span>今日专注 · ${fmtMin(s.today.minutes)} 分钟</span></div>
      <div class="tile"><b>${totalText}</b><span>累计专注 · ${s.total.count} 次</span></div>
      <div class="tile"><b>${s.streak} 天</b><span>连续打卡</span></div>
      <div class="tile"><b>${s.todosDone} 条</b><span>完成待办</span></div>
      <div class="tile"><b>${s.have} / ${s.totalCards}</b><span>图鉴 · 稀有 ${s.byR.rare} · 传说 ${s.byR.legend}</span></div>
      <div class="tile"><b>${s.breaks} 次</b><span>休息 · 共抽 ${s.draws} 次</span></div>
    </div>
    <div class="sec">近 14 天每天专注多少分钟</div>
    ${bars(s.perDay.map((d) => d.minutes), 'focus')}
    <div class="axis"><span>${s.perDay[0].d.slice(5)}</span><span>今天</span></div>
    <div class="sec">一天里什么时段在专注（24 小时）</div>
    ${bars(s.hourHist, '')}
    <div class="axis"><span>0 点</span><span>6</span><span>12</span><span>18</span><span>24 点</span></div>
    <div class="sec">起床 / 睡觉打卡</div>
    <div class="list">${s.perDay.slice(-7).reverse().map((d) => `<div class="item"><b>${d.d.slice(5)}${d.d === s.perDay[13].d ? '（今天）' : ''}</b><small>起床 ${d.wake ? hhmm(d.wake) : '—'}</small><small>睡觉 ${d.sleep ? hhmm(d.sleep) : '—'}</small></div>`).join('')}</div>`;
}

/* ---------------- 今日目标（客户端计算，不依赖新接口） ---------------- */
const dkey = (ts = Date.now()) => new Date(ts + 8 * 3600000).toISOString().slice(0, 10);

function openDaily() {
  const focusN = (ME.todayFocus && ME.todayFocus.count) || 0;
  const doneToday = (ME.todos || []).filter((t) => t.done && t.doneAt && dkey(t.doneAt) === dkey()).length;
  const rows = [
    { t: '专注 1 次', ok: focusN >= 1, sub: `${Math.min(focusN, 1)} / 1` },
    { t: '完成 2 条待办', ok: doneToday >= 2, sub: `${doneToday} / 2` },
    { t: '今天来抽一只', ok: !!ME.cameToday, sub: ME.cameToday ? '已打卡' : '还没' },
  ];
  const done = rows.filter((r) => r.ok).length;
  openSheet('今日目标', `
    <p class="note">每天把这三件做完，猪就会更亲近你。${done === 3 ? '今天全完成了，厉害。' : ''}</p>
    <div class="list">${rows.map((r) => `<div class="item"><button class="ok ${r.ok ? 'on' : ''}">${r.ok ? '✓' : ''}</button><b class="${r.ok ? 'done' : ''}">${r.t}</b><small>${r.sub}</small></div>`).join('')}</div>
    <div class="tiles" style="margin-top:14px">
      <div class="tile"><b>${done} / 3</b><span>今日进度</span></div>
      <div class="tile"><b>${ME.streak || 0} 天</b><span>连续打卡</span></div>
    </div>`);
}

/* ---------------- 我（头像 / 起床睡觉 / 入口） ---------------- */
async function openProfile() {
  const cards = Object.entries(ME.cards || {}).sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, 20);
  const bd = openSheet(ME.name, `
    <div class="avgrid">
      <button data-av="0" class="${!ME.avatar ? 'on' : ''}"><img src="${BASE}assets/pig.gif" alt=""></button>
      ${cards.map(([id]) => `<button data-av="${id}" class="${ME.avatar === Number(id) ? 'on' : ''}"><img src="${imgOf(id)}" alt=""></button>`).join('')}
    </div>
    <p class="note">点一个换头像。</p>
    <div class="sec">起床 / 睡觉打卡</div>
    <div class="row2">
      <button class="btn" id="dc-wake">起床打卡<br><small>${ME.wake ? hhmm(ME.wake) : '还没打'}</small></button>
      <button class="btn" id="dc-sleep">睡觉打卡<br><small>${ME.sleep ? hhmm(ME.sleep) : '还没打'}</small></button>
    </div>
    <div class="sec">专注方式</div>
    <div class="toggle" id="p-cycle"><span>连续专注 · 自动番茄钟<br><small style="font-weight:400;color:var(--dim)">专注结束自动进休息，休息结束自动开下一轮</small></span><span class="sw ${autoCycle ? 'on' : ''}"></span></div>
    <div class="sec">更多</div>
    <div class="row2"><button class="btn" id="p-stats">统计</button><button class="btn" id="p-station">站与邀请</button></div>
    <div class="row2"><button class="btn" id="p-sound">声音：${soundOn ? '开' : '关'}</button>${ME.admin ? '<button class="btn" id="p-admin">开发者</button>' : '<button class="btn" id="p-logout">换个名字</button>'}</div>
    ${ME.admin ? '<div class="row2"><button class="btn" id="p-logout">换个名字</button></div>' : ''}`);
  bd.querySelectorAll('[data-av]').forEach((b) => b.addEventListener('click', async () => {
    const r = await call('/api/avatar', { cardId: Number(b.dataset.av) });
    if (r.status === 200) { adopt(r.body.me); refresh(); toast('头像换好了'); openProfile(); }
  }));
  const daycheck = async (kind) => {
    const r = await call('/api/daycheck', { kind });
    toast(r.status === 200 ? `${kind === 'wake' ? '早上好' : '晚安'}，${hhmm(r.body.at)}` : r.body.message);
    if (r.status === 200) { adopt(r.body.me); openProfile(); }
  };
  bd.querySelector('#dc-wake').addEventListener('click', () => daycheck('wake'));
  bd.querySelector('#dc-sleep').addEventListener('click', () => daycheck('sleep'));
  bd.querySelector('#p-stats').addEventListener('click', openStats);
  bd.querySelector('#p-cycle').addEventListener('click', () => {
    autoCycle = !autoCycle;
    localStorage.setItem('pig.autocycle', autoCycle ? '1' : '0');
    toast(autoCycle ? '已打开连续专注' : '已关闭连续专注', 1600);
    openProfile();
  });
  bd.querySelector('#p-station').addEventListener('click', openStation);
  bd.querySelector('#p-sound').addEventListener('click', () => {
    soundOn = !soundOn; localStorage.setItem('pig.sound', soundOn ? '1' : '0'); openProfile();
  });
  bd.querySelector('#p-logout').addEventListener('click', () => { closeSheet(); logout(); });
  const adm = bd.querySelector('#p-admin');
  if (adm) adm.addEventListener('click', openAdmin);
}

/* ---------------- 站 ---------------- */
function openStation() {
  const link = `${location.origin}${location.pathname}?c=${S.code}`;
  const bd = openSheet('站', `
    <p class="note">把这个站码发给朋友，他们在登录时填上就能进来。一个站最多 6 个人，互相看得见谁在专注。</p>
    <div class="item"><b>站码</b><span class="code">${S.code}</span><button class="mini pink" id="st-copy">复制</button></div>
    <div class="sec">站里的人</div>
    <div class="list">${S.members.map((m) => `<div class="item"><img src="${avatarOf(m)}" alt=""><b>${esc(m.name)}${m.uid === ME.uid ? '（我）' : ''}</b><small>${m.count} 只</small></div>`).join('')}</div>
    <div class="sec">站里的图鉴（大家抽到的合在一起）</div><p class="note">${S.collected} / ${S.total}</p>`);
  bd.querySelector('#st-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(S.code); toast('站码已复制'); }
    catch { toast(S.code); }
  });
}

/* ---------------- 开发者 ---------------- */
const FLAG_NAMES = { pat: '允许摸猪', seeds: '专注给种子', todoReward: '待办给券', sound: '默认开声音' };
async function openAdmin() {
  const bd = openSheet('开发者', '<p class="note">读取中…</p>');
  const r = await call('/api/admin/overview', null, 'GET');
  if (r.status !== 200) { bd.innerHTML = `<p class="note">${esc(r.body.message || '没有权限')}</p>`; return; }
  const d = r.body;
  bd.innerHTML = `
    <div class="sec">功能开关（对所有人生效）</div>
    ${Object.keys(FLAG_NAMES).map((k) => `<div class="toggle" data-flag="${k}"><span>${FLAG_NAMES[k]}</span><span class="sw ${d.flags[k] ? 'on' : ''}"></span></div>`).join('')}
    <div class="sec">所有人</div>
    <div class="list">${d.accounts.map((a) => `<div class="item"><img src="${a.avatar ? imgOf(a.avatar) : BASE + 'assets/pig.gif'}" onerror="this.src='${BASE}assets/pig.gif'" alt=""><b>${esc(a.name)}${a.admin ? ' · 开发者' : ''}</b><small>${a.cards} 只 · 专注 ${a.focusMin} 分</small><button class="mini green" data-g="${a.uid}">+券</button><button class="mini" data-s="${a.uid}">+种子</button><button class="mini" data-r="${a.uid}">可再抽</button></div>`).join('')}</div>
    <p class="note">「+券」「+种子」每次加 1（券最多 8，种子最多 9）。「可再抽」把这个人今天的免费抽还原。开发者身份只认服务器配置的昵称，不在界面里授予。</p>`;
  bd.querySelectorAll('[data-flag]').forEach((el) => el.addEventListener('click', async () => {
    const k = el.dataset.flag;
    const f = await call('/api/admin/flags', { key: k, value: !d.flags[k] });
    if (f.status === 200) { d.flags = f.body.flags; el.querySelector('.sw').classList.toggle('on', d.flags[k]); }
  }));
  const grant = async (target, body, after) => {
    const g = await call('/api/admin/grant', { target, ...body });
    if (g.status !== 200) { toast(g.body.message || '失败'); return; }
    toast(after(g.body)); openAdmin();
  };
  bd.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => grant(b.dataset.g, { tickets: 1 }, (x) => `券 → ${x.tickets}`)));
  bd.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => grant(b.dataset.s, { seeds: 1 }, (x) => `种子 → ${x.seeds}`)));
  bd.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', async () => {
    await call('/api/admin/resetdraw', { target: b.dataset.r }); toast('已还原今天的免费抽');
  }));
}

/* ---------------- 摸一下 ---------------- */
$('friends').addEventListener('click', async (e) => {
  const el = e.target.closest('.fr');
  if (!el) return;
  if (el.dataset.uid === ME.uid) { openProfile(); return; }
  const r = await call('/api/pat', { target: el.dataset.uid });
  if (r.status === 200) { playOink(1.2); toast(`摸了一下 ${el.dataset.name} 的猪`); }
  else toast(r.body.message || '不行');
});

/* ---------------- 事件 ---------------- */
$('sheet-x').addEventListener('click', closeSheet);
$('sheet-ov').addEventListener('click', (e) => { if (e.target === $('sheet-ov')) closeSheet(); });
$('h-avatar').addEventListener('click', openProfile);
$('h-streak-box').addEventListener('click', openDaily);
$('b-draw').addEventListener('click', doDraw);
$('b-focus').addEventListener('click', openFocusPicker);
$('b-todo').addEventListener('click', openTodo);
$('b-book').addEventListener('click', openBook);
$('pit-x').addEventListener('click', () => { $('pit-ov').classList.add('hidden'); pit && pit.close(); });
$('v-close').addEventListener('click', () => $('viewer').classList.add('hidden'));
$('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) $('viewer').classList.add('hidden'); });

$('draw').addEventListener('click', () => {
  if ($('draw').dataset.ready !== undefined) return;
  $('draw').classList.add('hidden');
});

$('f-min').addEventListener('click', () => { focusOpen = false; $('focus').classList.add('hidden'); });

let stopArmed = false, stopTimer = null;
$('f-stop').addEventListener('click', async () => {
  const btn = $('f-stop');
  if (!stopArmed) {
    stopArmed = true;
    btn.textContent = '再点一次确认';
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => { stopArmed = false; btn.textContent = '放弃'; }, 2600);
    return;
  }
  stopArmed = false; clearTimeout(stopTimer); btn.textContent = '放弃';
  const f = read(KEY_F);
  write(KEY_F, null);
  cancelNotify(1001);
  focusOpen = false;
  $('focus').classList.add('hidden');
  toast(f && nowMs() >= f.endsAt ? '这次已经做完了，正在结算' : '已放弃');
  await settleIfPending(f);
  timers();
});

/* 放弃时如果其实已经到点了，仍然按完成结算 */
async function settleIfPending(f) {
  if (!f) return;
  if (nowMs() >= f.endsAt) {
    // 重新写回去，让 settleFocus 走正常的完成流程
    write(KEY_F, f);
    lastSettleTry = 0;
    await settleFocus(true);
  } else {
    cycle = null; saveCycle();
    const r = await call('/api/focus/end', { abandon: true });
    if (r.status === 200) adopt(r.body.me);
    refresh();
  }
}

/* ---------------- 实时 ---------------- */
function connect() {
  if (es) { try { es.close(); } catch { /* ignore */ } }
  es = new EventSource(api(`api/stream?code=${encodeURIComponent(CODE)}`));
  es.addEventListener('message', (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'feed') pushFeed(m.text);
      if (m.type === 'presence') refresh();
    } catch { /* ignore */ }
  });
}

let hbTimer = null;
function heartbeat() {
  clearInterval(hbTimer);
  hbTimer = setInterval(async () => {
    if (document.hidden || !UID) return;
    const f = read(KEY_F), b = read(KEY_B);
    const now = nowMs();
    const state = f && now < f.endsAt ? 'focusing' : b && now < b.endsAt ? 'breaking' : 'idle';
    await call('/api/presence', { state });
    if (state === 'idle') refresh();            // 顺手把别人的状态也拉一下
  }, 30000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  timers();
  refresh();
  if (!es || es.readyState === 2) connect();
});

/* ---------------- 原生 ---------------- */
function setupNative() {
  const C = window.Capacitor;
  if (!C || !C.Plugins) return;
  const App = C.Plugins.App;
  if (App && App.addListener) {
    App.addListener('backButton', () => {
      const open = [...document.querySelectorAll('#viewer:not(.hidden), #pit-ov:not(.hidden), #sheet-ov:not(.hidden), #focus:not(.hidden)')].pop();
      if (open) {
        if (open.id === 'focus') focusOpen = false;
        if (open.id === 'pit-ov') pit && pit.close();
        open.classList.add('hidden');
        return;
      }
      if (App.exitApp) App.exitApp();
    });
    App.addListener('resume', () => { timers(); refresh(); if (!es || es.readyState === 2) connect(); });
  }
  const SB = C.Plugins.StatusBar;
  if (SB) { try { SB.setStyle({ style: 'LIGHT' }); SB.setBackgroundColor({ color: '#8fd0ff' }); } catch { /* ignore */ } }
}

/* ---------------- 登录 ---------------- */
async function doLogin() {
  const name = $('j-name').value.trim();
  const code = $('j-code').value.trim().toUpperCase();
  if (!name) { $('j-err').textContent = '先填一个名字'; return; }
  $('j-err').textContent = '';
  $('j-go').disabled = true;
  const r = await call('/api/login', { name, code });
  $('j-go').disabled = false;
  if (r.status !== 200) { $('j-err').textContent = r.body.message || '进不去'; return; }
  UID = r.body.uid; CODE = r.body.code;
  localStorage.setItem('pig.uid', UID);
  localStorage.setItem('pig.code', CODE);
  S = r.body.state; ME = r.body.me;
  enter();
  if (r.body.isNew) setTimeout(() => toast('欢迎。先抽一只吧'), 600);
}
$('j-go').addEventListener('click', doLogin);
$('j-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

function enter() {
  $('login').classList.add('hidden');
  $('main').classList.remove('hidden');
  pigS.until = performance.now() + 1500;
  if (Scene.worldW()) {                     // 猪圈比屏幕宽，开局把镜头对准中间
    Scene.setCam(Scene.worldW() / 2 - innerWidth / 2);
    pigS.x = Scene.worldW() / 2;
  }
  render();
  connect();
  heartbeat();
  loadWeather();
}

/* ---------------- 天气（定位 + Open-Meteo） ---------------- */
function weatherFromCode(c) {
  if (c == null) return 'clear';
  if (c === 0 || c === 1) return 'clear';
  if (c === 2) return 'cloudy';
  if (c === 3 || c === 45 || c === 48) return 'overcast';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  return 'clear';
}

async function geoPos() {
  if (navigator.geolocation) {
    const p = await new Promise((res) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; res(null); } }, 5000);
      navigator.geolocation.getCurrentPosition(
        (pos) => { if (!done) { done = true; clearTimeout(t); res({ lat: pos.coords.latitude, lon: pos.coords.longitude }); } },
        () => { if (!done) { done = true; clearTimeout(t); res(null); } },
        { timeout: 4500, maximumAge: 3600000, enableHighAccuracy: false },
      );
    });
    if (p) return p;
  }
  try {                                            // 定位被拒就用 IP 粗略定位
    const r = await fetch('https://ipapi.co/json/');
    const j = await r.json();
    if (j && j.latitude) return { lat: j.latitude, lon: j.longitude };
  } catch { /* ignore */ }
  return null;
}

async function loadWeather() {
  if (forcedWeather) { Scene.setWeather(forcedWeather); return; }
  const cached = read('pig.weather');
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) { Scene.setWeather(cached.w); return; }
  try {
    let geo = read('pig.geo');
    if (!geo || Date.now() - geo.at > 6 * 3600 * 1000) {
      const p = await geoPos();
      if (!p) return;
      geo = { ...p, at: Date.now() };
      write('pig.geo', geo);
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=weather_code`;
    const r = await fetch(url);
    const j = await r.json();
    const code = j && j.current && j.current.weather_code;
    const w = weatherFromCode(code);
    write('pig.weather', { at: Date.now(), w });
    Scene.setWeather(w);
  } catch { /* 没网就保持晴天 */ }
}

/* ---------------- 启动 ---------------- */
function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - pigS.last) / 1000 || 0.016);
  pigS.last = now;
  pigTick(dt);
  requestAnimationFrame(loop);
}

async function boot() {
  if (NATIVE) setupNative();
  // 清掉上次残留的定时通知：否则可能会出现「一打开就收到专注结束」
  cancelNotify(1001);
  cancelNotify(1002);
  Scene.resize();
  addEventListener('resize', () => { Scene.resize(); Scene.render(); });
  setInterval(() => { if (!document.hidden) Scene.render(); }, 100);
  setInterval(timers, 500);
  requestAnimationFrame(loop);

  // 调试 / 截图用：?h=15.5 强制某个时刻，?open=book|todo|stats|profile|station|admin
  const q = new URLSearchParams(location.search);
  forcedWeather = q.get('w') || '';
  if (forcedWeather) Scene.setWeather(forcedWeather);
  if (q.get('h') != null) Scene.forceHour(parseFloat(q.get('h')));
  const qc = (q.get('c') || '').toUpperCase();
  const qn = q.get('n') || '';
  if (qc) $('j-code').value = qc;

  let ok = false;
  if (UID) {
    const r = await call('/api/me', null, 'GET');
    if (r.status === 200) { ME = r.body; ok = true; }
  }
  if (ok) {
    const st = await call('/api/state', null, 'GET');
    if (st.status === 200) { S = st.body; enter(); }
    else ok = false;
  }
  if (!ok) logout();
  if (!ok && qn) { $('j-name').value = qn; await doLogin(); if (ME) ok = true; }

  const co = $('cover');
  co.classList.add('off');
  setTimeout(() => co.remove(), 600);

  const open = q.get('open');
  if (ok && open) setTimeout(() => {
    if (open === 'book') openBook(); else if (open === 'todo') openTodo(); else if (open === 'stats') openStats();
    else if (open === 'profile') openProfile(); else if (open === 'station') openStation(); else if (open === 'admin') openAdmin();
    else if (open === 'seeds') openSeeds();
  }, 400);
  if (qc || qn) history.replaceState(null, '', location.pathname);
}

boot();
