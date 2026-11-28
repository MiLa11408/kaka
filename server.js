'use strict';
/**
 * 祝雪溪 · 服务端（零依赖，只用 Node 标准库）
 *
 * 身份 = 用户名。登录只输名字，不要密码（Boss 决定）。
 * 客户端拿到一个 token（uid），之后所有请求带 X-Pig-Uid。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PORT || '3700', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const IMG_DIR = path.join(DATA_DIR, 'images');
const ST_DIR = path.join(DATA_DIR, 'stations');
const US_DIR = path.join(DATA_DIR, 'users');
const PIGHUB = process.env.PIGHUB_BASE || 'https://pighub.top';

const MAX_MEMBERS = 6;
const TICKET_MAX = 5;
const PITY = 50;
const DUP_PROTECT = 3;
const RESUME_WINDOW = 5 * 60 * 1000;
const TODO_REWARD_PER_DAY = 3;
const MAX_PLANTS = 16;
const MAX_SEEDS = 9;
const GROW_MS = 2 * 3600 * 1000;          // 从种下到长满：2 小时真实时间

/* 植物：专注 25 分钟得一颗矮的，45 分钟得一颗高的 */
const SPECIES = {
  daisy:     { name: '小雏菊', tall: false },
  carrot:    { name: '胡萝卜', tall: false },
  tulip:     { name: '郁金香', tall: true },
  sunflower: { name: '向日葵', tall: true },
};
const FOCUS_MINUTES = String(process.env.FOCUS_MINUTES || '25,45').split(',').map(Number); // 测试时可改短

/* ------------------------------------------------------------------ 工具 */

const TZ = 8 * 3600 * 1000;
const dayKey = (ts = Date.now()) => new Date(ts + TZ).toISOString().slice(0, 10);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const newUid = () => 'u_' + crypto.randomBytes(9).toString('hex');
const UID_RE = /^u_[a-f0-9]{18}$/;

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)];
  return s;
}

function hash32(n) {
  let h = 2166136261;
  const s = 'pig' + n;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100;
}
function rarityOf(id) {
  const h = hash32(id);
  if (h < 70) return 'common';
  if (h < 95) return 'rare';
  return 'legend';
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return fallback; }
}

let writeQueue = Promise.resolve();
function writeJson(file, obj) {
  writeQueue = writeQueue.then(async () => {
    const tmp = file + '.tmp';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 1));
    await fsp.rename(tmp, file);
  }).catch((e) => console.error('write fail', file, e.message));
  return writeQueue;
}

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/* ------------------------------------------------------------------ 卡库 */

let CARDS = [];
const CARD_BY_ID = new Map();
const BY_RARITY = { common: [], rare: [], legend: [] };

async function loadCards() {
  const cache = path.join(DATA_DIR, 'cards.json');
  let list = null;
  const cached = await readJson(cache, null);
  const stale = !cached || !cached.at || Date.now() - cached.at > 24 * 3600 * 1000;
  if (cached && cached.cards && cached.cards.length) list = cached.cards;

  if (stale) {
    try {
      const res = await fetch(`${PIGHUB}/api/images?sort=2`, { signal: AbortSignal.timeout(15000) });
      const j = await res.json();
      if (j && j.code === 0 && Array.isArray(j.data) && j.data.length) {
        list = j.data.map((x) => ({
          id: x.id,
          title: String(x.title || '').trim() || `#${x.id}`,
          file: x.filename,
          views: x.view_count || 0,
        }));
        await writeJson(cache, { at: Date.now(), cards: list });
        console.log(`[cards] 从 PigHub 拉取 ${list.length} 张`);
      }
    } catch (e) {
      console.warn('[cards] 拉取失败，用本地缓存：', e.message);
    }
  }
  if (!list || !list.length) { console.error('!! 没有卡库，抽卡不可用'); return; }

  CARDS = list.map((c) => ({ ...c, rarity: rarityOf(c.id) }));
  CARD_BY_ID.clear();
  for (const k of Object.keys(BY_RARITY)) BY_RARITY[k] = [];
  for (const c of CARDS) { CARD_BY_ID.set(c.id, c); BY_RARITY[c.rarity].push(c); }
  console.log(`[cards] 就绪 ${CARDS.length} 张 · 常见 ${BY_RARITY.common.length} / 稀有 ${BY_RARITY.rare.length} / 传说 ${BY_RARITY.legend.length}`);
}

