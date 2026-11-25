'use strict';
/**
 * 集成测试：起一个真的服务器，用真的 HTTP 打它。
 * 模拟逻辑没有抽成纯函数，与其重构冒风险，不如直接测行为。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3711;
const BASE = `http://127.0.0.1:${PORT}`;
const UID = 'a1b2c3d4e5f60718293a4b5c';
let child = null;
let dataDir = null;

function api(p, opts = {}) {
  return fetch(BASE + p, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Ember-Uid': UID,
      ...(opts.headers || {}),
    },
  });
}
const getState = async () => (await api('/api/state')).json();
const act = async (body) => (await api('/api/act', { method: 'POST', body: JSON.stringify(body) })).json();

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-test-'));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      WORLD_SPEED: '400',   // 一个世界日 ≈ 3.6 秒，方便看生长
      TICK_MS: '250',       // 模拟步长压到 250ms，测试不用干等
      SILENCE_MS: '600',    // 无人花阈值压到 600ms
      SAVE_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  // 等端口起来
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return;
    } catch (_) { /* 还没起 */ }
    await wait(100);
  }
  throw new Error('服务器没有在 6 秒内起来');
});

after(() => {
  if (child) child.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('health 无鉴权可访问', async () => {
  const r = await fetch(BASE + '/api/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(typeof j.day === 'number');
});

test('state 结构完整', async () => {
  const s = await getState();
  for (const k of ['day', 'clock', 'phase', 'light', 'weather', 'plants', 'lamps', 'words', 'stats']) {
    assert.ok(k in s, '缺少字段 ' + k);
  }
  assert.ok(s.clock.h >= 0 && s.clock.h < 24);
  assert.ok(s.light > 0 && s.light <= 1);
  assert.ok(['clear', 'rain', 'fog', 'aurora', 'still'].includes(s.weather.kind));
});

test('播种：合法物种入库', async () => {
  const r = await act({ type: 'plant', species: 'fern', name: '测试蕨' });
  assert.equal(r.ok, true);
  assert.equal(r.plant.name, '测试蕨');
  const s = await getState();
  const p = s.plants.find((x) => x.id === r.plant.id);
  assert.ok(p, '植物没出现在 state 里');
  assert.equal(p.species, 'fern');
  assert.ok(p.growth >= 0 && p.growth <= 1);
});

test('播种：非法物种回落为苔', async () => {
  const r = await act({ type: 'plant', species: 'dragon', name: '龙' });
  assert.equal(r.ok, true);
  const s = await getState();
  const p = s.plants.find((x) => x.id === r.plant.id);
  assert.equal(p.species, 'moss');
});

test('播种：无人花种不出来', async () => {
  const r = await act({ type: 'plant', species: 'veil', name: '作弊' });
  assert.equal(r.ok, true);
  const s = await getState();
  const p = s.plants.find((x) => x.id === r.plant.id);
  assert.notEqual(p.species, 'veil', 'veil 不应该能被玩家种下');
});

test('植物会生长', async () => {
  const r = await act({ type: 'plant', species: 'vine', name: '生长测试' });
  const before = (await getState()).plants.find((x) => x.id === r.plant.id).growth;
  await wait(1200);
  const after = (await getState()).plants.find((x) => x.id === r.plant.id).growth;
  assert.ok(after > before, `应该长大：${before} -> ${after}`);
});

test('浇水：水分上升', async () => {
  const r = await act({ type: 'plant', species: 'fern', name: '口渴' });
  const p0 = (await getState()).plants.find((x) => x.id === r.plant.id);
  const w0 = p0.water;
  const w = await act({ type: 'water', id: r.plant.id });
  assert.equal(w.ok, true);
  const p1 = (await getState()).plants.find((x) => x.id === r.plant.id);
  assert.ok(p1.water >= w0, '浇水后不应该更干');
});

test('浇水：不存在的植物 404', async () => {
  const r = await api('/api/act', { method: 'POST', body: JSON.stringify({ type: 'water', id: 999999 }) });
  assert.equal(r.status, 404);
});

test('留言：变成星，超长被截断', async () => {
  const long = '很长'.repeat(40);
  const r = await act({ type: 'word', text: long });
  assert.equal(r.ok, true);
  const s = await getState();
  const w = s.words.find((x) => x.id === r.word.id);
  assert.ok(w, '星没有出现');
  assert.ok(w.text.length <= 40, '应该截断到 40 字，实际 ' + w.text.length);
});

test('留言：空文本被拒', async () => {
  const r = await api('/api/act', { method: 'POST', body: JSON.stringify({ type: 'word', text: '   ' }) });
  assert.equal(r.status, 400);
});

test('点灯：灯会熄灭', async () => {
  const r = await act({ type: 'light', x: 0.5 });
  assert.equal(r.ok, true);
  const s = await getState();
  const lamp = s.lamps[s.lamps.length - 1];
  assert.ok(lamp && lamp.intensity > 0);
  await wait(1600);
  const s2 = await getState();
  const after = s2.lamps.find((x) => x.id === lamp.id);
  // 要么变暗，要么已经烧完被移出列表
  assert.ok(!after || after.intensity < lamp.intensity, '灯应该越来越暗');
});

test('签到：第一次是新签到，同一天再访问不算', async () => {
  const a = await (await api('/api/visit', { method: 'POST', body: '{}' })).json();
  assert.equal(a.recap.checkinNew, true);
  assert.equal(a.state.you.streak, 1);

  const b = await (await api('/api/visit', { method: 'POST', body: '{}' })).json();
  assert.equal(b.recap.checkinNew, false, '同一天第二次不应该算新签到');
  assert.equal(b.state.you.streak, 1);
});

test('身份：X-Ember-Uid 生效且互相隔离', async () => {
  const other = 'ffffffffffffffffffffffff';
  const r = await fetch(BASE + '/api/visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ember-Uid': other },
    body: JSON.stringify({ name: '另一个人' }),
  });
  const j = await r.json();
  assert.equal(j.state.you.name, '另一个人');
  assert.equal(j.recap.checkinNew, true, '不同 uid 应该是独立签到');
});

test('日志：倒序且可限条数', async () => {
  const j = await (await api('/api/chronicle?limit=3')).json();
  assert.ok(Array.isArray(j.entries));
  assert.ok(j.entries.length <= 3);
  for (let i = 1; i < j.entries.length; i++) {
    assert.ok(j.entries[i - 1].t >= j.entries[i].t, '应该按时间倒序');
  }
});

test('静态资源：路径穿越被挡', async () => {
  const r = await fetch(BASE + '/../server.js');
  assert.ok(r.status === 403 || r.status === 404, '不应该读到 server.js，实际 ' + r.status);
});

test('CORS 预检返回 204 且允许自定义头', async () => {
  const r = await fetch(BASE + '/api/act', {
    method: 'OPTIONS',
    headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-headers') || '', /X-Ember-Uid/i);
});

test('无人花：长时间无人自己长出来', async () => {
  // 测试环境把静默阈值压到 600ms，等两秒不给它任何访客
  await wait(2200);
  const s = await getState();
  const veil = s.plants.find((p) => p.species === 'veil');
  assert.ok(veil, '静默超过阈值应该长出无人花');
  assert.ok(veil.note && veil.note.length > 10, '无人花应该带一段话');
});

test('限流：超过 40 次动作被挡', async () => {
  let hit429 = false;
  for (let i = 0; i < 48; i++) {
    const r = await api('/api/act', { method: 'POST', body: JSON.stringify({ type: 'light', x: 0.3 }) });
    if (r.status === 429) { hit429 = true; break; }
  }
  assert.ok(hit429, '连续动作应该触发 429');
});
