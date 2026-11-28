'use strict';
/* 图鉴 = 小球融合池。
   每次打开，所有球都从一级重新从上面掉下来；
   两颗同级的球碰到一起就合成高一级（lv1+lv1=lv2，lv2+lv2=lv3），
   等级越高越大越重，也越难被丢起来。 */

const BALL_MAX_LEVEL = 6;

class BallPit {
  constructor(canvas, urlOf) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.urlOf = urlOf;
    this.balls = [];
    this.imgs = new Map();
    this.running = false;
    this.drag = null;
    this.onTap = null;
    this.last = 0;
    this.raf = 0;

    this.cv.style.touchAction = 'none';
    this.cv.addEventListener('pointerdown', (e) => this.down(e));
    this.cv.addEventListener('pointermove', (e) => this.move(e));
    this.cv.addEventListener('pointerup', (e) => this.up(e));
    this.cv.addEventListener('pointercancel', () => { this.drag = null; });
  }

  /* 等级 → 半径。1 级约 20px，6 级约 70px */
  static radius(level) { return Math.min(72, 11 * Math.pow(Math.max(1, level), 1.18)); }
  static mass(level) { return Math.pow(level, 1.6); }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.W = this.cv.clientWidth;
    this.H = this.cv.clientHeight;
    this.cv.width = Math.round(this.W * dpr);
    this.cv.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.floor = this.H - 24;
    this.fit();
  }

  fit() {
    if (!this.W) return;
    const usable = this.W * Math.max(120, this.floor - 90) * 0.42;
    const total = this.balls.reduce((a, b) => a + Math.PI * b.r0 * b.r0, 0);
    const k = total > usable ? Math.sqrt(usable / total) : 1;
    for (const b of this.balls) b.r = Math.max(9, b.r0 * k);
  }

  setItems(items) {
    const have = new Set(this.balls.map((b) => b.id));
    items.forEach((it, i) => {
      const b = this.balls.find((x) => x.id === it.id);
      if (!b) {
        const r0 = BallPit.radius(1);
        this.balls.push({
          id: it.id, cardId: it.id, level: 1, r0, r: r0,
          x: 20 + Math.random() * Math.max(40, this.W - 40),
          y: -r0 - Math.random() * 700 - i * 6,
          vx: (Math.random() - 0.5) * 100, vy: 0, born: performance.now(),
          ...it,
        });
        if (!this.imgs.has(it.id)) {
          const img = new Image();
          img.src = this.urlOf(it.id);
          this.imgs.set(it.id, img);
        }
      } else {
        b.title = it.title; b.rarity = it.rarity;
        b.count = it.count;
      }
    });
    const keep = new Set(items.map((it) => it.id));
    this.balls = this.balls.filter((b) => keep.has(b.id));
    this.fit();
  }

  /* 重新开始：所有球回到一级，从上方落下 */
  reset() {
    for (const b of this.balls) {
      b.level = 1; b.r0 = BallPit.radius(1);
      b.x = 20 + Math.random() * Math.max(40, this.W - 40);
      b.y = -b.r0 - Math.random() * 900;
      b.vx = (Math.random() - 0.5) * 100; b.vy = 0;
      b.born = performance.now();
    }
    this.fit();
  }

  /* ---------------- 物理 ---------------- */

  step(dt) {
    const G = 2500;
    for (const b of this.balls) {
      if (b === (this.drag && this.drag.b)) continue;
      b.vy += G * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const e = 0.26;
      if (b.y + b.r > this.floor) {
        b.y = this.floor - b.r;
        b.vy = Math.abs(b.vy) > 70 ? -b.vy * e : 0;
        b.vx *= 0.9;
      }
      if (b.y - b.r < -1000) { b.y = -1000 + b.r; b.vy = 0; }
      if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx) * e; }
      if (b.x + b.r > this.W) { b.x = this.W - b.r; b.vx = -Math.abs(b.vx) * e; }
    }

    // 球与球：推开 + 换一点速度。多迭代几次，堆起来才稳
    const n = this.balls.length;
    for (let it = 0; it < 5; it++) {
      for (let i = 0; i < n; i++) {
        const a = this.balls[i];
        if (!a) continue;
        for (let j = i + 1; j < n; j++) {
          const c = this.balls[j];
          if (!c) continue;
          const dx = c.x - a.x, dy = c.y - a.y;
          const min = a.r + c.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2) || 0.01;
          const nx = dx / d, ny = dy / d;
          const over = min - d;
          const ma = a.r * a.r, mc = c.r * c.r;
          const wa = mc / (ma + mc), wc = ma / (ma + mc);
          const aHeld = a === (this.drag && this.drag.b), cHeld = c === (this.drag && this.drag.b);
          a.x -= nx * over * wa * (aHeld ? 0 : 1); a.y -= ny * over * wa * (aHeld ? 0 : 1);
          c.x += nx * over * wc * (cHeld ? 0 : 1); c.y += ny * over * wc * (cHeld ? 0 : 1);
          const rvn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
          if (rvn < 0) {
            const jimp = -(1 + 0.08) * rvn / (1 / ma + 1 / mc);
            a.vx -= (jimp * nx) / ma; a.vy -= (jimp * ny) / ma;
            c.vx += (jimp * nx) / mc; c.vy += (jimp * ny) / mc;
          }
        }
      }
    }

    this.mergePass();
  }

  /* 同级相撞 → 合成高一级 */
  mergePass() {
    if (this.drag) return;                       // 手在拖的时候不融合，避免误触
    const now = performance.now();
    const n = this.balls.length;
    const dead = new Set();
    for (let i = 0; i < n; i++) {
      const a = this.balls[i];
      if (!a || dead.has(a)) continue;
      if (a.level >= BALL_MAX_LEVEL) continue;
      if (a.noMergeUntil > now) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.balls[j];
        if (!b || dead.has(b)) continue;
        if (b.level !== a.level) continue;
        if (b.noMergeUntil > now) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const touch = a.r + b.r;                 // 真正贴上就融合
        if (dx * dx + dy * dy > touch * touch) continue;
        // 合成到 b 上
        b.level += 1;
        b.r0 = BallPit.radius(b.level);
        b.r = b.r0;
        b.x = (a.x + b.x) / 2;
        b.y = (a.y + b.y) / 2 - 4;
        b.vx = (a.vx + b.vx) * 0.5;
        b.vy = Math.min((a.vy + b.vy) * 0.5, 0) - 160;
        b.popAt = now;
        b.noMergeUntil = now + 450;              // 刚合成先别继续连锁
        dead.add(a);
        break;
      }
    }
    if (dead.size) {
      this.balls = this.balls.filter((b) => !dead.has(b));
      this.fit();
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    const ring = { common: 'rgba(255,255,255,.9)', rare: '#5aaef5', legend: '#ffcf4d' };
    for (const b of this.balls) {
      if (b.rarity === 'rare' || b.rarity === 'legend') {
        const g = ctx.createRadialGradient(b.x, b.y, b.r * 0.55, b.x, b.y, b.r * 1.95);
        const col = b.rarity === 'legend' ? '255,207,77' : '90,174,245';
        g.addColorStop(0, `rgba(${col},0.30)`);
        g.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 1.95, 0, 6.2832); ctx.fill();
      }
      if (b.born) {
        const age = performance.now() - b.born;
        if (age < 1100) {
          const k = age / 1100;
          ctx.save(); ctx.globalAlpha = (1 - k) * 0.8; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r * (1 + k * 1.1), 0, 6.2832); ctx.stroke(); ctx.restore();
        } else { b.born = 0; }
      }
      if (b.popAt) {
        const age = performance.now() - b.popAt;
        if (age < 500) {
          const k = age / 500;
          ctx.save(); ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = '#ffe27a'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r * (1 + k * 0.7), 0, 6.2832); ctx.stroke(); ctx.restore();
        } else { b.popAt = 0; }
      }

      ctx.save();
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.2832); ctx.closePath();
      ctx.fillStyle = '#ffe3ec'; ctx.fill();
      ctx.clip();
      const img = this.imgs.get(b.cardId || b.id);
      if (img && img.complete && img.naturalWidth) {
        const s = Math.max((b.r * 2) / img.naturalWidth, (b.r * 2) / img.naturalHeight);
        const w = img.naturalWidth * s, h = img.naturalHeight * s;
        ctx.drawImage(img, b.x - w / 2, b.y - h / 2, w, h);
      }
      ctx.restore();
      ctx.lineWidth = Math.max(2, b.r * 0.09);
      ctx.strokeStyle = ring[b.rarity] || ring.common;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r - ctx.lineWidth / 2 + 0.5, 0, 6.2832); ctx.stroke();

      // 等级角标
      const badge = 'Lv' + b.level;
      const br = Math.max(9, b.r * 0.26);
      ctx.fillStyle = b.level >= BALL_MAX_LEVEL ? '#ffcf4d' : 'rgba(255,255,255,.92)';
      ctx.beginPath(); ctx.arc(b.x + b.r * 0.68, b.y - b.r * 0.68, br, 0, 6.2832); ctx.fill();
      ctx.fillStyle = b.level >= BALL_MAX_LEVEL ? '#5b4300' : '#7b5a6a';
      ctx.font = `800 ${Math.max(8, br * 0.95)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(badge, b.x + b.r * 0.68, b.y - b.r * 0.66);

      if (b.r > 34) {
        ctx.fillStyle = 'rgba(255,255,255,.92)';
        ctx.font = '700 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const t = b.title || '';
        ctx.fillText(t.length > 6 ? t.slice(0, 6) + '…' : t, b.x, b.y + b.r - 11);
      }
    }
  }

  loop = (ts) => {
    if (!this.running) return;
    const dt = Math.min(1 / 30, (ts - this.last) / 1000 || 1 / 60);
    this.last = ts;
    this.step(dt / 2); this.step(dt / 2);
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  open() {
    this.resize();
    this.running = true;
    this.last = 0;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
  }
  close() { this.running = false; cancelAnimationFrame(this.raf); }

  /* ---------------- 手指 ---------------- */

  hit(x, y) {
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      const dx = x - b.x, dy = y - b.y;
      if (dx * dx + dy * dy <= (b.r + 10) * (b.r + 10)) return b;
    }
    return null;
  }
  pos(e) {
    const r = this.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  down(e) {
    const p = this.pos(e);
    const b = this.hit(p.x, p.y);
    if (!b) return;
    this.drag = { b, x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), moved: 0 };
    b.vx = 0; b.vy = 0;
    this.cv.setPointerCapture(e.pointerId);
  }
  move(e) {
    if (!this.drag) return;
    const p = this.pos(e);
    const d = this.drag;
    d.moved += Math.abs(p.x - d.x) + Math.abs(p.y - d.y);
    // 越重越难甩：高级球给的速度更小
    const k = 70 / (1 + (d.b.level - 1) * 0.8);
    d.b.vx = (p.x - d.x) * k; d.b.vy = (p.y - d.y) * k;
    d.b.x = Math.max(d.b.r, Math.min(this.W - d.b.r, p.x));
    d.b.y = Math.min(this.floor - d.b.r, p.y);
    d.x = p.x; d.y = p.y;
  }
  up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const quick = performance.now() - d.t < 500 && d.moved < 18;
    if (quick) {
      d.b.vx = 0; d.b.vy = 0;
      if (this.onTap) this.onTap(d.b);
    }
  }
}
