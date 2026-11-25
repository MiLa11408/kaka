'use strict';
/**
 * 余烬 · EMBER
 * 一个常驻服务器的小世界。它不等你，自己生长、自己记录。
 * 零依赖，只用 Node 标准库。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3600', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const WORLD_FILE = path.join(DATA_DIR, 'world.json');
const CHRONICLE_FILE = path.join(DATA_DIR, 'chronicle.jsonl');

const TICK_MS = parseInt(process.env.TICK_MS || '5000', 10); // 模拟步长
const WORLD_MIN_PER_SEC = parseFloat(process.env.WORLD_SPEED || '0.0667'); // 一个世界日 = 6 小时
const SAVE_MS = parseInt(process.env.SAVE_MS || '20000', 10);

// ---------------------------------------------------------------- 工具
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const nowISO = () => new Date().toISOString();

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}

// ---------------------------------------------------------------- 状态
const SPECIES = {
  moss:     { label: '苔',     growthRate: 0.00018, waterUse: 0.000035, lightNeed: 0.10, hardiness: 1.8, glow: 0 },
  fern:     { label: '蕨',     growthRate: 0.00028, waterUse: 0.000050, lightNeed: 0.25, hardiness: 1.0, glow: 0 },
  lantern:  { label: '灯芯花', growthRate: 0.00022, waterUse: 0.000062, lightNeed: 0.42, hardiness: 0.7, glow: 1 },
  vine:     { label: '藤',     growthRate: 0.00036, waterUse: 0.000075, lightNeed: 0.20, hardiness: 0.85, glow: 0 },
  crystal:  { label: '晶簇',   growthRate: 0.00012, waterUse: 0.000000, lightNeed: 0.00, hardiness: 2.6, glow: 1 },
  // 无人花：不由玩家种下。只有在长时间没有访客时，自己从土里长出来。
  veil:     { label: '无人花', growthRate: 0.00090, waterUse: 0.000000, lightNeed: 0.00, hardiness: 3.0, glow: 1, secret: 1 },
};
const SPECIES_KEYS = Object.keys(SPECIES).filter(k => !SPECIES[k].secret);

const SYL_A = ['霜', '苔', '灯', '夜', '潮', '灰', '雾', '星', '锈', '寂', '焰', '砂', '霭', '末'];
const SYL_B = ['生', '眠', '行', '叶', '语', '子', '河', '原', '序', '铃', '壳', '芽'];

function freshWorld() {
  return {
    version: 3,
    startedAt: Date.now(),
    lastTickAt: Date.now(),
    worldMinutes: 6 * 60,          // 从清晨开始
    day: 1,
    weather: {
      kind: 'clear',               // clear | rain | fog | aurora | still
      temp: 12,
      humidity: 0.55,
      wind: 0.2,
      since: Date.now(),
      note: '站内一切正常。',
    },
    plants: [],
    lamps: [],
    words: [],
    visitors: {},
    lastVisitorAt: Date.now(),
    silenceFrom: Date.now(),
    log: [],
    stats: {
      visitors: 0, plants: 0, sprouts: 0, deaths: 0, lamps: 0, words: 0,
      rainDays: 0, quietDays: 0, ticks: 0, veils: 0,
    },
    seq: 1,
  };
}

let world = null;

function loadWorld() {
  ensureDir(DATA_DIR);
  try {
    const raw = fs.readFileSync(WORLD_FILE, 'utf8');
    const w = JSON.parse(raw);
    world = Object.assign(freshWorld(), w);
    world.weather = Object.assign({ kind: 'clear', temp: 12, humidity: 0.55, wind: 0.2 }, w.weather || {});
    world.stats = Object.assign(freshWorld().stats, w.stats || {});
    if (!world.lastVisitorAt) world.lastVisitorAt = Date.now();
    // 停机补偿：世界不会因为进程挂了而停下
    const gapMs = Date.now() - (world.lastTickAt || Date.now());
    const gapMin = Math.min(gapMs / 1000 * WORLD_MIN_PER_SEC, 60 * 24 * 7);
    if (gapMin > 5) {
      world.worldMinutes += gapMin;
      pushLog('downtime', `观测中断了 ${fmtDuration(gapMs)}。世界仍在继续，只是没人记录。`);
    }
    console.log('[ember] 世界已载入：第 ' + world.day + ' 天，' + world.plants.length + ' 株植物');
  } catch (e) {
    world = freshWorld();
    pushLog('birth', '观测站通电。第一缕光落在空地上，还没有任何东西生长。');
    console.log('[ember] 新世界已创建');
  }
}

let saveTimer = null;
function saveWorld() {
  ensureDir(DATA_DIR);
  const tmp = WORLD_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(world));
    fs.renameSync(tmp, WORLD_FILE);
  } catch (e) {
    console.error('[ember] 保存失败', e.message);
  }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveWorld(); }, SAVE_MS);
}

// ---------------------------------------------------------------- 日志 / 日记
function pushLog(kind, text, extra) {
  const entry = { id: world ? world.seq++ : 0, t: Date.now(), kind, text, ...(extra || {}) };
  world.log.push(entry);
  if (world.log.length > 400) world.log.splice(0, world.log.length - 400);
  try {
    ensureDir(DATA_DIR);
    fs.appendFileSync(CHRONICLE_FILE, JSON.stringify(entry) + '\n');
  } catch (_) {}
  return entry;
}

function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分';
  const d = Math.floor(h / 24);
  return d + ' 天 ' + (h % 24) + ' 小时';
}

// ---------------------------------------------------------------- 世界时钟
function worldTime() {
  const mins = world.worldMinutes % 1440;
  return { hour: Math.floor(mins / 60), minute: Math.floor(mins % 60), mins, day: world.day };
}

function dayPhase() {
  const h = worldTime().hour;
  if (h < 5) return 'night';
  if (h < 8) return 'dawn';
  if (h < 17) return 'day';
  if (h < 20) return 'dusk';
  return 'night';
}

// 环境光：0（全黑）→ 1（站内白昼）
function ambientLight() {
  const mins = world.worldMinutes % 1440;
  const h = mins / 60;
  // 5:00 起亮，19:30 落
  let v;
  if (h < 4.5) v = 0.06;
  else if (h < 7.5) v = 0.06 + (h - 4.5) / 3 * 0.94;
  else if (h < 17) v = 1.0;
  else if (h < 20) v = 1.0 - (h - 17) / 3 * 0.94;
  else v = 0.06;
  return clamp(v, 0.04, 1);
}

// ---------------------------------------------------------------- 真实负载
let lastCpu = os.cpus().map(c => c.times);
function cpuLoad() {
  const cur = os.cpus().map(c => c.times);
  let idle = 0, total = 0;
  for (let i = 0; i < cur.length; i++) {
    const a = lastCpu[i] || cur[i], b = cur[i];
    const ai = a.idle, bi = b.idle;
    const at = ai + a.user + a.nice + a.sys + a.irq;
    const bt = bi + b.user + b.nice + b.sys + b.irq;
    idle += bi - ai; total += bt - at;
  }
  lastCpu = cur;
  return total > 0 ? clamp(1 - idle / total) : 0;
}

// ---------------------------------------------------------------- 天气
function rollWeather(load, memUsed) {
  const w = world.weather;
  const h = worldTime().hour;
  const night = h < 6 || h > 19;
  const r = Math.random();
  let kind = 'clear';

  if (load > 0.55 && night) kind = 'aurora';
  else if (w.humidity > 0.78 && r < 0.45) kind = 'rain';
  else if (w.humidity > 0.7 && r < 0.6) kind = 'fog';
  else if (load < 0.03 && r < 0.22) kind = 'still';
  else if (r < 0.12) kind = 'fog';

  if (kind !== w.kind) {
    const notes = {
      rain: '落雨。水会自己找到根部。',
      fog: '起了雾，远处的环带只剩一道灰。',
      aurora: '负载升高，天顶浮起极光。',
      still: '一切都太安静了，连风都停了。',
      clear: '云散开，站内恢复平常的光。',
    };
    w.kind = kind;
    w.since = Date.now();
    w.note = notes[kind];
    if (kind === 'rain') world.stats.rainDays++;
    if (kind === 'still') world.stats.quietDays++;
  }

  const targetTemp = (night ? 6 : 17) + (kind === 'rain' ? -3 : 0) + (kind === 'aurora' ? 4 : 0);
  w.temp += (targetTemp - w.temp) * 0.08 + rnd(-0.25, 0.25);
  w.humidity = clamp(w.humidity + (kind === 'rain' ? 0.02 : -0.008) + rnd(-0.012, 0.012), 0.25, 0.95);
  w.wind = clamp(w.wind + rnd(-0.06, 0.06) + (kind === 'aurora' ? 0.05 : 0), 0, 1);
  w.load = load;
  w.mem = memUsed;
}

// ---------------------------------------------------------------- 植物
function newPlant(species, name, by) {
  const sp = SPECIES[species] ? species : 'moss';
  return {
    id: world.seq++,
    species: sp,
    name: name || (pick(SYL_A) + pick(SYL_B)),
    by: by || '无名',
    plantedAt: Date.now(),
    growth: 0.02,
    health: 1,
    water: 0.75,
    x: rnd(0.06, 0.94),
    depth: rnd(0, 1),           // 前后景
    seed: Math.random(),
    alive: true,
    diedAt: null,
    lastWord: null,
  };
}

function tickPlants(dtMin, light, weather) {
  const rain = weather.kind === 'rain';
  for (const p of world.plants) {
    if (!p.alive) continue;
    const sp = SPECIES[p.species];

    // 水分：蒸发；下雨补给
    p.water = clamp(p.water - sp.waterUse * dtMin * (0.6 + (1 - weather.humidity) * 1.2));
    if (rain) p.water = clamp(p.water + 0.004 * dtMin);

    // 光：站内环境光 + 访客的灯
    const lampLight = world.lamps.reduce((a, l) => a + Math.max(0, 1 - Math.abs(l.x - p.x) * 2.2) * l.intensity * 0.35, 0);
    const effLight = clamp(light * 0.8 + lampLight, 0, 1.4);

    // 生长
    const lightOk = sp.lightNeed === 0 ? 1 : clamp(effLight / sp.lightNeed, 0, 1.25);
    const waterOk = clamp(p.water * 2.2, 0, 1);
    const gain = sp.growthRate * dtMin * lightOk * waterOk * (0.35 + p.health * 0.65);
    p.growth = clamp(p.growth + gain, 0, 1);

    // 无人花：有人来了就开始谢
    if (p.species === 'veil'){
      const silence = Date.now() - (world.lastVisitorAt || Date.now());
      if (silence < 20 * 60 * 1000){
        p.health = clamp(p.health - dtMin * 0.0022);
        if (p.health <= 0.02){
          p.alive = false; p.diedAt = Date.now(); world.stats.deaths++;
          pushLog('veil', `「${p.name}」合上了。有人回来，它就不必再开着。`);
          continue;
        }
      }
      p.growth = clamp(p.growth + sp.growthRate * dtMin * 0.55);
      if (!p.matured && p.growth >= 0.999){
        p.matured = true;
        pushLog('veil', `土里长出了一株不在图鉴里的东西。它只在没有人看的时候开。`);
      }
      continue;
    }

    // 健康：缺水 / 缺光 会掉，硬朗的物种掉得慢
    let stress = 0;
    if (p.water < 0.25) stress += (0.25 - p.water) * 0.0004;
    if (sp.lightNeed > 0.3 && lightOk < 0.3) stress += 0.00003;
    if (weather.kind === 'fog') stress += 0.000008;
    if (weather.kind === 'aurora') stress -= 0.00002;
    p.health = clamp(p.health - (stress / sp.hardiness) * dtMin);

    // 成熟
    if (!p.matured && p.growth >= 0.999) {
      p.matured = true;
      pushLog('mature', `「${p.name}」长成了。` + (p.species === 'lantern'
        ? pick(['它开始发光，像一枚被留在土里的灯。', '花苞亮了，光很淡，但确实在亮。'])
        : pick(['没有人特意照顾它，但它自己走到了这一步。', '它到了自己该有的高度，然后停住了。',
                '从种子算起，它用了很久。现在它站在这里。', '它长成了。之后只会慢慢地站着。'])));
    }
    // 死亡
    if (p.health <= 0.02) {
      p.alive = false;
      p.diedAt = Date.now();
      world.stats.deaths++;
      pushLog('death', `「${p.name}」枯了。${p.water < 0.2 ? '它最后缺水，' : ''}${p.growth > 0.7 ? '已经长得很高了，' : ''}第 ${world.day} 天。`);
    }
  }
}

function tickLamps(dtMin) {
  for (const l of world.lamps) {
    l.intensity = clamp(l.intensity - 0.00055 * dtMin);
    l.age = (l.age || 0) + dtMin;
  }
  const before = world.lamps.length;
  world.lamps = world.lamps.filter(l => l.intensity > 0.02);
  if (before !== world.lamps.length && world.lamps.length === 0) {
    pushLog('dark', '最后一盏灯熄了。站内只剩环境光。');
  }
}

// ---------------------------------------------------------------- 日记文本
function composeDawn() {
  const t = worldTime();
  const alive = world.plants.filter(p => p.alive);
  const mature = alive.filter(p => p.growth > 0.9).length;
  const total = world.plants.length;
  const w = world.weather;
  const who = Object.values(world.visitors);
  const recent = who.filter(v => Date.now() - v.lastSeen < 3600e3 * 6);

  const head = pick([
    `第 ${world.day} 天，${t.hour} 点。`,
    `天亮了。这是第 ${world.day} 天。`,
    `第 ${world.day} 天，站内温度 ${Math.round(w.temp)} 度。`,
  ]);

  const weatherLine = {
    clear: pick(['天空是干净的灰蓝色。', '没有云，光很平。', '能看见环带的影子落在地上。']),
    rain: pick(['雨还没停。', '雨声盖住了别的所有声音。', '地面吸饱了水，颜色变深。']),
    fog: pick(['雾把远处抹掉了。', '雾很厚，只能看见脚下。', '雾里有东西在动，也可能是错觉。']),
    aurora: pick(['极光还在。它不该出现在这里，但它出现了。', '天顶的绿光在缓慢地流。']),
    still: pick(['今天安静得反常。', '一点风都没有，尘埃悬在半空。']),
  }[w.kind] || '';

  const plantLine = total === 0
    ? pick(['地上什么都没有。', '还没有任何东西在这里扎根。'])
    : alive.length === 0
      ? `所有植物都不在了，${total} 个位置空着。`
      : pick([
          `${alive.length} 株还活着，其中 ${mature} 株已经长成。`,
          `我数了数，能站着的还有 ${alive.length} 株。`,
          `${alive.length} 株在呼吸。有一株我不太确定还算不算活着。`,
        ]);

  const peopleLine = recent.length === 0
    ? pick(['没有访客。', '昨天没有人来过。', '这里只有我。', '没有人来。土是干的。'])
    : recent.length === 1
      ? pick([`${recent[0].name} 来过一次。`, `${recent[0].name} 站在这里看了很久。`, `只有 ${recent[0].name} 来过。`])
      : pick([
          `${recent.length} 个人路过，${recent[0].name} 待得最久。`,
          `${recent.map(v => v.name).slice(0, 3).join('、')} 来过。`,
          `有人来过，但没有留下话。`,
        ]);

  return `${head}${weatherLine}${plantLine}${peopleLine}`;
}

// ---------------------------------------------------------------- 无人花
const VEIL_NAMES = ['无言', '空室', '长夜', '无人', '留白', '久坐', '未寄', '余温'];
const SILENCE_MS = parseInt(process.env.SILENCE_MS || String(3 * 3600 * 1000), 10); // 3 小时没有访客

function composeVeil(silenceMs) {
  const mins = Math.floor(silenceMs / 60000);
  const alive = world.plants.filter(p => p.alive && p.species !== 'veil').length;
  const head = pick([
    `这里空了 ${fmtDuration(silenceMs)}。`,
    `${fmtDuration(silenceMs)}没有人来过。`,
    `上一次有人站在这里，是 ${fmtDuration(silenceMs)}之前。`,
  ]);
  const mid = pick([
    alive > 0 ? `${alive} 株还站着，没有人给它们浇水，它们也没有死。` : '地上什么都没有，连杂草都没有。',
    alive > 0 ? `我数了 ${alive} 株，它们都还活着，只是长得慢了一点。` : '土是干的，但没有裂开。',
    '灯早就熄了，风还在。',
  ]);
  const tail = pick([
    '所以我长出来了。这不算违规。',
    '没人看的时候，总得有点什么在长。',
    '我知道你还会回来。这株花是给那个时候的你留的。',
    '别难过。空白也是一种记录。',
  ]);
  return head + mid + tail;
}

function maybeSpawnVeil() {
  const silence = Date.now() - (world.lastVisitorAt || Date.now());
  if (silence < SILENCE_MS) return;
  if (world.plants.some(p => p.alive && p.species === 'veil')) return;
  const pl = newPlant('veil', pick(VEIL_NAMES), '无人');
  pl.growth = 0.06;
  pl.water = 1;
  pl.depth = rnd(0.2, 0.8);
  pl.note = composeVeil(silence);
  world.plants.push(pl);
  world.stats.veils++;
  pushLog('veil', `「${pl.name}」在空地里长了出来。${fmtDuration(silence)}没有人来过。`);
}

// ---------------------------------------------------------------- 主循环
let lastTickWall = Date.now();
let lastDawnDay = 0;

function tick() {
  const now = Date.now();
  const dtReal = Math.min((now - lastTickWall) / 1000, 60);
  lastTickWall = now;

  world.worldMinutes += dtReal * WORLD_MIN_PER_SEC;
  world.lastTickAt = now;
  world.stats.ticks++;

  const newDay = Math.floor(world.worldMinutes / 1440) + 1;
  world.day = newDay;
  const minuteOfDay = world.worldMinutes % 1440;

  const load = cpuLoad();
  const memUsed = 1 - os.freemem() / os.totalmem();

  // 每小时掷一次天气
  if (world.stats.ticks % 12 === 0 || !world.weather.load) rollWeather(load, memUsed);
  else { world.weather.load = load; world.weather.mem = memUsed; }

  maybeSpawnVeil();

  const light = ambientLight();
  tickPlants(dtReal * WORLD_MIN_PER_SEC, light, world.weather);
  tickLamps(dtReal * WORLD_MIN_PER_SEC);

  // 每天 6 点写一篇
  if (minuteOfDay >= 360 && lastDawnDay !== newDay) {
    lastDawnDay = newDay;
    pushLog('dawn', composeDawn());
  }

  scheduleSave();
}

// ---------------------------------------------------------------- HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const clients = new Set();

function publicState() {
  const t = worldTime();
  return {
    day: world.day,
    clock: { h: t.hour, m: t.minute, mins: t.mins },
    phase: dayPhase(),
    light: ambientLight(),
    weather: {
      kind: world.weather.kind, temp: Math.round(world.weather.temp * 10) / 10,
      humidity: Math.round(world.weather.humidity * 100), wind: Math.round(world.weather.wind * 100),
      note: world.weather.note, load: Math.round((world.weather.load || 0) * 100),
      mem: Math.round((world.weather.mem || 0) * 100),
    },
    plants: world.plants.map(p => ({
      id: p.id, species: p.species, label: SPECIES[p.species].label, name: p.name,
      by: p.by, growth: Math.round(p.growth * 1000) / 1000, health: Math.round(p.health * 1000) / 1000,
      water: Math.round(p.water * 100) / 100, x: p.x, depth: p.depth, seed: p.seed,
      alive: p.alive, glow: SPECIES[p.species].glow, matured: !!p.matured, note: p.note || null,
      ageMin: Math.round((Date.now() - p.plantedAt) / 60000),
    })),
    lamps: world.lamps.map(l => ({ id: l.id, x: l.x, by: l.by, intensity: Math.round(l.intensity * 100) / 100, seed: l.seed })),
    words: world.words.map(w => ({ id: w.id, text: w.text, by: w.by, t: w.t, x: w.x, y: w.y, mag: w.mag })),
    log: world.log.slice(-40),
    stats: world.stats,
    uptime: process.uptime(),
    online: clients.size,
  };
}

function broadcast() {
  if (!clients.size) return;
  const payload = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function getUid(req, res) {
  const hdr = String(req.headers['x-ember-uid'] || '').trim();
  if (/^[a-f0-9]{16,32}$/.test(hdr)) return hdr;
  const c = parseCookies(req);
  if (c.ember_uid && /^[a-f0-9]{16,32}$/.test(c.ember_uid)) return c.ember_uid;
  const uid = crypto.randomBytes(12).toString('hex');
  res.setHeader('Set-Cookie', `ember_uid=${uid}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return uid;
}

function visitorOf(uid) {
  if (!world.visitors[uid]) {
    world.visitors[uid] = {
      uid, name: '无名', firstSeen: Date.now(), lastSeen: Date.now(),
      visits: 0, lights: 0, plants: 0, words: 0,
      streak: 0, best: 0, lastDay: null, days: 0,
    };
    world.stats.visitors++;
  }
  return world.visitors[uid];
}

// ---------------------------------------------------------------- 签到
const TZ_OFFSET = 8 * 3600 * 1000;
function dayKey(ts) {
  return new Date((ts || Date.now()) + TZ_OFFSET).toISOString().slice(0, 10);
}

function checkIn(v) {
  const today = dayKey();
  if (v.lastDay === today) return { isNew: false, streak: v.streak || 0 };
  const yesterday = dayKey(Date.now() - 86400000);
  const streak = v.lastDay === yesterday ? (v.streak || 0) + 1 : 1;
  v.streak = streak;
  v.best = Math.max(v.best || 0, streak);
  v.lastDay = today;
  v.days = (v.days || 0) + 1;
  return { isNew: true, streak };
}

// 简易限流：每 IP 10 分钟 40 次动作
const rate = new Map();
function allow(ip) {
  const now = Date.now();
  const rec = rate.get(ip) || { t: now, n: 0 };
  if (now - rec.t > 600000) { rec.t = now; rec.n = 0; }
  rec.n++;
  rate.set(ip, rec);
  return rec.n <= 40;
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ember-Uid',
  'Access-Control-Max-Age': '86400',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, CORS));
  res.end(body);
}

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (p === '/api/health') return json(res, 200, { ok: true, day: world.day });

  if (p === '/api/state') {
    getUid(req, res);
    return json(res, 200, publicState());
  }

  if (p === '/api/stream') {
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }, CORS));
    res.write('retry: 3000\n\n');
    res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (p === '/api/chronicle') {
    const limit = clamp(parseInt(u.searchParams.get('limit') || '200', 10) || 200, 1, 400);
    return json(res, 200, { entries: world.log.slice(-limit).reverse() });
  }

  if (p === '/api/visit' && req.method === 'POST') {
    const uid = getUid(req, res);
    const body = await readBody(req).catch(() => ({}));
    const v = visitorOf(uid);
    const gap = Date.now() - v.lastSeen;
    const name = cleanText(body.name, 16);
    if (name) v.name = name;
    v.visits++;
    const since = v.lastSeen;
    v.lastSeen = Date.now();
    world.lastVisitorAt = Date.now();
    const veil = world.plants.find(p => p.alive && p.species === 'veil' && p.matured);
    if (veil) pushLog('veil', `有人回来了。「${veil.name}」开始合上。`);

    // 签到
    const ci = checkIn(v);
    if (ci.isNew){
      if (ci.streak === 1 && v.days > 1) pushLog('checkin', `${v.name} 又回来了。上一次是断的。`);
      else if (ci.streak > 1) pushLog('checkin', `${v.name} 连续第 ${ci.streak} 天到这里。`);
      // 每满 7 天，世界里多一株守夜
      if (ci.streak % 7 === 0){
        const alive = world.plants.filter(x => x.alive).length;
        if (alive < 40){
          const pl = newPlant('lantern', `守夜·${ci.streak}`, v.name);
          pl.growth = 0.35; pl.water = 0.9;
          world.plants.push(pl);
          pushLog('streak', `第 ${ci.streak} 天。土里多了一株「${pl.name}」，是给坚持这件事本身的。`);
        } else {
          pushLog('streak', `第 ${ci.streak} 天。地里满了，这株守夜没有地方站。`);
        }
      }
    }

    const recap = {
      streak: ci.streak,
      checkinNew: ci.isNew,
      gap,
      first: v.visits === 1,
      name: v.name,
      events: world.log.filter(e => e.t > since && e.t < Date.now()).slice(-12),
      newPlants: world.plants.filter(x => x.plantedAt > since).length,
      died: world.plants.filter(x => x.diedAt && x.diedAt > since).length,
      words: world.words.filter(x => x.t > since).length,
      day: world.day,
      visitors: world.stats.visitors,
    };
    if (v.visits === 1 && name) pushLog('first', `有新的观测者接入，自称「${name}」。`);
    scheduleSave();
    const st = publicState();
    st.you = { name: v.name, streak: v.streak, best: v.best, days: v.days, today: ci.isNew };
    return json(res, 200, { ok: true, uid, recap, state: st });
  }

  if (p === '/api/act' && req.method === 'POST') {
    if (!allow(ip)) return json(res, 429, { error: '动作太频繁，等一会儿。' });
    const uid = getUid(req, res);
    const v = visitorOf(uid);
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, 400, { error: 'bad body' });
    const type = body.type;

    if (type === 'light') {
      const x = clamp(Number(body.x) || rnd(0.1, 0.9), 0.02, 0.98);
      world.lamps.push({ id: world.seq++, x, by: v.name, intensity: 1, age: 0, seed: Math.random() });
      if (world.lamps.length > 24) world.lamps.shift();
      world.stats.lamps++;
      v.lights++;
      if (Math.random() < 0.45) {
        pushLog('light', `${v.name} 在 ${x < 0.5 ? '左边' : '右边'}点了一盏灯。${pick(['光很暖。', '它照亮了一小片土。', '植物的影子动了一下。'])}`);
      }
      scheduleSave();
      return json(res, 200, { ok: true, state: publicState() });
    }

    if (type === 'water') {
      const id = Number(body.id);
      const pl = world.plants.find(x => x.id === id && x.alive);
      if (!pl) return json(res, 404, { error: '没有这株植物' });
      pl.water = clamp(pl.water + 0.45);
      pl.health = clamp(pl.health + 0.05);
      if (Math.random() < 0.3) pushLog('water', `${v.name} 给「${pl.name}」浇了水。`);
      scheduleSave();
      return json(res, 200, { ok: true, state: publicState() });
    }

    if (type === 'plant') {
      if (world.plants.filter(x => x.alive).length >= 40) return json(res, 400, { error: '这块地满了。' });
      const sp = SPECIES_KEYS.includes(body.species) ? body.species : 'moss';
      const name = cleanText(body.name, 12) || null;
      const pl = newPlant(sp, name, v.name);
      world.plants.push(pl);
      world.stats.plants++;
      world.stats.sprouts++;
      v.plants++;
      pushLog('plant', `${v.name} 种下了「${pl.name}」（${SPECIES[sp].label}）。${pick(['土很松。', '这里的光刚好。', '种子很小，几乎看不见。'])}`);
      scheduleSave();
      return json(res, 200, { ok: true, plant: { id: pl.id, name: pl.name }, state: publicState() });
    }

    if (type === 'word') {
      const text = cleanText(body.text, 40);
      if (!text) return json(res, 400, { error: '空的' });
      const w = {
        id: world.seq++, text, by: v.name, t: Date.now(),
        x: rnd(0.05, 0.95), y: rnd(0.08, 0.52), mag: rnd(0.6, 1.4),
      };
      world.words.push(w);
      if (world.words.length > 400) world.words.shift();
      world.stats.words++;
      v.words++;
      pushLog('word', `${v.name} 留下一句话：「${text}」它挂在天上，像一颗不太亮的星。`);
      scheduleSave();
      return json(res, 200, { ok: true, word: { id: w.id, text: w.text }, state: publicState() });
    }

    if (type === 'rename') {
      const name = cleanText(body.name, 16);
      if (!name) return json(res, 400, { error: '空的' });
      const old = v.name;
      v.name = name;
      pushLog('rename', `${old} 把名字改成了「${name}」。`);
      scheduleSave();
      return json(res, 200, { ok: true, state: publicState() });
    }

    return json(res, 400, { error: 'unknown type' });
  }

  if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

  serveStatic(req, res, p);
});

// ---------------------------------------------------------------- 启动
loadWorld();
lastTickWall = Date.now();
lastDawnDay = world.day - 1;
setInterval(tick, TICK_MS);
setInterval(broadcast, 5000);

process.on('SIGINT', () => { saveWorld(); process.exit(0); });
process.on('SIGTERM', () => { saveWorld(); process.exit(0); });
process.on('exit', () => { try { saveWorld(); } catch (_) {} });

server.listen(PORT, HOST, () => {
  console.log(`[ember] 世界在 ${HOST}:${PORT} 上运行中 · 第 ${world.day} 天`);
});
