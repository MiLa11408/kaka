'use strict';
/**
 * 余烬猪圈 · 服务端
 * 零依赖：只用 Node 标准库。
 *
 * 七样东西（见 DATA.md）：
 *   站 station / 人 user / 在线状态 presence / 卡 card / 收集 collection / 券 tickets / 专注记录 focus
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
const PITY = 50;              // 50 抽内必出传说
const DUP_PROTECT = 3;        // 连续 3 次重复后开始提升出新概率
const RESUME_WINDOW = 5 * 60 * 1000; // 中断后 5 分钟内可续

/* ------------------------------------------------------------------ 工具 */

const TZ = 8 * 3600 * 1000;
const dayKey = (ts = Date.now()) => new Date(ts + TZ).toISOString().slice(0, 10);

function hash32(n) {
  // 稳定哈希，同一 id 永远同一稀有度
  let h = 2166136261;
  const s = 'pig' + n;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

function rarityOf(id) {
  const h = hash32(id);
  if (h < 70) return 'common';
  if (h < 95) return 'rare';
  return 'legend';
}

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function newUid() { return 'u_' + crypto.randomBytes(9).toString('hex'); }
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)];
  return s;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return fallback; }
}

let writeQueue = Promise.resolve();
function writeJson(file, obj) {
  // 串行化写，避免并发写坏
  writeQueue = writeQueue.then(async () => {
    const tmp = file + '.tmp';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 1));
    await fsp.rename(tmp, file);
  }).catch((e) => console.error('write fail', file, e.message));
  return writeQueue;
}

/* ------------------------------------------------------------------ 卡库 */

let CARDS = [];            // [{id,title,file,rarity,views}]
let CARD_BY_ID = new Map();
const BY_RARITY = { common: [], rare: [], legend: [] };

async function loadCards() {
  const cache = path.join(DATA_DIR, 'cards.json');
  let list = null;

  // 先读本地缓存；超过 24 小时尝试刷新
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

  if (!list || !list.length) {
    console.error('!! 没有卡库，抽卡不可用');
    return;
  }

  CARDS = list.map((c) => ({ ...c, rarity: rarityOf(c.id) }));
  CARD_BY_ID = new Map(CARDS.map((c) => [c.id, c]));
  for (const k of Object.keys(BY_RARITY)) BY_RARITY[k] = [];
  for (const c of CARDS) BY_RARITY[c.rarity].push(c);
  console.log(`[cards] 就绪 ${CARDS.length} 张 · 常见 ${BY_RARITY.common.length} / 稀有 ${BY_RARITY.rare.length} / 传说 ${BY_RARITY.legend.length}`);
}