async function ensureImage(card) {
  const file = path.join(IMG_DIR, `${card.id}.jpg`);
  try {
    const st = await fsp.stat(file);
    if (st.size > 1024) return true;
  } catch { /* 没有就下 */ }
  try {
    const res = await fetch(`${PIGHUB}/images/${encodeURIComponent(card.file)}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) return false;
    await fsp.mkdir(IMG_DIR, { recursive: true });
    await fsp.writeFile(file, buf);
    return true;
  } catch (e) {
    console.warn('[img] 下载失败', card.id, e.message);
    return false;
  }
}

/* ------------------------------------------------------------------ 账号 */

const users = new Map();       // uid -> 账号
const nameIndex = new Map();   // 名字 -> uid
const stations = new Map();    // 站码 -> 站
const presence = new Map();    // uid -> { state, endsAt, updatedAt }
const clients = new Map();     // 站码 -> Set<res>

let admins = [];
let flags = { pat: true, seeds: true, todoReward: true, sound: true };

function newAccount(uid, name) {
  return {
    uid, name, createdAt: Date.now(),
    cards: {}, tickets: 0, lastDrawDate: null, days: [],
    pity: 0, dupStreak: 0, draws: 0,
    seeds: [], plants: [], todos: [], todoRewardDay: null, todoRewarded: 0,
    focusLog: [], breakLog: [], currentFocus: null, currentBreak: null,
    dayLog: {}, avatar: 0, station: null, pats: {},
  };
}

const saveUser = (u) => writeJson(path.join(US_DIR, `${u.uid}.json`), u);
const saveAdmins = () => writeJson(path.join(DATA_DIR, 'admin.json'), { admins, flags });

function ensureDay(u, ts = Date.now()) {
  u.dayLog = u.dayLog || {};
  const d = dayKey(ts);
  if (!u.dayLog[d]) u.dayLog[d] = { wake: 0, sleep: 0, todos: 0 };
  return u.dayLog[d];
}

function streakOf(u) {
  const days = new Set(u.days || []);
  let n = 0;
  const t = Date.now();
  for (let i = 0; i < 400; i++) {
    if (days.has(dayKey(t - i * 86400000))) n++;
    else if (i === 0) continue;   // 今天还没抽，从昨天接着数
    else break;
  }
  return n;
}

function cardDetail(u) {
  const out = {};
  for (const [id, c] of Object.entries(u.cards || {})) {
    const card = CARD_BY_ID.get(Number(id));
    out[id] = { ...c, title: card ? card.title : `#${id}`, rarity: card ? card.rarity : 'common' };
  }
  return out;
}

function plantView(p) {
  return { ...p, growth: clamp((Date.now() - p.plantedAt) / GROW_MS, 0, 1), name: SPECIES[p.species].name };
}

function presenceOf(uid) {
  const p = presence.get(uid);
  const now = Date.now();
  if (p && (p.state === 'focusing' || p.state === 'breaking')) {
    return p.endsAt > now ? p : { ...p, state: 'idle', endsAt: 0 };
  }
  if (!p || now - p.updatedAt > 45 * 1000) return { state: 'off', endsAt: 0, updatedAt: p ? p.updatedAt : 0 };
  return p;
}

function publicUser(u) {
  return {
    uid: u.uid, name: u.name,
    count: Object.keys(u.cards || {}).length,
    avatar: u.avatar || 0,
    streak: streakOf(u),
    cameToday: u.lastDrawDate === dayKey(),
    presence: presenceOf(u.uid),
  };
}

function meView(u) {
  const today = dayKey();
  const done = (u.focusLog || []).filter((r) => r.status === 'completed');
  const tf = done.filter((r) => dayKey(r.end) === today);
  const rec = (u.dayLog || {})[today] || { wake: 0, sleep: 0, todos: 0 };
  return {
    ...publicUser(u),
    now: Date.now(),                 // 客户端据此对齐时钟，避免「刚开就显示结束」
    admin: admins.includes(u.uid),
    tickets: u.tickets || 0,
    cards: cardDetail(u),
    seeds: (u.seeds || []).map((s) => ({ id: s.id, species: s.species, name: SPECIES[s.species].name })),
    plants: (u.plants || []).map(plantView),
    todos: (u.todos || []).slice(-50).reverse(),
    todoRewarded: u.todoRewardDay === today ? (u.todoRewarded || 0) : 0,
    todoRewardMax: TODO_REWARD_PER_DAY,
    todayFocus: { count: tf.length, minutes: tf.reduce((a, r) => a + r.minutes, 0) },
    todayBreaks: (u.breakLog || []).filter((t) => dayKey(t) === today).length,
    wake: rec.wake, sleep: rec.sleep,
    focus: u.currentFocus || null,
    brk: u.currentBreak || null,
    flags,
  };
}

function stationView(code, viewerUid) {
  const st = stations.get(code);
  if (!st) return null;
  const members = st.members.map((uid) => users.get(uid)).filter(Boolean).map(publicUser);
  const union = new Set();
  for (const uid of st.members) {
    const u = users.get(uid);
    if (u) for (const id of Object.keys(u.cards || {})) union.add(id);
  }
  return {
    code: st.code, name: st.name, createdAt: st.createdAt,
    total: CARDS.length, collected: union.size,
    members,
    // 每个人地里的植物：站里的人互相看得见
    gardens: st.members.map((uid) => {
      const u = users.get(uid);
      return u ? { uid, plants: (u.plants || []).map(plantView) } : null;
    }).filter(Boolean),
    feed: st.feed.slice(-12),
    viewerIsMember: st.members.includes(viewerUid),
  };
}

/* ------------------------------------------------------------------ 抽卡 */

function drawCard(u) {
  const today = dayKey();
  const free = u.lastDrawDate !== today;
  if (!free && (u.tickets || 0) <= 0) return { error: 'no-ticket' };

  u.pity = (u.pity || 0) + 1;
  const dupBoost = Math.min(45, Math.max(0, ((u.dupStreak || 0) - DUP_PROTECT + 1) * 15));

  let pool;
  if (u.pity >= PITY && BY_RARITY.legend.length) {
    pool = BY_RARITY.legend;
  } else {
    const r = Math.random() * 100;
    let want;
    if (r < 70 - dupBoost * 0.7) want = 'common';
    else if (r < 95 - dupBoost * 0.3) want = 'rare';
    else want = 'legend';
    pool = BY_RARITY[want].length ? BY_RARITY[want] : CARDS;
  }
  if (dupBoost > 0 && Math.random() * 100 < dupBoost) {
    const fresh = pool.filter((c) => !u.cards[c.id]);
    if (fresh.length) pool = fresh;
  }

  const card = pick(pool);
  if (!card) return { error: 'empty-pool' };
  if (card.rarity === 'legend') u.pity = 0;

  const isNew = !u.cards[card.id];
  if (isNew) {
    u.cards[card.id] = { count: 1, ex: 0, firstAt: Date.now(), lastAt: Date.now() };
    u.dupStreak = 0;
  } else {
    const c = u.cards[card.id];
    c.count += 1;
    c.ex = Math.min(5, c.ex + 1);
    c.lastAt = Date.now();
    u.dupStreak = (u.dupStreak || 0) + 1;
  }
  if (free) {
    u.lastDrawDate = today;
    u.days = u.days || [];
    if (!u.days.includes(today)) u.days.push(today);
    if (u.days.length > 400) u.days.shift();
  } else {
    u.tickets = Math.max(0, (u.tickets || 0) - 1);
  }
  u.draws = (u.draws || 0) + 1;
  return { card, isNew, free, ex: u.cards[card.id].ex, count: u.cards[card.id].count };
}

function undoDraw(u, r) {
  if (r.free) {
    u.lastDrawDate = null;
    u.days = (u.days || []).filter((d) => d !== dayKey());
  } else u.tickets = clamp((u.tickets || 0) + 1, 0, TICKET_MAX);
  const c = u.cards[r.card.id];
  if (c) { c.count -= 1; if (c.ex > 0) c.ex -= 1; if (c.count <= 0) delete u.cards[r.card.id]; }
  u.draws = Math.max(0, u.draws - 1);
}

function giveSeed(u, minutes) {
  if (!flags.seeds || (u.seeds || []).length >= MAX_SEEDS) return null;
  const s = { id: 's_' + crypto.randomBytes(4).toString('hex'), species: pick(minutes >= 45 ? ['sunflower', 'tulip'] : ['daisy', 'carrot']), at: Date.now() };
  u.seeds.push(s);
  return { id: s.id, species: s.species, name: SPECIES[s.species].name };
}

/* ------------------------------------------------------------------ HTTP */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Pig-Uid',
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(obj));
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenOf(req) {
  const h = String(req.headers['x-pig-uid'] || '').trim();
  if (UID_RE.test(h)) return h;
  const c = parseCookies(req);
  if (UID_RE.test(c.pig_uid || '')) return c.pig_uid;
  return null;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error('too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};

function broadcast(code, type, payload) {
  const set = clients.get(code);
  if (!set) return;
  const line = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const res of set) { try { res.write(line); } catch { /* ignore */ } }
}

function pushFeed(st, text) {
  st.feed.push({ t: Date.now(), text });
  if (st.feed.length > 60) st.feed.shift();
  writeJson(path.join(ST_DIR, `${st.code}.json`), st);
  broadcast(st.code, 'feed', { text, t: Date.now() });
}

function setPresence(u, state, endsAt = 0) {
  const p = { state, endsAt, updatedAt: Date.now(), name: u.name };
  presence.set(u.uid, p);
  if (u.station) broadcast(u.station, 'presence', { uid: u.uid, ...p });
}

const stationOf = (u) => (u && u.station ? stations.get(u.station) : null);

/* ------------------------------------------------------------------ 路由 */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  try {
    if (p === '/api/health') return json(res, 200, { ok: true, cards: CARDS.length });

    /* ---- 登录：只输名字 ---- */
    if (p === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const name = cleanText(body.name, 12).replace(/\s+/g, '');
      if (!name) return json(res, 400, { error: 'name', message: '先填一个名字' });

      const cur = tokenOf(req);
      let u = cur ? users.get(cur) : null;
      const existing = nameIndex.get(name);
      let isNew = false;

      if (existing) {
        u = users.get(existing);                       // 这个名字已有账号 → 直接进
      } else if (u) {
        nameIndex.delete(u.name);                      // 给当前账号起名 / 改名
        u.name = name; nameIndex.set(name, u.uid);
      } else {
        let uid = cur;
        if (!uid || users.has(uid)) uid = issueToken(res);
        u = newAccount(uid, name);
        users.set(uid, u); nameIndex.set(name, uid);
        isNew = true;
        if (!admins.length) { admins.push(uid); await saveAdmins(); }   // 第一个注册的人是开发者
      }

      const code = cleanText(body.code, 6).toUpperCase();
      let st = stationOf(u);
      if (code) {
        const target = stations.get(code);
        if (!target) return json(res, 404, { error: 'no-station', message: '站码不存在' });
        if (target.code !== u.station) {
          if (!target.members.includes(u.uid)) {
            if (target.members.length >= MAX_MEMBERS) return json(res, 409, { error: 'full', message: '这个站满了（最多 6 人）' });
            const old = stationOf(u);
            if (old) old.members = old.members.filter((x) => x !== u.uid);
            target.members.push(u.uid);
          }
          u.station = target.code;
          await writeJson(path.join(ST_DIR, `${target.code}.json`), target);
        }
        st = target;
      } else if (!st) {
        const c = newCode();
        st = { code: c, name: `${name}的站`, createdAt: Date.now(), members: [u.uid], feed: [] };
        stations.set(c, st); u.station = c;
      }
      await writeJson(path.join(ST_DIR, `${st.code}.json`), st);
      await saveUser(u);
      return json(res, 200, { ok: true, uid: u.uid, name: u.name, isNew, code: st.code, me: meView(u), state: stationView(st.code, u.uid) });
    }

    /* ---- 以下都要登录 ---- */
    const token = tokenOf(req);
    const me = token ? users.get(token) : null;
    if (p.startsWith('/api/') && !me) return json(res, 401, { error: 'not-logged-in', message: '先登录' });

    if (p === '/api/me') return json(res, 200, meView(me));

    if (p === '/api/state') {
      const st = stationOf(me);
      if (!st) return json(res, 404, { error: 'no-station' });
      return json(res, 200, { ...stationView(st.code, me.uid), me: meView(me) });
    }

    if (p === '/api/stats') {
      const done = (me.focusLog || []).filter((r) => r.status === 'completed');
      const today = dayKey();
      const perDay = [];
      for (let i = 13; i >= 0; i--) {
        const d = dayKey(Date.now() - i * 86400000);
        const rows = done.filter((r) => dayKey(r.end) === d);
        const rec = (me.dayLog || {})[d] || {};
        perDay.push({ d, minutes: rows.reduce((a, r) => a + r.minutes, 0), count: rows.length, wake: rec.wake || 0, sleep: rec.sleep || 0, todos: rec.todos || 0 });
      }
      const byR = { common: 0, rare: 0, legend: 0 };
      for (const c of Object.values(cardDetail(me))) byR[c.rarity]++;
      const hourHist = new Array(24).fill(0);        // 专注发生在几点（分钟数）
      for (const r of done) hourHist[new Date(r.start + TZ).getUTCHours()] += r.minutes;
      const todayRows = done.filter((r) => dayKey(r.end) === today);
      return json(res, 200, {
        total: { count: done.length, minutes: done.reduce((a, r) => a + r.minutes, 0) },
        today: { count: todayRows.length, minutes: todayRows.reduce((a, r) => a + r.minutes, 0) },
        breaks: (me.breakLog || []).length,
        todosDone: (me.todos || []).filter((t) => t.done).length,
        streak: streakOf(me),
        draws: me.draws || 0, byR,
        have: Object.keys(me.cards || {}).length, totalCards: CARDS.length,
        perDay, hourHist,
        since: me.createdAt,
      });
    }

    /* ---- 抽卡 ---- */
    if (p === '/api/draw' && req.method === 'POST') {
      const st = stationOf(me);
      if (!st) return json(res, 404, { error: 'no-station' });
      const r = drawCard(me);
      if (r.error === 'no-ticket') return json(res, 402, { error: 'no-ticket', message: '今天抽过了。专注 25 分钟可以再抽一次。' });
      if (r.error) return json(res, 503, { error: r.error, message: '图库暂时不可用，稍后再试' });

      if (!(await ensureImage(r.card))) {
        undoDraw(me, r);
        return json(res, 503, { error: 'image-unavailable', message: '图库暂时不可用，这次没消耗，稍后再试' });
      }
      await saveUser(me);
      if (r.card.rarity === 'legend') pushFeed(st, `${me.name} 抽到了传说 · ${r.card.title}`);
      return json(res, 200, { ok: true, card: { ...r.card, ex: r.ex, count: r.count }, isNew: r.isNew, free: r.free, tickets: me.tickets, me: meView(me) });
    }

    /* ---- 专注 ---- */
    if (p === '/api/focus/start' && req.method === 'POST') {
      const body = await readBody(req);
      const minutes = parseFloat(body.minutes);
      if (!FOCUS_MINUTES.includes(minutes)) return json(res, 400, { error: 'bad-minutes', message: '专注时长只能是 25 或 45 分钟' });
      if (me.currentFocus && me.currentFocus.endsAt > Date.now()) return json(res, 409, { error: 'busy', message: '已经在专注了' });

      const now = Date.now();
      const span = minutes * 60 * 1000;
      const prev = (me.focusLog || []).slice(-1)[0];
      let resumed = false;
      me.currentBreak = null;
      if (prev && prev.status === 'aborted' && now - prev.end < RESUME_WINDOW && prev.minutes === minutes) {
        // 5 分钟内中断过且时长一样 → 从停下的地方接着走
        me.focusLog.pop();
        const remaining = Math.max(60e3, span - (prev.end - prev.start));
        me.currentFocus = { id: prev.id, start: prev.start, endsAt: now + remaining, minutes, resumed: true };
        resumed = true;
      } else {
        me.currentFocus = { id: 'f_' + crypto.randomBytes(5).toString('hex'), start: now, endsAt: now + span, minutes };
      }
      setPresence(me, 'focusing', me.currentFocus.endsAt);
      await saveUser(me);
      return json(res, 200, { ok: true, now: Date.now(), focus: me.currentFocus, resumed });
    }

    if (p === '/api/focus/end' && req.method === 'POST') {
      const body = await readBody(req);
      const now = Date.now();
      const f = me.currentFocus;
      if (!f) return json(res, 200, { ok: true, settled: false, me: meView(me) });

      const status = now >= f.endsAt ? 'completed' : 'aborted';
      const rec = { id: f.id, start: f.start, end: now, minutes: f.minutes, status };
      let result = { granted: 0, capped: false, seed: null };

      if (status === 'completed') {
        const add = f.minutes >= 45 ? 2 : 1;
        const before = me.tickets || 0;
        me.tickets = clamp(before + add, 0, TICKET_MAX);
        result = { granted: me.tickets - before, capped: before + add > TICKET_MAX, seed: giveSeed(me, f.minutes) };
      }
      me.focusLog.push(rec);
      if (me.focusLog.length > 2000) me.focusLog.shift();
      delete me.currentFocus;
      setPresence(me, 'idle');
      await saveUser(me);

      const st = stationOf(me);
      if (st && status === 'completed') pushFeed(st, `${me.name} 完成了一次 ${f.minutes} 分钟`);
      return json(res, 200, { ok: true, settled: status === 'completed', status, ...result, me: meView(me) });
    }

    /* ---- 休息（只记状态，不发奖励） ---- */
    if (p === '/api/break/start' && req.method === 'POST') {
      const body = await readBody(req);
      const minutes = clamp(parseInt(body.minutes || 5, 10), 1, 60);
      me.currentBreak = { start: Date.now(), endsAt: Date.now() + minutes * 60 * 1000, minutes };
      me.breakLog.push(Date.now());
      setPresence(me, 'breaking', me.currentBreak.endsAt);
      await saveUser(me);
      return json(res, 200, { ok: true, now: Date.now(), brk: me.currentBreak });
    }
    if (p === '/api/break/end' && req.method === 'POST') {
      delete me.currentBreak;
      setPresence(me, 'idle');
      await saveUser(me);
      return json(res, 200, { ok: true, me: meView(me) });
    }

    /* ---- 起床 / 睡觉打卡 ---- */
    if (p === '/api/daycheck' && req.method === 'POST') {
      const body = await readBody(req);
      const kind = body.kind === 'sleep' ? 'sleep' : body.kind === 'wake' ? 'wake' : null;
      if (!kind) return json(res, 400, { error: 'bad-kind', message: '只能是 wake 或 sleep' });
      const now = Date.now();
      // 凌晨 6 点前打的「睡觉」算前一天晚上
      const ts = kind === 'sleep' && new Date(now + TZ).getUTCHours() < 6 ? now - 86400000 : now;
      const rec = ensureDay(me, ts);
      if (rec[kind]) return json(res, 409, { error: 'already', message: kind === 'wake' ? '今天已经打过起床卡了' : '这觉已经打过卡了' });
      rec[kind] = now;
      await saveUser(me);
      return json(res, 200, { ok: true, at: now, day: dayKey(ts), me: meView(me) });
    }

    /* ---- 待办 ---- */
    if (p === '/api/todo' && req.method === 'POST') {
      const body = await readBody(req);
      const text = cleanText(body.text, 40);
      if (!text) return json(res, 400, { error: 'empty', message: '待办不能是空的' });
      if (me.todos.filter((t) => !t.done).length >= 20) return json(res, 409, { error: 'many', message: '最多同时 20 条没做完的待办' });
      const t = { id: 't_' + crypto.randomBytes(4).toString('hex'), text, done: false, createdAt: Date.now(), doneAt: 0, rewarded: false };
      me.todos.push(t);
      await saveUser(me);
      return json(res, 200, { ok: true, todo: t, me: meView(me) });
    }
    if (p === '/api/todo/done' && req.method === 'POST') {
      const body = await readBody(req);
      const t = me.todos.find((x) => x.id === body.id);
      if (!t) return json(res, 404, { error: 'no-todo', message: '没有这条待办' });
      if (t.done) return json(res, 409, { error: 'already', message: '这条已经做完了' });
      t.done = true; t.doneAt = Date.now();
      ensureDay(me).todos += 1;

      let rewarded = false;
      if (flags.todoReward) {
        const today = dayKey();
        if (me.todoRewardDay !== today) { me.todoRewardDay = today; me.todoRewarded = 0; }
        if (me.todoRewarded < TODO_REWARD_PER_DAY && me.tickets < TICKET_MAX) {
          me.tickets += 1; me.todoRewarded += 1; t.rewarded = true; rewarded = true;
        }
      }
      await saveUser(me);
      return json(res, 200, { ok: true, rewarded, me: meView(me) });
    }
    if (p === '/api/todo/del' && req.method === 'POST') {
      const body = await readBody(req);
      const before = me.todos.length;
      me.todos = me.todos.filter((x) => x.id !== body.id);
      await saveUser(me);
      return json(res, 200, { ok: true, removed: before !== me.todos.length, me: meView(me) });
    }

    /* ---- 植物 ---- */
    if (p === '/api/plant' && req.method === 'POST') {
      const body = await readBody(req);
      const idx = me.seeds.findIndex((s) => s.id === body.id);
      if (idx < 0) return json(res, 404, { error: 'no-seed', message: '没有这颗种子' });
      if (me.plants.length >= MAX_PLANTS) return json(res, 409, { error: 'full', message: `地里最多 ${MAX_PLANTS} 株` });
      const seed = me.seeds.splice(idx, 1)[0];
      const pl = { id: 'p_' + crypto.randomBytes(4).toString('hex'), species: seed.species, x: clamp(parseFloat(body.x) || Math.random(), 0.03, 0.97), depth: Math.random(), plantedAt: Date.now() };
      me.plants.push(pl);
      await saveUser(me);
      return json(res, 200, { ok: true, plant: plantView(pl), me: meView(me) });
    }
    if (p === '/api/plant/remove' && req.method === 'POST') {
      const body = await readBody(req);
      const before = me.plants.length;
      me.plants = me.plants.filter((x) => x.id !== body.id);
      await saveUser(me);
      return json(res, 200, { ok: true, removed: before !== me.plants.length, me: meView(me) });
    }

    /* ---- 头像 ---- */
    if (p === '/api/avatar' && req.method === 'POST') {
      const body = await readBody(req);
      const id = parseInt(body.cardId, 10) || 0;
      if (id && !me.cards[id]) return json(res, 404, { error: 'no-card', message: '你还没有这张卡' });
      me.avatar = id;
      await saveUser(me);
      if (me.station) broadcast(me.station, 'presence', { uid: me.uid, ...presenceOf(me.uid) });
      return json(res, 200, { ok: true, avatar: id, me: meView(me) });
    }

    /* ---- 心跳 / 摸一下 ---- */
    if (p === '/api/presence' && req.method === 'POST') {
      const body = await readBody(req);
      let state = String(body.state || 'idle');
      if (state === 'focusing' && !(me.currentFocus && me.currentFocus.endsAt > Date.now())) state = 'idle';
      if (state === 'breaking' && !(me.currentBreak && me.currentBreak.endsAt > Date.now())) state = 'idle';
      if (!['focusing', 'breaking', 'idle'].includes(state)) state = 'idle';
      presence.set(me.uid, {
        state,
        endsAt: state === 'focusing' ? me.currentFocus.endsAt : state === 'breaking' ? me.currentBreak.endsAt : 0,
        updatedAt: Date.now(), name: me.name,
      });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/pat' && req.method === 'POST') {
      if (!flags.pat) return json(res, 403, { error: 'off', message: '摸猪功能关着' });
      const body = await readBody(req);
      const tu = users.get(String(body.target || ''));
      if (!tu || tu.station !== me.station) return json(res, 404, { error: 'no-user' });
      me.pats = me.pats || {};
      if (me.pats[tu.uid] === dayKey()) return json(res, 429, { error: 'already', message: '今天已经摸过了' });
      me.pats[tu.uid] = dayKey();
      await saveUser(me);
      const st = stationOf(me);
      if (st) pushFeed(st, `${me.name} 摸了一下 ${tu.name} 的猪`);
      return json(res, 200, { ok: true });
    }

    /* ---- 开发者 ---- */
    if (p.startsWith('/api/admin/')) {
      if (!admins.includes(me.uid)) return json(res, 403, { error: 'not-admin', message: '需要开发者权限' });
      if (p === '/api/admin/overview') {
        return json(res, 200, {
          flags,
          accounts: [...users.values()].map((u) => ({
            uid: u.uid, name: u.name, admin: admins.includes(u.uid),
            tickets: u.tickets || 0, seeds: u.seeds.length, cards: Object.keys(u.cards).length,
            focusMin: u.focusLog.filter((r) => r.status === 'completed').reduce((a, r) => a + r.minutes, 0),
            station: u.station || '',
          })).sort((a, b) => b.focusMin - a.focusMin),
          stations: [...stations.values()].map((s) => ({ code: s.code, name: s.name, members: s.members.map((id) => (users.get(id) || {}).name || '?') })),
        });
      }
      if (p === '/api/admin/grant' && req.method === 'POST') {
        const body = await readBody(req);
        const tu = users.get(String(body.target || ''));
        if (!tu) return json(res, 404, { error: 'no-user' });
        tu.tickets = clamp((tu.tickets || 0) + (parseInt(body.tickets || 0, 10) || 0), 0, TICKET_MAX);
        for (let i = 0; i < (parseInt(body.seeds || 0, 10) || 0); i++) giveSeed(tu, 25);
        await saveUser(tu);
        return json(res, 200, { ok: true, tickets: tu.tickets, seeds: tu.seeds.length });
      }
      if (p === '/api/admin/resetdraw' && req.method === 'POST') {
        const body = await readBody(req);
        const tu = users.get(String(body.target || ''));
        if (!tu) return json(res, 404, { error: 'no-user' });
        tu.lastDrawDate = null;
        await saveUser(tu);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/admin/flags' && req.method === 'POST') {
        const body = await readBody(req);
        if (!(body.key in flags) || typeof body.value !== 'boolean') return json(res, 400, { error: 'bad-flag' });
        flags[body.key] = body.value;
        await saveAdmins();
        return json(res, 200, { ok: true, flags });
      }
      if (p === '/api/admin/addadmin' && req.method === 'POST') {
        const body = await readBody(req);
        const tu = users.get(String(body.target || '')) || users.get(nameIndex.get(cleanText(body.name, 12)) || '');
        if (!tu) return json(res, 404, { error: 'no-user' });
        if (!admins.includes(tu.uid)) { admins.push(tu.uid); await saveAdmins(); }
        return json(res, 200, { ok: true, admins: admins.length });
      }
      return json(res, 404, { error: 'not-found' });
    }

    /* ---- SSE ---- */
    if (p === '/api/stream') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      if (!stations.has(code)) return json(res, 404, { error: 'no-station' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', ...CORS,
      });
      res.write('retry: 3000\n\n');
      if (!clients.has(code)) clients.set(code, new Set());
      clients.get(code).add(res);
      req.on('close', () => clients.get(code)?.delete(res));
      return;
    }

    /* ---- 图片 ---- */
    if (p.startsWith('/img/')) {
      const id = parseInt(p.slice(5).replace(/\.jpg$/, ''), 10);
      if (!Number.isFinite(id)) return json(res, 400, { error: 'bad' });
      try {
        const buf = await fsp.readFile(path.join(IMG_DIR, `${id}.jpg`));
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=604800', ...CORS });
        return res.end(buf);
      } catch { return json(res, 404, { error: 'no-image' }); }
    }

    /* ---- 静态 ---- */
    if (req.method === 'GET') {
      const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
      const root = path.join(__dirname, 'public');
      const file = path.join(root, rel);
      if (!file.startsWith(root)) return json(res, 403, { error: 'no' });
      try {
        const buf = await fsp.readFile(file);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': /\.(gif|jpg|png|mp3|ogg|wav)$/.test(file) ? 'public, max-age=86400' : 'no-cache',
          ...CORS,
        });
        return res.end(buf);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404');
      }
    }

    return json(res, 404, { error: 'not-found' });
  } catch (e) {
    console.error('ERR', req.method, p, e);
    return json(res, 500, { error: 'server', message: e.message });
  }
});

