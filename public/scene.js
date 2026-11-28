'use strict';
/* 卡通猪圈背景：天、云、山、栅栏、草地、泥坑、植物。全部程序化画出来。 */
const Scene = (() => {
  const cv = document.getElementById('scene');
  const ctx = cv.getContext('2d');
  const DPR = Math.min(devicePixelRatio || 1, 2);
  const T0 = Date.now();
  let W = 0, H = 0;
  let WORLD_W = 0, camX = 0;          // 世界比屏幕宽，可左右拖动
  let mine = [], others = [];
  let FORCE_H = null;
  let weather = 'clear';              // clear / cloudy / overcast / rain / snow

  // 老 WebView 没有 roundRect，补一个
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      const rr = Array.isArray(r) ? r : [r, r, r, r];
      const [a, b, c, d] = rr.map((v) => Math.min(v || 0, w / 2, h / 2));
      this.moveTo(x + a, y); this.lineTo(x + w - b, y); this.arcTo(x + w, y, x + w, y + b, b);
      this.lineTo(x + w, y + h - c); this.arcTo(x + w, y + h, x + w - c, y + h, c);
      this.lineTo(x + d, y + h); this.arcTo(x, y + h, x, y + h - d, d);
      this.lineTo(x, y + a); this.arcTo(x, y, x + a, y, a);
      this.closePath();
      return this;
    };
  }

  const rnd = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const rgb = (c, k = 1) => `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;

  /* 调色板关键帧：按小时插值，天色就连续地变 */
  const NIGHT = { skyTop: [30, 38, 84], skyBot: [62, 78, 140], hillFar: [52, 70, 120], hillNear: [46, 96, 92], ground: [58, 110, 82], fence: [110, 84, 70], cloud: [120, 132, 180], star: 1, warm: 0, light: 0.5 };
  const KEYS = [
    { h: 0, ...NIGHT },
    { h: 5, ...NIGHT },
    { h: 7.5, skyTop: [120, 196, 255], skyBot: [222, 242, 255], hillFar: [150, 214, 170], hillNear: [112, 200, 130], ground: [124, 206, 110], fence: [176, 132, 92], cloud: [255, 255, 255], star: 0, warm: 0.35, light: 1 },
    { h: 11, skyTop: [96, 178, 248], skyBot: [186, 228, 255], hillFar: [142, 208, 160], hillNear: [104, 196, 122], ground: [118, 200, 104], fence: [172, 128, 90], cloud: [255, 255, 255], star: 0, warm: 0, light: 1 },
    { h: 15, skyTop: [110, 170, 240], skyBot: [222, 236, 250], hillFar: [160, 208, 146], hillNear: [120, 192, 110], ground: [132, 198, 92], fence: [176, 128, 86], cloud: [255, 252, 244], star: 0, warm: 0.1, light: 1 },
    { h: 18, skyTop: [94, 110, 190], skyBot: [255, 176, 120], hillFar: [150, 130, 160], hillNear: [96, 140, 110], ground: [96, 150, 92], fence: [140, 100, 78], cloud: [255, 200, 170], star: 0.25, warm: 1, light: 0.8 },
    { h: 20.5, ...NIGHT },
    { h: 24, ...NIGHT },
  ];

  function palette(h) {
    let a = KEYS[0], b = KEYS[KEYS.length - 1];
    for (let i = 0; i < KEYS.length - 1; i++) {
      if (h >= KEYS[i].h && h <= KEYS[i + 1].h) { a = KEYS[i]; b = KEYS[i + 1]; break; }
    }
    const t = b.h === a.h ? 0 : (h - a.h) / (b.h - a.h);
    const s = t * t * (3 - 2 * t);
    const out = {};
    for (const k of Object.keys(a)) {
      if (k === 'h') continue;
      out[k] = Array.isArray(a[k]) ? a[k].map((v, i) => v + (b[k][i] - v) * s) : a[k] + (b[k] - a[k]) * s;
    }
    return out;
  }

  const groundY = () => H * (H > W * 1.05 ? 0.56 : 0.64);
  const farY = (x, gy) => gy - 78 + Math.sin(x * 0.0042 + 1.3) * 26 + Math.sin(x * 0.0016 + 0.4) * 20;
  const nearY = (x, gy) => gy - 34 + Math.sin(x * 0.006 + 3.1) * 12 + Math.sin(x * 0.0024 + 1.9) * 14;

  /* 植物在地上的落点：depth 越大越靠前、越大 */
  function plantY(p) {
    const gy = groundY();
    return gy + 22 + p.depth * Math.min(96, (H - gy) * 0.3);
  }
  function plantScale(p) { return (H > W * 1.05 ? 1 : 1.25) * (0.9 + p.depth * 0.5); }

  function resize() {
    W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    WORLD_W = Math.max(Math.round(W * 2.6), 1200);
    camX = Math.min(camX, Math.max(0, WORLD_W - W));
  }
  const clampCam = (v) => Math.min(Math.max(0, WORLD_W - W), Math.max(0, v));

  /* ---------------- 各个部件 ---------------- */

  function sky(P, gy, h) {
    const g = ctx.createLinearGradient(0, 0, 0, gy + 30);
    g.addColorStop(0, rgb(P.skyTop));
    g.addColorStop(1, rgb(P.skyBot));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (P.warm > 0.01) {           // 傍晚地平线附近的一抹橙
      const w = ctx.createLinearGradient(0, gy - 170, 0, gy);
      w.addColorStop(0, 'rgba(255,170,110,0)');
      w.addColorStop(1, `rgba(255,150,90,${0.5 * P.warm})`);
      ctx.fillStyle = w;
      ctx.fillRect(0, gy - 170, W, 170);
    }
  }

  function stars(P, t) {
    if (P.star < 0.02) return;
    ctx.save();
    for (let i = 0; i < 70; i++) {
      const tw = 0.55 + 0.45 * Math.sin(t * 1.4 + i * 2.3);
      ctx.globalAlpha = P.star * (0.35 + rnd(i * 3) * 0.65) * tw;
      ctx.fillStyle = '#fff';
      const s = 1.2 + rnd(i * 5) * 1.6;
      const y = rnd(i * 7) * groundY() * 0.75;
      ctx.beginPath(); ctx.arc(rnd(i) * W, y, s, 0, 6.2832); ctx.fill();
    }
    ctx.restore();
  }

  function sunMoon(P, gy, h, t) {
    if (weather === 'overcast' || weather === 'rain') return;   // 阴雨看不到太阳
    const isDay = h >= 6 && h <= 19.5;
    if (isDay) {
      const k = (h - 6) / 13.5;
      const x = W * (0.08 + 0.84 * k), y = gy - Math.sin(Math.PI * k) * H * 0.40;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(t * 0.15);
      ctx.fillStyle = `rgba(255,220,120,${0.55 * P.light})`;
      for (let i = 0; i < 10; i++) {                 // 光芒
        ctx.rotate(Math.PI / 5);
        ctx.beginPath(); ctx.moveTo(0, -26); ctx.lineTo(5, -42); ctx.lineTo(-5, -42); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = '#ffe27a';
      ctx.beginPath(); ctx.arc(0, 0, 26, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#fff3b8';
      ctx.beginPath(); ctx.arc(-6, -7, 17, 0, 6.2832); ctx.fill();
      ctx.restore();
    } else {
      const mt = ((h - 19.5 + 24) % 24) / 10.5;
      const x = W * (0.12 + 0.76 * mt), y = gy - Math.sin(Math.PI * mt) * H * 0.34;
      ctx.save();
      ctx.fillStyle = 'rgba(255,250,220,.95)';
      ctx.beginPath(); ctx.arc(x, y, 22, 0, 6.2832); ctx.fill();
      ctx.fillStyle = rgb(P.skyTop);                // 挖掉一块做成月牙
      ctx.beginPath(); ctx.arc(x - 11, y - 6, 20, 0, 6.2832); ctx.fill();
      ctx.restore();
    }
  }

  function clouds(P, t) {
    const defs = [[0.05, 0.11, 9, 1], [0.42, 0.07, 13, 0.7], [0.7, 0.17, 7, 1.3], [0.22, 0.22, 5.5, 0.9]];
    if (weather === 'overcast' || weather === 'rain' || weather === 'snow') {
      defs.push([0.15, 0.05, 16, 0.5], [0.52, 0.12, 18, 0.45], [0.82, 0.06, 14, 0.5], [0.33, 0.16, 15, 0.4]);
    }
    ctx.fillStyle = rgb(P.cloud);
    for (const [bx, by, r, sp] of defs) {
      const span = W + 260;
      const x = ((bx * span + t * 7 * sp) % span) - 130;
      const y = by * H;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 6.2832);
      ctx.arc(x + r * 1.3, y - r * 0.35, r * 1.15, 0, 6.2832);
      ctx.arc(x + r * 2.8, y + r * 0.1, r * 0.85, 0, 6.2832);
      ctx.arc(x + r * 1.5, y + r * 0.45, r * 1.1, 0, 6.2832);
      ctx.fill();
    }
  }

  function hills(P, gy) {
    ctx.fillStyle = rgb(P.hillFar);
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= WORLD_W + 10; x += 10) ctx.lineTo(x, farY(x, gy));
    ctx.lineTo(WORLD_W, H); ctx.closePath(); ctx.fill();

    house(P, gy, WORLD_W * 0.13, farY(WORLD_W * 0.13, gy) + 6);
    house(P, gy, WORLD_W * 0.74, farY(WORLD_W * 0.74, gy) + 6);

    ctx.fillStyle = rgb(P.hillNear);
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= WORLD_W + 10; x += 10) ctx.lineTo(x, nearY(x, gy));
    ctx.lineTo(WORLD_W, H); ctx.closePath(); ctx.fill();

    for (let i = 0; i < 34; i++) {                    // 远处的小花
      const x = rnd(i * 11 + 2) * WORLD_W, y = nearY(x, gy) + 8 + rnd(i * 13) * 18;
      ctx.fillStyle = rgb([255, 255, 255], 0.6 + 0.4 * P.light);
      ctx.beginPath(); ctx.arc(x, y, 2, 0, 6.2832); ctx.fill();
    }
  }

  function house(P, gy, x, y) {                       // 小猪屋
    const k = W < 420 ? 0.8 : 1;
    ctx.save();
    ctx.translate(x, y); ctx.scale(k, k);
    ctx.fillStyle = rgb([255, 236, 214], P.light);
    ctx.beginPath(); ctx.roundRect(-42, -62, 84, 62, 6); ctx.fill();
    ctx.fillStyle = rgb([235, 110, 120], P.light);
    ctx.beginPath(); ctx.moveTo(-54, -58); ctx.lineTo(0, -100); ctx.lineTo(54, -58); ctx.closePath(); ctx.fill();
    ctx.fillStyle = rgb([150, 100, 76], P.light);
    ctx.beginPath(); ctx.roundRect(-15, -40, 30, 40, [15, 15, 0, 0]); ctx.fill();
    ctx.fillStyle = rgb([140, 210, 240], P.light);
    ctx.beginPath(); ctx.arc(25, -38, 9, 0, 6.2832); ctx.fill();
    ctx.restore();
  }

  function ground(P, gy) {
    ctx.fillStyle = rgb(P.ground);
    ctx.beginPath(); ctx.moveTo(0, gy + 10);
    for (let x = 0; x <= WORLD_W + 20; x += 20) ctx.lineTo(x, gy + 6 + Math.sin(x * 0.012 + 1) * 4);
    ctx.lineTo(WORLD_W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();

    ctx.strokeStyle = rgb(P.ground, 1.18);            // 草沿的一道亮边
    ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath();
    for (let x = 0; x <= WORLD_W + 20; x += 20) { const y = gy + 6 + Math.sin(x * 0.012 + 1) * 4; if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();

    ctx.strokeStyle = rgb(P.ground, 0.8);             // 草丛
    ctx.lineWidth = 2;
    for (let i = 0; i < 170; i++) {
      const x = rnd(i * 17 + 1) * WORLD_W, y = gy + 26 + rnd(i * 19 + 5) * (H - gy - 40);
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x - 3, y - 7);
      ctx.moveTo(x, y); ctx.lineTo(x, y - 10);
      ctx.moveTo(x, y); ctx.lineTo(x + 3, y - 7);
      ctx.stroke();
    }

    // 泥坑：猪的最爱（两处，分散在世界里）
    for (const [fx, scale] of [[0.32, 1], [0.72, 0.8]]) {
      const mx = WORLD_W * fx, my = gy + (H - gy) * 0.72, rx = W * 0.3 * scale, ry = Math.min(34, (H - gy) * 0.1) * scale;
      ctx.fillStyle = rgb([150, 104, 78], Math.max(0.5, P.light));
      ctx.beginPath(); ctx.ellipse(mx, my + 4, rx, ry, 0, 0, 6.2832); ctx.fill();
      ctx.fillStyle = rgb([176, 126, 94], Math.max(0.5, P.light));
      ctx.beginPath(); ctx.ellipse(mx, my, rx, ry, 0, 0, 6.2832); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.18 * P.light})`;
      ctx.beginPath(); ctx.ellipse(mx - rx * 0.3, my - ry * 0.3, rx * 0.22, ry * 0.25, -0.4, 0, 6.2832); ctx.fill();
    }
  }

  function fence(P, gy) {
    const step = 46;
    const wood = rgb(P.fence), woodD = rgb(P.fence, 0.78);
    const y0 = gy - 52;
    for (let x = -8; x < WORLD_W + step; x += step) {
      ctx.fillStyle = wood;
      ctx.beginPath(); ctx.roundRect(x, y0, 11, 60, [5, 5, 1, 1]); ctx.fill();
      ctx.fillStyle = woodD;
      ctx.fillRect(x, y0 + 24, 11, 3);
    }
    for (const ry of [y0 + 14, y0 + 38]) {
      ctx.fillStyle = woodD;
      ctx.beginPath(); ctx.roundRect(0, ry, WORLD_W, 9, 4); ctx.fill();
      ctx.fillStyle = wood;
      ctx.beginPath(); ctx.roundRect(0, ry + 1, WORLD_W, 6, 3); ctx.fill();
    }
  }

  /* ---------------- 植物 ---------------- */

  function drawPlant(p, alpha, t, P) {
    const gy = groundY();
    const x = p.x * WORLD_W, y = plantY(p), s = plantScale(p);
    const g = p.growth;
    const h = (8 + 44 * g) * s;
    const sway = Math.sin(t * 1.1 + p.x * 9) * 0.05 * g;
    const leaf = rgb([79, 157, 74], Math.max(0.55, P.light));
    const leaf2 = rgb([104, 182, 92], Math.max(0.55, P.light));

    const ring = () => {};   // 生长进度改为点开植物查看，画面上不再套圈

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(sway);
    ctx.lineCap = 'round';

    ctx.fillStyle = rgb([120, 82, 58], Math.max(0.5, P.light));     // 小土堆
    ctx.beginPath(); ctx.ellipse(0, 2, 11 * s, 3.5 * s, 0, 0, 6.2832); ctx.fill();

    if (g < 0.06) {                                                 // 刚种下：一颗芽
      ctx.fillStyle = leaf2;
      ctx.beginPath(); ctx.ellipse(0, -4 * s, 3 * s, 4 * s, 0.3, 0, 6.2832); ctx.fill();
      ring(-h - 9 * s);
      ctx.restore(); return;
    }

    ctx.strokeStyle = leaf; ctx.lineWidth = 3 * s;                  // 茎
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(3 * s, -h * 0.5, 0, -h); ctx.stroke();
    if (g > 0.18) {                                                 // 叶子
      ctx.fillStyle = leaf2;
      const ly = -h * 0.38, ls = Math.min(1, (g - 0.18) / 0.3);
      ctx.beginPath(); ctx.ellipse(-7 * s * ls, ly, 8 * s * ls, 4 * s * ls, -0.5, 0, 6.2832); ctx.fill();
      ctx.beginPath(); ctx.ellipse(7 * s * ls, ly - 4 * s, 8 * s * ls, 4 * s * ls, 0.5, 0, 6.2832); ctx.fill();
    }

    const f = Math.max(0, (g - 0.55) / 0.45);                      // 花从头到尾冒出来
    const top = -h;

    if (p.species === 'carrot') {
      ctx.strokeStyle = leaf2; ctx.lineWidth = 2 * s;              // 缨子
      for (const a of [-0.6, -0.3, 0, 0.3, 0.6]) {
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(a) * 16 * s * (0.4 + g * 0.6), -Math.cos(a) * 22 * s * (0.4 + g * 0.6)); ctx.stroke();
      }
      if (g > 0.4) {                                               // 露出一点橙色
        ctx.fillStyle = rgb([242, 130, 60], Math.max(0.55, P.light));
        ctx.beginPath(); ctx.ellipse(0, 1, 4.5 * s, 4 * s, 0, 0, Math.PI); ctx.fill();
      }
    } else if (p.species === 'pumpkin') {
      if (f > 0) {                                                 // 一个橙色南瓜
        const pr = 8 * f * s;
        ctx.fillStyle = rgb([242, 140, 50], Math.max(0.55, P.light));
        ctx.beginPath(); ctx.ellipse(0, top + pr * 0.4, pr, pr * 0.85, 0, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = rgb([200, 105, 35], Math.max(0.5, P.light));
        ctx.lineWidth = 1.4 * s;
        for (const k of [-0.45, 0, 0.45]) {
          ctx.beginPath(); ctx.moveTo(0 + k * pr, top - pr * 0.35); ctx.quadraticCurveTo(k * pr * 1.6, top + pr * 0.4, k * pr, top + pr * 1.1); ctx.stroke();
        }
      }
    } else if (p.species === 'mushroom') {
      if (f > 0) {                                                 // 红伞白点
        const mr = 9 * f * s;
        ctx.fillStyle = '#e85b5b';
        ctx.beginPath(); ctx.arc(0, top + mr * 0.35, mr, Math.PI, 0); ctx.fill();
        ctx.fillStyle = '#f7e6c8';
        ctx.beginPath(); ctx.ellipse(0, top + mr * 0.35, mr * 0.3, mr * 0.55, 0, 0, Math.PI); ctx.fill();
        ctx.fillStyle = '#fff';
        for (const [dx, dy, r] of [[-0.45, -0.1, 0.16], [0.35, -0.22, 0.13], [0.1, 0.12, 0.11]]) {
          ctx.beginPath(); ctx.arc(dx * mr, top + mr * 0.35 + dy * mr, r * mr, 0, 6.2832); ctx.fill();
        }
      }
    } else if (p.species === 'watermelon') {
      if (f > 0) {                                                 // 一个带纹的西瓜
        const wr = 9 * f * s;
        ctx.fillStyle = '#4f9d55';
        ctx.beginPath(); ctx.ellipse(0, top + wr * 1.1, wr, wr * 0.92, 0, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = '#2f7038'; ctx.lineWidth = 1.3 * s;
        for (const k of [-0.5, 0, 0.5]) {
          ctx.beginPath(); ctx.moveTo(k * wr * 0.9, top + wr * 0.3); ctx.quadraticCurveTo(k * wr * 1.3, top + wr * 1.1, k * wr * 0.9, top + wr * 1.9); ctx.stroke();
        }
      }
    } else if (p.species === 'corn') {
      if (f > 0) {                                                 // 玉米棒
        const cr = 6 * f * s;
        ctx.fillStyle = '#f2c94c';
        ctx.beginPath(); ctx.ellipse(3 * s, top + cr * 2.2, cr, cr * 2.2, 0.05, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#7bbf5a';
        ctx.beginPath(); ctx.ellipse(-2 * s, top + cr * 1.4, cr * 0.55, cr * 1.9, -0.35, 0, 6.2832); ctx.fill();
        ctx.beginPath(); ctx.ellipse(8 * s, top + cr * 1.6, cr * 0.55, cr * 1.8, 0.35, 0, 6.2832); ctx.fill();
      }
    } else if (f > 0) {
      const fr = (p.species === 'sunflower' ? 11 : 7.5) * f * s;
      const petal = p.species === 'sunflower' ? [255, 205, 66]
        : p.species === 'tulip' ? [246, 110, 150]
          : p.species === 'strawberry' ? [255, 176, 198] : [255, 255, 255];
      if (p.species === 'tulip') {                                 // 郁金香是个杯子
        ctx.fillStyle = rgb(petal, Math.max(0.55, P.light));
        ctx.beginPath();
        ctx.moveTo(-fr * 0.8, top - fr * 1.3);
        ctx.quadraticCurveTo(-fr * 1.05, top + fr * 0.2, 0, top + fr * 0.45);
        ctx.quadraticCurveTo(fr * 1.05, top + fr * 0.2, fr * 0.8, top - fr * 1.3);
        ctx.quadraticCurveTo(fr * 0.35, top - fr * 0.75, 0, top - fr * 1.15);
        ctx.quadraticCurveTo(-fr * 0.35, top - fr * 0.75, -fr * 0.8, top - fr * 1.3);
        ctx.fill();
      } else {
        ctx.fillStyle = rgb(petal, Math.max(0.55, P.light));
        const n = p.species === 'sunflower' ? 12 : 8;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * 6.2832;
          ctx.beginPath(); ctx.ellipse(top + Math.cos(a) * fr * 0.62, top - fr * 0.5 + Math.sin(a) * fr * 0.62, fr * 0.42, fr * 0.26, a, 0, 6.2832); ctx.fill();
        }
        ctx.fillStyle = rgb(p.species === 'sunflower' ? [122, 78, 40] : [255, 205, 66], Math.max(0.55, P.light));
        ctx.beginPath(); ctx.arc(0, top - fr * 0.5, fr * 0.42, 0, 6.2832); ctx.fill();
      }
    }

    if (p.species === 'strawberry' && g > 0.72) {                  // 结几颗小草莓
      ctx.fillStyle = '#e8475f';
      for (const [bx, by] of [[-6, -h * 0.34], [6, -h * 0.5], [0, -h * 0.22]]) {
        ctx.beginPath(); ctx.arc(bx * s, by, 2.6 * s, 0, 6.2832); ctx.fill();
      }
    }

    ring(top - 14 * s);
    ctx.restore();
  }

  function fireflies(P, t) {
    if (P.star < 0.6) return;
    for (let i = 0; i < 12; i++) {
      const x = (rnd(i * 23) + Math.sin(t * 0.4 + i) * 0.04) * WORLD_W;
      const y = groundY() + 20 + (rnd(i * 29) + Math.cos(t * 0.5 + i * 1.7) * 0.05) * (H - groundY() - 60);
      ctx.globalAlpha = P.star * (0.35 + 0.65 * Math.abs(Math.sin(t * 2 + i * 1.9)));
      ctx.fillStyle = '#fff3a0';
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* 白天飘一点花瓣/落叶，让画面不是静止的；夜里交给萤火虫 */
  function petals(P, t) {
    if (P.light < 0.55) return;
    for (let i = 0; i < 10; i++) {
      const s0 = i * 17;
      const sp = 0.010 + rnd(s0) * 0.012;
      const x = ((rnd(s0 + 1) + t * sp) % 1) * (WORLD_W + 80) - 40;
      const y = ((rnd(s0 + 2) + t * sp * 0.62) % 1) * (H * 0.8);
      const sway = Math.sin(t * 1.1 + i) * 9;
      const size = 2 + rnd(s0 + 3) * 2.4;
      ctx.globalAlpha = 0.42 * P.light;
      ctx.fillStyle = i % 3 === 0 ? '#ffd6e4' : i % 3 === 1 ? '#fff0b8' : '#cfeecb';
      ctx.beginPath();
      ctx.ellipse(x + sway, y, size, size * 0.55, t + i, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------- 天气 ---------------- */

  function applyWeather(P) {
    if (weather === 'overcast' || weather === 'rain') {
      const k = weather === 'rain' ? 0.62 : 0.72;
      P.skyTop = P.skyTop.map((v) => v * k);
      P.skyBot = P.skyBot.map((v) => v * (k + 0.08));
      P.hillFar = P.hillFar.map((v) => v * 0.8);
      P.hillNear = P.hillNear.map((v) => v * 0.78);
      P.ground = P.ground.map((v) => v * 0.82);
      P.cloud = [126, 132, 142];
      P.star = 0;
      P.warm = 0;
      P.light *= 0.8;
    } else if (weather === 'snow') {
      P.skyTop = P.skyTop.map((v) => Math.min(255, v * 0.55 + 120));
      P.skyBot = P.skyBot.map((v) => Math.min(255, v * 0.4 + 170));
      P.ground = P.ground.map((v) => Math.min(255, v * 0.55 + 70));
      P.hillFar = P.hillFar.map((v) => Math.min(255, v * 0.4 + 110));
      P.hillNear = P.hillNear.map((v) => Math.min(255, v * 0.45 + 100));
      P.cloud = [230, 234, 240];
      P.star = Math.min(P.star, 0.2);
      P.light = Math.min(1, P.light + 0.15);
    } else if (weather === 'cloudy') {
      P.light *= 0.92;
      P.cloud = [235, 238, 242];
    }
  }

  function weatherFx(P, t) {
    if (weather === 'overcast') {
      ctx.fillStyle = `rgba(90,100,115,${0.1 * P.light + 0.05})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (weather === 'rain') {
      ctx.fillStyle = 'rgba(70,84,104,.14)';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(196,222,255,.6)';
      ctx.lineWidth = 1.4;
      ctx.lineCap = 'round';
      for (let i = 0; i < 90; i++) {
        const sp = 0.45 + rnd(i * 7) * 0.55;
        const x = ((rnd(i * 3) * W + t * 30 * sp) % (W + 60)) - 30;
        const y = ((rnd(i * 5) * H + t * 620 * sp) % (H + 40)) - 20;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 16); ctx.stroke();
      }
      // 地面水花
      ctx.fillStyle = 'rgba(210,230,255,.35)';
      for (let i = 0; i < 18; i++) {
        const x = (rnd(i * 13) * W + t * 12) % W;
        const y = H - 20 - rnd(i * 11) * 26;
        ctx.beginPath(); ctx.ellipse(x, y, 4, 1.4, 0, 0, 6.2832); ctx.fill();
      }
    }
    if (weather === 'snow') {
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      for (let i = 0; i < 70; i++) {
        const sp = 0.3 + rnd(i * 9) * 0.5;
        const x = ((rnd(i * 3) * W + Math.sin(t * 0.7 + i) * 26 + t * 18 * sp) % (W + 40)) - 20;
        const y = ((rnd(i * 5) * H + t * 90 * sp) % (H + 30)) - 15;
        const r = 1.4 + rnd(i * 7) * 2.2;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
      }
    }
  }

  /* 点在植物上？返回最近的一株（世界坐标换算后判断） */
  function hitPlant(cx, cy) {
    const wx = cx + camX;
    let best = null, bestD = 1e9;
    for (const p of mine) {
      const s = plantScale(p);
      const px = p.x * WORLD_W, py = plantY(p) - 26 * s;
      const d = Math.hypot(wx - px, cy - py);
      if (d < 26 * s && d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /* ---------------- 一帧 ---------------- */

  function render() {
    if (!W) return;
    const d = new Date();
    const h = FORCE_H != null ? FORCE_H : d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    const P = palette(h);
    applyWeather(P);
    const gy = groundY();
    const t = (Date.now() - T0) / 1000;

    sky(P, gy, h);
    stars(P, t);
    sunMoon(P, gy, h, t);
    clouds(P, t);
    ctx.save();
    ctx.translate(-camX, 0);
    hills(P, gy);
    ground(P, gy);
    fence(P, gy);
    for (const p of others) drawPlant(p, 0.5, t, P);
    for (const p of mine) drawPlant(p, 1, t, P);
    fireflies(P, t);
    petals(P, t);
    ctx.restore();
    weatherFx(P, t);
  }

  return {
    resize, render, groundY, plantY, plantScale, hitPlant,
    setPlants(m, o) { mine = m || []; others = o || []; },
    worldW: () => WORLD_W,
    camX: () => camX,
    setCam(x) { camX = clampCam(x); render(); },
    panBy(dx) { camX = clampCam(camX + dx); render(); return camX; },
    screenToWorld(x) { return x + camX; },
    setWeather(w) { weather = w || 'clear'; render(); },
    weather: () => weather,
    forceHour(h) { FORCE_H = h; render(); },
    hour() { return FORCE_H != null ? FORCE_H : new Date().getHours() + new Date().getMinutes() / 60; },
  };
})();