async function ensureImage(card) {
  const file = path.join(IMG_DIR, `${card.id}.jpg`);
  try {
    const st = await fsp.stat(file);
    if (st.size > 1024) return true;
  } catch { /* 没有就下 */ }
  try {
    const url = `${PIGHUB}/images/${encodeURIComponent(card.file)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
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

/* ------------------------------------------------------------------ 站与用户 */

const stations = new Map();   // code -> station
const users = new Map();      // uid  -> user
const presence = new Map();   // uid  -> {state, endsAt, updatedAt}
const clients = new Map();    // code -> Set<res>

function streakOf(u) {
  const days = new Set(u.days || []);
  let n = 0;
  const t = Date.now();
  for (let i = 0; i < 400; i++) {
    const d = dayKey(t - i * 86400000);
    if (days.has(d)) n++;
    else if (i === 0) continue;   // 今天还没打卡，从昨天开始算
    else break;
  }
  return n;
}

function publicUser(u) {
  return {
    uid: u.uid,
    name: u.name,
    ex: u.ex || 0,
    count: Object.keys(u.cards || {}).length,
    tickets: u.tickets || 0,
    lastDrawDate: u.lastDrawDate || null,
    streak: streakOf(u),
  };
}

function presenceOf(uid) {
  const p = presence.get(uid);
  if (!p) return { state: 'off', endsAt: 0, updatedAt: 0 };
  if (Date.now() - p.updatedAt > 45 * 1000 && p.state !== 'focusing') {
    return { state: 'off', endsAt: 0, updatedAt: p.updatedAt };
  }
  // 专注中即使没心跳，只要没到点也算在专注
  if (p.state === 'focusing' && p.endsAt > Date.now()) return p;
  if (p.state === 'focusing' && p.endsAt <= Date.now()) return { ...p, state: 'idle' };
  return p;
}

function stationView(code) {
  const st = stations.get(code);
  if (!st) return null;
  const members = st.members.map((uid) => {
    const u = users.get(uid);
    if (!u) return null;
    return {
      ...publicUser(u),
      presence: presenceOf(uid),
      cameToday: u.lastDrawDate === dayKey(),
    };
  }).filter(Boolean);

  // 集体图鉴：站内所有卡的并集
  const union = new Set();
  for (const uid of st.members) {
    const u = users.get(uid);
    if (u) for (const id of Object.keys(u.cards || {})) union.add(id);
  }

  return {
    code: st.code,
    name: st.name,
    createdAt: st.createdAt,
    total: CARDS.length,
    collected: union.size,
    members,
    feed: st.feed.slice(-20),
  };
}

/* ------------------------------------------------------------------ 抽卡 */

function drawCard(u) {
  const today = dayKey();
  const free = u.lastDrawDate !== today;
  if (!free && (u.tickets || 0) <= 0) {
    return { error: 'no-ticket' };
  }

  // 保底：距离上次传说 >= PITY 次，强制传说
  u.pity = (u.pity || 0) + 1;
  let pool;
  if (u.pity >= PITY && BY_RARITY.legend.length) {
    pool = BY_RARITY.legend;
    u.pity = 0;
  } else {
    // 重复保护：连续重复越久，出新的概率越高
    const dupBoost = Math.min(45, Math.max(0, ((u.dupStreak || 0) - DUP_PROTECT + 1) * 15));
    const r = Math.random() * 100;
    let want;
    if (r < 70 - dupBoost * 0.7) want = 'common';
    else if (r < 95 - dupBoost * 0.3) want = 'rare';
    else want = 'legend';
    pool = BY_RARITY[want].length ? BY_RARITY[want] : CARDS;
  }

  // 优先抽没收集过的（重复保护）
  let candidates = pool;
  const dupBoost = Math.min(45, Math.max(0, ((u.dupStreak || 0) - DUP_PROTECT + 1) * 15));
  if (dupBoost > 0 && Math.random() * 100 < dupBoost) {
    const fresh = pool.filter((c) => !u.cards[c.id]);
    if (fresh.length) candidates = fresh;
  }

  const card = pick(candidates);
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
    if (u.days.length > 120) u.days.shift();
  }
  else u.tickets = Math.max(0, (u.tickets || 0) - 1);
  u.draws = (u.draws || 0) + 1;

  return { card, isNew, free, ex: u.cards[card.id].ex, count: u.cards[card.id].count };
}

/* ------------------------------------------------------------------ 专注 */

function settleFocus(u, rec) {
  const mins = rec.minutes;
  const tickets = mins >= 45 ? 2 : mins >= 25 ? 1 : 0;
  const before = u.tickets || 0;
  u.tickets = clamp(before + tickets, 0, TICKET_MAX);
  return { tickets, granted: u.tickets - before, capped: before + tickets > TICKET_MAX };
}

/* ------------------------------------------------------------------ HTTP */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Pig-Uid',
  });
  res.end(body);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Pig-Uid',
};

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getUid(req, res) {
  const h = String(req.headers['x-pig-uid'] || '').trim();
  if (/^u_[a-f0-9]{18}$/.test(h)) return h;
  const c = parseCookies(req);
  if (/^u_[a-f0-9]{18}$/.test(c.pig_uid)) return c.pig_uid;
  const uid = newUid();
  res.setHeader('Set-Cookie', `pig_uid=${uid}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return uid;
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

function cleanText(s, max) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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

/* ------------------------------------------------------------------ 路由 */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  try {
    if (p === '/api/health') return json(res, 200, { ok: true, cards: CARDS.length });

    // ---- 加入 / 创建站
    if (p === '/api/join' && req.method === 'POST') {
      const uid = getUid(req, res);
      const body = await readBody(req);
      const name = cleanText(body.name, 12) || '无名';
      let code = String(body.code || '').trim().toUpperCase();

      let u = users.get(uid);
      if (!u) {
        u = { uid, name, cards: {}, tickets: 0, lastDrawDate: null, pity: 0, dupStreak: 0, draws: 0, createdAt: Date.now() };
        users.set(uid, u);
      }
      u.name = name;

      let st;
      if (code) {
        st = stations.get(code);
        if (!st) return json(res, 404, { error: 'no-station', message: '站码不存在' });
        if (!st.members.includes(uid)) {
          if (st.members.length >= MAX_MEMBERS) return json(res, 409, { error: 'full', message: '这个站满了（最多 6 人）' });
          st.members.push(uid);
        }
      } else {
        code = newCode();
        while (stations.has(code)) code = newCode();
        st = { code, name: `${name}的站`, createdAt: Date.now(), members: [uid], feed: [] };
        stations.set(code, st);
      }
      u.station = st.code;

      await writeJson(path.join(ST_DIR, `${st.code}.json`), st);
      await writeJson(path.join(US_DIR, `${uid}.json`), u);
      return json(res, 200, { ok: true, uid, code: st.code, state: stationView(st.code) });
    }

    // ---- 全景
    if (p === '/api/state') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      const v = stationView(code);
      if (!v) return json(res, 404, { error: 'no-station' });
      const uid = getUid(req, res);
      const u = users.get(uid);
      let me = null;
      if (u) {
        const cards = {};
        for (const [id, c] of Object.entries(u.cards || {})) {
          const card = CARD_BY_ID.get(Number(id));
          cards[id] = { ...c, title: card ? card.title : `#${id}`, rarity: card ? card.rarity : 'common' };
        }
        me = { ...publicUser(u), cards, pity: u.pity || 0 };
      }
      return json(res, 200, { ...v, me });
    }

    // ---- 抽卡
    if (p === '/api/draw' && req.method === 'POST') {
      const uid = getUid(req, res);
      const u = users.get(uid);
      if (!u || !u.station) return json(res, 401, { error: 'not-joined' });
      const st = stations.get(u.station);
      if (!st) return json(res, 404, { error: 'no-station' });

      const r = drawCard(u);
      if (r.error === 'no-ticket') {
        return json(res, 402, { error: 'no-ticket', message: '今天抽过了。专注 25 分钟可以再抽一次。' });
      }
      if (r.error) return json(res, 503, { error: r.error, message: '图库暂时不可用，稍后再试' });

      // 图片必须能拿到，否则不消耗这次抽卡
      const ok = await ensureImage(r.card);
      if (!ok && !fs.existsSync(path.join(IMG_DIR, `${r.card.id}.jpg`))) {
        // 回滚这次抽卡
        if (r.free) u.lastDrawDate = null; else u.tickets = clamp((u.tickets || 0) + 1, 0, TICKET_MAX);
        const c = u.cards[r.card.id];
        if (c) { c.count -= 1; if (c.ex > 0) c.ex -= 1; if (c.count <= 0) delete u.cards[r.card.id]; }
        u.draws = Math.max(0, u.draws - 1);
        return json(res, 503, { error: 'image-unavailable', message: '图库暂时不可用，这次没消耗，稍后再试' });
      }

      await writeJson(path.join(US_DIR, `${uid}.json`), u);

      const cardOut = { ...r.card, ex: r.ex, count: r.count };
      if (r.card.rarity === 'legend') pushFeed(st, `${u.name} 抽到了传说 · ${r.card.title}`);
      else if (r.isNew && r.card.rarity === 'rare') pushFeed(st, `${u.name} 抽到了稀有 · ${r.card.title}`);

      return json(res, 200, {
        ok: true, card: cardOut, isNew: r.isNew, free: r.free,
        tickets: u.tickets, state: stationView(st.code),
      });
    }

    // ---- 专注开始
    if (p === '/api/focus/start' && req.method === 'POST') {
      const uid = getUid(req, res);
      const u = users.get(uid);
      if (!u || !u.station) return json(res, 401, { error: 'not-joined' });
      const body = await readBody(req);
      const minutes = clamp(parseInt(body.minutes || 25, 10), 5, 120);

      const now = Date.now();
      // 5 分钟内中断过且时长一致 → 续上原来那次
      const prev = (u.focusLog || []).slice(-1)[0];
      if (prev && prev.status === 'aborted' && now - prev.end < RESUME_WINDOW && prev.minutes === minutes) {
        const endsAt = now + minutes * 60 * 1000;
        u.currentFocus = { id: prev.id, start: now, endsAt, minutes, resumed: true };
      } else {
        u.currentFocus = { id: 'f_' + crypto.randomBytes(5).toString('hex'), start: now, endsAt: now + minutes * 60 * 1000, minutes };
      }
      presence.set(uid, { state: 'focusing', endsAt: u.currentFocus.endsAt, updatedAt: now });
      await writeJson(path.join(US_DIR, `${uid}.json`), u);
      broadcast(u.station, 'presence', { uid, state: 'focusing', endsAt: u.currentFocus.endsAt, name: u.name });
      return json(res, 200, { ok: true, focus: u.currentFocus });
    }

    // ---- 专注结束 / 补算
    if (p === '/api/focus/end' && req.method === 'POST') {
      const uid = getUid(req, res);
      const u = users.get(uid);
      if (!u || !u.station) return json(res, 401, { error: 'not-joined' });
      const body = await readBody(req);
      const now = Date.now();
      const f = u.currentFocus;

      if (!f) return json(res, 200, { ok: true, settled: false, tickets: u.tickets });

      const elapsed = now - f.start;
      const done = now >= f.endsAt;
      const abandon = body.abandon === true;
      let status;
      if (done) status = 'completed';
      else if (elapsed > f.minutes * 60 * 1000 * 2) status = 'expired';
      else status = 'aborted';

      u.focusLog = u.focusLog || [];
      const rec = { id: f.id, start: f.start, end: now, minutes: f.minutes, status };

      let result = { tickets: 0, granted: 0 };
      if (status === 'completed') {
        result = settleFocus(u, rec);
        rec.reward = result.tickets;
        u.ex = (u.ex || 0) + 1;
      }
      u.focusLog.push(rec);
      if (u.focusLog.length > 500) u.focusLog.shift();
      delete u.currentFocus;

      presence.set(uid, { state: 'idle', endsAt: 0, updatedAt: now });
      await writeJson(path.join(US_DIR, `${uid}.json`), u);

      const st = stations.get(u.station);
      if (st) {
        if (status === 'completed') pushFeed(st, `${u.name} 完成了一次 ${f.minutes} 分钟`);
        broadcast(st.code, 'presence', { uid, state: 'idle', endsAt: 0, name: u.name });
      }

      return json(res, 200, {
        ok: true, settled: status === 'completed', status,
        ...result, tickets: u.tickets, ex: u.ex,
        state: stationView(u.station),
      });
    }

    // ---- 心跳
    if (p === '/api/presence' && req.method === 'POST') {
      const uid = getUid(req, res);
      const u = users.get(uid);
      if (!u || !u.station) return json(res, 401, { error: 'not-joined' });
      const body = await readBody(req);
      const cur = presence.get(uid) || { state: 'idle', endsAt: 0 };
      const state = body.state === 'focusing' && u.currentFocus ? 'focusing' : (body.state || cur.state);
      presence.set(uid, {
        state,
        endsAt: state === 'focusing' ? (u.currentFocus ? u.currentFocus.endsAt : cur.endsAt) : 0,
        updatedAt: Date.now(),
      });
      return json(res, 200, { ok: true });
    }

    // ---- 摸一下
    if (p === '/api/pat' && req.method === 'POST') {
      const uid = getUid(req, res);
      const u = users.get(uid);
      if (!u || !u.station) return json(res, 401, { error: 'not-joined' });
      const body = await readBody(req);
      const target = String(body.target || '');
      const tu = users.get(target);
      if (!tu || tu.station !== u.station) return json(res, 404, { error: 'no-user' });
      const today = dayKey();
      u.pats = u.pats || {};
      if (u.pats[target] === today) return json(res, 429, { error: 'already', message: '今天已经摸过了' });
      u.pats[target] = today;
      await writeJson(path.join(US_DIR, `${uid}.json`), u);
      const st = stations.get(u.station);
      if (st) pushFeed(st, `${u.name} 摸了一下 ${tu.name} 的猪`);
      return json(res, 200, { ok: true });
    }

    // ---- SSE
    if (p === '/api/stream') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      if (!stations.has(code)) return json(res, 404, { error: 'no-station' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...CORS,
      });
      res.write('retry: 3000\n\n');
      if (!clients.has(code)) clients.set(code, new Set());
      clients.get(code).add(res);
      req.on('close', () => { clients.get(code)?.delete(res); });
      return;
    }

    // ---- 图片
    if (p.startsWith('/img/')) {
      const id = parseInt(p.slice(5).replace(/\.jpg$/, ''), 10);
      const file = path.join(IMG_DIR, `${id}.jpg`);
      if (!Number.isFinite(id) || !file.startsWith(IMG_DIR)) return json(res, 400, { error: 'bad' });
      try {
        const buf = await fsp.readFile(file);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=604800',
        });
        return res.end(buf);
      } catch { return json(res, 404, { error: 'no-image' }); }
    }

    // ---- 静态
    if (req.method === 'GET') {
      let rel = p === '/' ? 'index.html' : p.slice(1);
      const file = path.join(__dirname, 'public', rel);
      if (!file.startsWith(path.join(__dirname, 'public'))) return json(res, 403, { error: 'no' });
      try {
        const buf = await fsp.readFile(file);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
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

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  await fsp.mkdir(IMG_DIR, { recursive: true });
  await fsp.mkdir(ST_DIR, { recursive: true });
  await fsp.mkdir(US_DIR, { recursive: true });

  // 载入已有的站与用户
  for (const f of await fsp.readdir(ST_DIR).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const st = await readJson(path.join(ST_DIR, f), null);
    if (st && st.code) stations.set(st.code, st);
  }
  for (const f of await fsp.readdir(US_DIR).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const u = await readJson(path.join(US_DIR, f), null);
    if (u && u.uid) users.set(u.uid, u);
  }
  console.log(`[boot] ${stations.size} 个站 / ${users.size} 个人`);

  await loadCards();

  server.listen(PORT, HOST, () => {
    console.log(`余烬猪圈 → http://${HOST}:${PORT}`);
  });
}

boot();