function issueToken(res) {
  const uid = newUid();
  res.setHeader('Set-Cookie', `pig_uid=${uid}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return uid;
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  await fsp.mkdir(IMG_DIR, { recursive: true });
  await fsp.mkdir(ST_DIR, { recursive: true });
  await fsp.mkdir(US_DIR, { recursive: true });

  for (const f of await fsp.readdir(ST_DIR).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const st = await readJson(path.join(ST_DIR, f), null);
    if (st && st.code) stations.set(st.code, st);
  }
  for (const f of await fsp.readdir(US_DIR).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const u = await readJson(path.join(US_DIR, f), null);
    if (!u || !u.uid) continue;
    users.set(u.uid, { ...newAccount(u.uid, '无名'), ...u });
    nameIndex.set(u.name, u.uid);
  }
  const cfg = await readJson(path.join(DATA_DIR, 'admin.json'), null);
  if (cfg) { admins = cfg.admins || []; if (cfg.flags) flags = { ...flags, ...cfg.flags }; }
  admins = admins.filter((id) => users.has(id));
  for (const n of String(process.env.ADMIN_NAME || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const id = nameIndex.get(n);
    if (id && !admins.includes(id)) admins.push(id);
  }
  console.log(`[boot] ${stations.size} 个站 / ${users.size} 个人 / ${admins.length} 个开发者`);

  await loadCards();

  server.listen(PORT, HOST, () => console.log(`祝雪溪 → http://${HOST}:${PORT}`));
}

boot();
