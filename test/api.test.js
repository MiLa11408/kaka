'use strict';
/**
 * 集成测试：起一个真的服务器，用真的 HTTP 打它。
 * 覆盖：登录 / 抽卡 / 专注 / 休息 / 待办 / 植物 / 起床睡觉 / 统计 / 管理员 / 权限
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3711;
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;
let dataDir = null;
let seq = 0;

function client(token) {
  let tok = token;
  return async (p, body) => {
    const res = await fetch(BASE + p, {
      method: body === 'GET' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-Pig-Uid': tok } : {}) },
      body: body === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    let j;
    try { j = await res.json(); } catch { j = {}; }
    if (j.uid) tok = j.uid;
    return { status: res.status, body: j };
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 第一个注册的账号是开发者；测试里所有「找人要东西」都找他
async function boss() {
  const c = client();
  const j = await c('/api/login', { name: '甲1' });
  if (!j.body.me.admin) throw new Error('甲1 应该是开发者');
  return c;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhuxuexi-test-'));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, FOCUS_MINUTES: '25,45,0.05', ADMIN_NAME: '甲1', DAYCHECK_FREE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(BASE + '/api/health'); if ((await r.json()).cards > 0) return; } catch { /* 还没起 */ }
    await wait(100);
  }
  throw new Error('服务器没有在 20 秒内起来\n' + out);
});

