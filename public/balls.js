'use strict';
/* 图鉴 = 小球池。抽到的每只猪是一个球，有碰撞体积，次数越多越大。 */
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

    // 手指：拖、扔、点
    this.cv.style.touchAction = 'none';
    this.cv.addEventListener('pointerdown', (e) => this.down(e));
    this.cv.addEventListener('pointermove', (e) => this.move(e));
    this.cv.addEventListener('pointerup', (e) => this.up(e));
    this.cv.addEventListener('pointercancel', () => { this.drag = null; });
  }

  /* 半径：次数越多越大。次数的 0.6 次方，第 5 次 2.3 倍，第 20 次 4.6 倍（不会撑爆） */
  static radius(count) { return 14 + 10 * Math.pow(Math.max(1, count), 0.6); }

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
    for (const b of this.balls) this.setR(b, Math.max(9, b.r0 * k));
  }

  setR(b, r) { b.r = r; }

  setItems(items) {
    const have = new Set(this.balls.map((b) => b.id));
    let changed = false;
    items.forEach((it, i) => {
      let b = this.balls.find((x) => x.id === it.id);
      if (!b) {
        // 新球从上面掉下来
        const r0 = BallPit.radius(it.count);
        b = { id: it.id, x: 20 + Math.random() * Math.max(40, this.W - 40), y: -r0 - Math.random() * 700 - i * 6, vx: (Math.random() - 0.5) * 120, vy: 0, r0, r: r0, born: performance.now(), ...it };
        this.balls.push(b);
        changed = true;
        if (!this.imgs.has(it.id)) {
          const img = new Image();
          img.src = this.urlOf(it.id);
          this.imgs.set(it.id, img);
        }
      } else {
        b.count = it.count; b.rarity = it.rarity; b.title = it.title;
        b.r0 = BallPit.radius(it.count);
      }
    });
    const keep = new Set(items.map((it) => it.id));
    const before = this.balls.length;
    this.balls = this.balls.filter((b) => keep.has(b.id));
    if (this.balls.length !== before) changed = true;
    this.fit();
    return changed;
  }

  /* ---------------- 物理 ---------------- */

  step(dt) {
    const G = 2400;
    for (const b of this.balls) {
      if (b === (this.drag && this.drag.b)) continue;
      b.vy += G * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const e = 0.28;
      if (b.y + b.r > this.floor) { b.y = this.floor - b.r; b.vy = Math.abs(b.vy) > 60 ? -b.vy * e : 0; b.vx *= 0.9; }
      if (b.y - b.r < -900) { b.y = -900 + b.r; b.vy = 0; }
      if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx) * e; }
      if (b.x + b.r > this.W) { b.x = this.W - b.r; b.vx = -Math.abs(b.vx) * e; }
    }
    // 球和球：推开 + 换一点速度。多迭代几次，堆起来才稳
    const n = this.balls.length;
    for (let it = 0; it < 5; it++) {
      for (let i = 0; i < n; i++) {
        const a = this.balls[i];
        for (let j = i + 1; j < n; j++) {
          const c = this.balls[j];
          const dx = c.x - a.x, dy = c.y - a.y;
          const min = a.r + c.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2) || 0.01;
          const nx = dx / d, ny = dy / d;
          const over = (min - d);
          const ma = a.r * a.r, mc = c.r * c.r;          // 大的球重，推得少
          const wa = mc / (ma + mc), wc = ma / (ma + mc);
          const aHeld = a === (this.drag && this.drag.b), cHeld = c === (this.drag && this.drag.b);
          a.x -= nx * over * wa * (aHeld ? 0 : 1); a.y -= ny * over * wa * (aHeld ? 0 : 1);
          c.x += nx * over * wc * (cHeld ? 0 : 1); c.y += ny * over * wc * (cHeld ? 0 : 1);
          const rvn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
          if (rvn < 0) {
            const jimp = -(1 + 0.1) * rvn / (1 / ma + 1 / mc);
            a.vx -= (jimp * nx) / ma; a.vy -= (jimp * ny) / ma;
            c.vx += (jimp * nx) / mc; c.vy += (jimp * ny) / mc;
          }
        }
      }
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    const ring = { common: 'rgba(255,255,255,.9)', rare: '#5aaef5', legend: '#ffcf4d' };
    for (const b of this.balls) {
      // 稀有度光晕
      if (b.rarity === 'rare' || b.rarity === 'legend') {
        const g = ctx.createRadialGradient(b.x, b.y, b.r * 0.55, b.x, b.y, b.r * 1.95);
        const col = b.rarity === 'legend' ? '255,207,77' : '90,174,245';
        g.addColorStop(0, `rgba(${col},0.30)`);
        g.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 1.95, 0, 6.2832); ctx.fill();
      }
      // 新球落地时的一圈扩散波
      if (b.born) {
        const age = performance.now() - b.born;
        if (age < 1200) {
          const k = age / 1200;
          ctx.save();
          ctx.globalAlpha = (1 - k) * 0.8;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r * (1 + k * 1.1), 0, 6.2832); ctx.stroke();
          ctx.restore();
        } else { b.born = 0; }
      }
      ctx.save();
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.2832); ctx.closePath();
      ctx.fillStyle = '#ffe3ec'; ctx.fill();
      ctx.clip();
      const img = this.imgs.get(b.id);
      if (img && img.complete && img.naturalWidth) {
        const s = Math.max((b.r * 2) / img.naturalWidth, (b.r * 2) / img.naturalHeight);
        const w = img.naturalWidth * s, h = img.naturalHeight * s;
        ctx.drawImage(img, b.x - w / 2, b.y - h / 2, w, h);
      }
      ctx.restore();
      ctx.lineWidth = Math.max(2, b.r * 0.09);
      ctx.strokeStyle = ring[b.rarity] || ring.common;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r - ctx.lineWidth / 2 + 0.5, 0, 6.2832); ctx.stroke();
      if (b.ex > 0) {
        ctx.fillStyle = '#ffcf4d';
        ctx.beginPath(); ctx.arc(b.x + b.r * 0.72, b.y - b.r * 0.72, Math.max(7, b.r * 0.22), 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#5b4300'; ctx.font = `800 ${Math.max(8, b.r * 0.2)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('EX' + b.ex, b.x + b.r * 0.72, b.y - b.r * 0.7);
      }
      if (b.r > 34) {
        ctx.fillStyle = 'rgba(255,255,255,.92)';
        ctx.font = `700 12px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(b.title.length > 6 ? b.title.slice(0, 6) + '…' : b.title, b.x, b.y + b.r - 11);
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
      if (dx * dx + dy * dy <= (b.r + 6) * (b.r + 6)) return b;
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
    d.b.vx = (p.x - d.x) * 50; d.b.vy = (p.y - d.y) * 50;
    d.b.x = Math.max(d.b.r, Math.min(this.W - d.b.r, p.x));
    d.b.y = Math.min(this.floor - d.b.r, p.y);
    d.x = p.x; d.y = p.y;
  }
  up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const quick = performance.now() - d.t < 350 && d.moved < 10;
    if (quick) {
      d.b.vx = 0; d.b.vy = 0;
      if (this.onTap) this.onTap(d.b);
    }
  }
}
