'use strict';
/* 本地演示用：造一个有内容的账号（卡、券、种子、植物、待办、专注记录、起床睡觉）。
   需要服务器以 FOCUS_MINUTES=25,45,0.05 启动。 */
const BASE = process.env.BASE || 'http://127.0.0.1:3701';
const NAME = process.env.NAME || '米拉';
let tok = '';

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-Pig-Uid': tok } : {}) },
    body: JSON.stringify(body || {}),
  });
  let j; try { j = await r.json(); } catch { j = {}; }
  if (j.uid) tok = j.uid;
  return { status: r.status, body: j };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await post('/api/login', { name: NAME });
  if (login.status !== 200) throw new Error('login ' + JSON.stringify(login.body));
  console.log('登录', login.body.name, '开发者', login.body.me.admin, '站码', login.body.code);

  await post('/api/admin/grant', { target: tok, tickets: 5 });
  let draws = 0;
  for (let i = 0; i < 6; i++) { const d = await post('/api/draw'); if (d.status === 200) draws++; }
  console.log('抽了', draws, '次');

  for (let i = 0; i < 3; i++) {
    const s = await post('/api/focus/start', { minutes: 0.05 });
    if (s.status !== 200) { console.log('专注开始失败', s.body.message); break; }
    await wait(3300);
    const e = await post('/api/focus/end');
    console.log('专注', e.body.status, '券 +', e.body.granted, '种子', e.body.seed && e.body.seed.name);
    await post('/api/break/end');
  }
  const me = await post('/api/me');
  for (const s of me.body.seeds) {
    const p = await post('/api/plant', { id: s.id, x: 0.12 + Math.random() * 0.76 });
    if (p.status !== 200) console.log('种不了', p.body.message);
  }
  await post('/api/admin/grant', { target: tok, seeds: 3 });

  for (const [text, done] of [['背 50 个单词', 1], ['写周报', 1], ['给花浇水', 0], ['读一章书', 0]]) {
    const a = await post('/api/todo', { text });
    if (done) await post('/api/todo/done', { id: a.body.todo.id });
  }
  await post('/api/daycheck', { kind: 'wake' });
  console.log('完成。种子', (await post('/api/me')).body.seeds.length);
})().catch((e) => { console.error(e.message); process.exit(1); });