after(() => {
  if (child) child.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ 登录 */

test('登录：新名字 → 建账号、建站、第一个注册的人是开发者', async () => {
  const c = client();
  const r = await c('/api/login', { name: `甲${++seq}` });
  assert.equal(r.status, 200);
  assert.equal(r.body.isNew, true);
  assert.ok(r.body.uid);
  assert.equal(r.body.me.admin, true);
  assert.ok(r.body.code.length === 6);
});

test('登录：同名 → 进同一个账号，不新建', async () => {
  const n = `乙${++seq}`;
  const a = await client()('/api/login', { name: n });
  const b = await client()('/api/login', { name: n });
  assert.equal(b.body.uid, a.body.uid);
  assert.equal(b.body.isNew, false);
  assert.equal(b.body.me.admin, false, '第二个注册的不该是开发者');
});

test('登录：换设备只记得名字 → 收集还在', async () => {
  const n = `丙${++seq}`;
  const a = client();
  const j = await a('/api/login', { name: n });
  await a('/api/draw');
  const again = await client()('/api/login', { name: n });        // 全新的客户端，没有 token
  assert.equal(again.body.uid, j.body.uid);
  assert.equal(Object.keys(again.body.me.cards).length, 1, '换设备后抽到的卡还在');
});

test('登录：名字为空被拒', async () => {
  const r = await client()('/api/login', { name: '   ' });
  assert.equal(r.status, 400);
});

test('登录：站码不存在 → 404，且不建站', async () => {
  const r = await client()('/api/login', { name: `丁${++seq}`, code: 'ZZZZZZ' });
  assert.equal(r.status, 404);
});

test('未登录访问受保护接口 → 401', async () => {
  const r = await fetch(BASE + '/api/me');
  assert.equal(r.status, 401);
});

test('凭一个不存在的 token → 401', async () => {
  const r = await fetch(BASE + '/api/me', { headers: { 'X-Pig-Uid': 'u_000000000000000000' } });
  assert.equal(r.status, 401);
});

/* ------------------------------------------------------------------ 抽卡 */

test('抽卡：首次免费；同一天再抽被拒；券为 0', async () => {
  const c = client();
  await c('/api/login', { name: `戊${++seq}` });
  const d = await c('/api/draw');
  assert.equal(d.status, 200);
  assert.equal(d.body.free, true);
  assert.ok(d.body.card.title);
  const d2 = await c('/api/draw');
  assert.equal(d2.status, 402);
  assert.equal((await c('/api/me', 'GET')).body.tickets, 0);
});

test('抽卡：有券 → 扣一张券', async () => {
  const c = client();
  const j = await c('/api/login', { name: `己${++seq}` });
  assert.equal((await c('/api/admin/grant', { target: j.body.uid, tickets: 1 })).status, 403, '普通人不能给自己发券');
  const g = await (await boss())('/api/admin/grant', { target: j.body.uid, tickets: 2 });
  assert.equal(g.body.tickets, 2);
  const d = await c('/api/draw');
  assert.equal(d.status, 200);
  assert.equal(d.body.free, true);
  const d2 = await c('/api/draw');
  assert.equal(d2.status, 200);
  assert.equal(d2.body.free, false);
  assert.equal(d2.body.tickets, 1);
});

/* ------------------------------------------------------------------ 专注 */

test('专注：只能 25 或 45 分钟', async () => {
  const c = client();
  await c('/api/login', { name: `庚${++seq}` });
  assert.equal((await c('/api/focus/start', { minutes: 30 })).status, 400);
});

test('专注：中断不给券；5 分钟内同时长可续上', async () => {
  const c = client();
  await c('/api/login', { name: `辛${++seq}` });
  const s = await c('/api/focus/start', { minutes: 25 });
  assert.equal(s.status, 200);
  const e = await c('/api/focus/end', { abandon: true });
  assert.equal(e.body.settled, false);
  assert.equal(e.body.status, 'aborted');
  assert.equal(e.body.me.tickets, 0);
  assert.equal(e.body.me.seeds.length, 0, '中断不该给种子');

  const s2 = await c('/api/focus/start', { minutes: 25 });
  assert.equal(s2.body.resumed, true);
  assert.equal(s2.body.focus.id, s.body.focus.id, '续上的是同一次');
});

test('专注：到点完成 → 券 +1、种子 +1、站内有记录', async () => {
  const c = client();
  await c('/api/login', { name: `壬${++seq}` });
  const s = await c('/api/focus/start', { minutes: 0.05 });     // 3 秒档，仅测试环境
  assert.equal(s.status, 200);
  assert.equal((await c('/api/focus/start', { minutes: 25 })).status, 409, '专注中不能再开一次');
  await wait(3400);
  const e = await c('/api/focus/end', {});
  assert.equal(e.body.settled, true);
  assert.equal(e.body.granted, 2);
  assert.equal(e.body.me.seeds.length, 1);
  assert.equal(e.body.me.todayFocus.count, 1);
  // 重复结算：不会多发
  const e2 = await c('/api/focus/end');
  assert.equal(e2.body.settled, false);
  assert.equal(e2.body.me.tickets, 2);
});

test('休息：开始后状态是休息中；结束后恢复', async () => {
  const c = client();
  const j = await c('/api/login', { name: `癸${++seq}` });
  await c('/api/break/start', { minutes: 5 });
  const r = await fetch(`${BASE}/api/state?code=${j.body.code}`, { headers: { 'X-Pig-Uid': j.body.uid } });
  const st = await r.json();
  assert.equal(st.members[0].presence.state, 'breaking');
  await c('/api/break/end', {});
  const me = await c('/api/me', 'GET');
  assert.equal(me.body.brk, null);
});

/* ------------------------------------------------------------------ 待办 / 植物 / 起床睡觉 */

test('待办：空文本被拒；完成后给券；每天最多 3 次', async () => {
  const c = client();
  await c('/api/login', { name: `子${++seq}` });
  assert.equal((await c('/api/todo', { text: '  ' })).status, 400);
  let reward = 0;
  for (let i = 0; i < 5; i++) {
    const a = await c('/api/todo', { text: '待办' + i });
    const d = await c('/api/todo/done', { id: a.body.todo.id });
    if (d.body.rewarded) reward++;
    if (i === 0) assert.equal((await c('/api/todo/done', { id: a.body.todo.id })).status, 409, '重复完成被拒');
  }
  assert.equal(reward, 3);
  assert.equal((await c('/api/me', 'GET')).body.tickets, 3);
  assert.equal((await c('/api/todo/del', { id: 'nope' })).body.removed, false);
});

test('植物：没有种子种不了；种下后随时间生长；能拔掉', async () => {
  const c = client();
  const j = await c('/api/login', { name: `丑${++seq}` });
  await (await boss())('/api/admin/grant', { target: j.body.uid, seeds: 2 });
  const me = await c('/api/me', 'GET');
  assert.equal(me.body.seeds.length, 2);
  assert.equal((await c('/api/plant', { id: 'nope' })).status, 404);
  const pl = await c('/api/plant', { id: me.body.seeds[0].id, x: 0.5 });
  assert.equal(pl.status, 200);
  assert.ok(pl.body.plant.growth >= 0 && pl.body.plant.growth < 0.01);
  assert.equal(pl.body.me.seeds.length, 1);
  await wait(1200);
  const me2 = await c('/api/me', 'GET');
  assert.ok(me2.body.plants[0].growth > pl.body.plant.growth, '应该长了一点');
  await c('/api/plant/remove', { id: pl.body.plant.id });
  assert.equal((await c('/api/me', 'GET')).body.plants.length, 0);
});

test('起床睡觉：各只能打一次；凌晨 6 点前的睡觉算前一天', async () => {
  const c = client();
  await c('/api/login', { name: `寅${++seq}` });
  assert.equal((await c('/api/daycheck', { kind: 'nap' })).status, 400);
  const w = await c('/api/daycheck', { kind: 'wake' });
  assert.equal(w.status, 200);
  assert.equal((await c('/api/daycheck', { kind: 'wake' })).status, 409);
  assert.ok(w.body.me.wake > 0);
  const s = await c('/api/daycheck', { kind: 'sleep' });
  assert.equal(s.status, 200);
  assert.equal((await c('/api/daycheck', { kind: 'sleep' })).status, 409);
  // 凌晨 6 点前打的睡觉卡归到前一天
  const dayKey = (ts) => new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);
  const hour = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  assert.equal(s.body.day, dayKey(hour < 6 ? Date.now() - 86400000 : Date.now()));
});

/* ------------------------------------------------------------------ 头像 / 统计 / 管理 */

test('头像：只能选自己抽到的卡', async () => {
  const c = client();
  await c('/api/login', { name: `卯${++seq}` });
  assert.equal((await c('/api/avatar', { cardId: 999999 })).status, 404);
  const d = await c('/api/draw');
  const a = await c('/api/avatar', { cardId: d.body.card.id });
  assert.equal(a.body.me.avatar, d.body.card.id);
});

test('统计：返回累计、今日、近 14 天、小时分布', async () => {
  const c = client();
  await c('/api/login', { name: `辰${++seq}` });
  await c('/api/focus/start', { minutes: 0.05 });
  await wait(3400);
  await c('/api/focus/end', {});
  const r = await c('/api/stats', 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.body.total.count, 1);
  assert.equal(r.body.today.count, 1);
  assert.equal(r.body.perDay.length, 14);
  assert.equal(r.body.hourHist.length, 24);
});

test('管理员：普通人进不去；开发者能看全员、开关功能', async () => {
  const normal = client();
  await normal('/api/login', { name: `巳${++seq}` });
  assert.equal((await normal('/api/admin/overview')).status, 403);

  const admin = await boss();                                   // 开发者只来自 ADMIN_NAME 白名单
  assert.equal((await admin('/api/me', 'GET')).body.admin, true);
  const other = client();
  const j = await other('/api/login', { name: `午${++seq}` });
  assert.equal((await admin('/api/admin/addadmin', { target: j.body.uid })).status, 403, '不允许界面授予开发者');
  assert.equal((await other('/api/admin/overview')).status, 403);

  const ov = await admin('/api/admin/overview', 'GET');
  assert.equal(ov.status, 200);
  assert.ok(ov.body.accounts.length >= 2);
  const f = await admin('/api/admin/flags', { key: 'pat', value: false });
  assert.equal(f.body.flags.pat, false);
  assert.equal((await normal('/api/pat', { target: j.body.uid })).status, 403, '功能关掉后接口拒绝');
  await admin('/api/admin/flags', { key: 'pat', value: true });
  assert.equal((await admin('/api/admin/flags', { key: 'nope', value: true })).status, 400);
});
