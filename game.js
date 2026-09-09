'use strict';
/* SKY STACK v5.0 - Fresh rewrite by Eggy (2026-09-10)
 * Based on records from v3.0 / v4.0 / v4.1.
 * Bug fixes from prior versions:
 *   - v3.0: addStars missing closing brace -> black screen
 *   - v4.0: offscreen canvas NaN coords -> silent drawImage failure
 *   - v4.1: 50px landing jump (fall.y mismatch with tower topY)
 *
 * Design: vanilla JS, direct rendering (NO offscreen cache),
 * single coord system (world y goes UP, block CENTERS tracked, fall.y
 * snaps to target on land so drawn position is identical pre/post land),
 * try/catch in render loop, min-dimension guard in resize().
 */
const cvs = document.getElementById('game');
const ctx = cvs.getContext('2d', { alpha: false });
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = Math.max(320, window.innerWidth || 320);
  H = Math.max(480, window.innerHeight || 480);
  cvs.width = Math.round(W * DPR);
  cvs.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const F = 'system-ui,-apple-system,"PingFang HK","Microsoft JhengHei",sans-serif';

const BLOCK_W = 110, BLOCK_H = 36, DX = 14, DY = 10;
const PLATFORM_W = 140, PLATFORM_H = 22;
const GRAVITY = 3200, PERFECT_PX = 8;

const PALETTE = ['#ff5d5d','#ffb43d','#ffd75e','#9be368','#3ddc84','#45a7ff','#a78bfa','#ff9de2'];

function shade(hex, dl) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  const f = 1 + dl / 100;
  return 'rgb(' + (clamp(r*f,0,255)|0) + ',' + (clamp(g*f,0,255)|0) + ',' + (clamp(b*f,0,255)|0) + ')';
}

const ST = { MENU: 0, SWING: 1, FALL: 2, OVER: 3 };
let state = ST.MENU;
let tower = [];
let fall = null;
let camY = 0;
let shake = 0;
let score = 0, combo = 0, newBest = false, overT = 0;
let best = 0;
try { best = parseInt(localStorage.getItem('ss5_best') || '0', 10) || 0; } catch (e) { best = 0; }
let muted = false;
try { muted = localStorage.getItem('ss5_muted') === '1'; } catch (e) {}
let lang = 'en';
try {
  const stored = localStorage.getItem('ss5_lang');
  if (stored === 'en' || stored === 'zh') lang = stored;
  else if ((navigator.language || 'en').toLowerCase().indexOf('zh') === 0) lang = 'zh';
} catch (e) {}
let swingPh = Math.random() * TAU;
let particles = [];
let texts = [];
let tGlobal = 0;

const LANG = {
  en: {
    title: 'SKY STACK', tagline: '2.5D BALANCE STACKER',
    start: 'TAP TO START', retry: 'TAP TO RETRY',
    height: 'HEIGHT', score: 'SCORE', best: 'BEST',
    perfect: 'PERFECT!', miss: 'MISSED!',
    tip1: 'Tap or SPACE to drop', tip2: 'Land centered for combos', tip3: "Don't let blocks fall off!",
    langBtn: '中', comboLabel: 'COMBO',
  },
  zh: {
    title: '疊疊高', tagline: '2.5D 平衡疊積木',
    start: '點擊開始', retry: '點擊重試',
    height: '高度', score: '分數', best: '最佳',
    perfect: '完美!', miss: '跌咗!',
    tip1: '點擊或按空白鍵放低', tip2: '對正中心觸發連擊', tip3: '小心唔好跌出塔外!',
    langBtn: 'EN', comboLabel: '連擊',
  }
};
let L = LANG[lang] || LANG.en;

function cycleLang() {
  lang = (lang === 'en') ? 'zh' : 'en';
  L = LANG[lang];
  try { localStorage.setItem('ss5_lang', lang); } catch (e) {}
}
function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('ss5_muted', muted ? '1' : '0'); } catch (e) {}
}

let AC = null;
function ensureAudio() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  if (AC && AC.state === 'suspended') { try { AC.resume(); } catch (e) {} }
}
function beep(opts) {
  if (!AC || muted) return;
  const o = opts || {};
  const f = o.f || 440, f2 = o.f2 != null ? o.f2 : f, t = o.t || 0.1, type = o.type || 'sine', v = o.v != null ? o.v : 0.2;
  try {
    const t0 = AC.currentTime;
    const osc = AC.createOscillator(), g = AC.createGain();
    osc.type = type; osc.frequency.setValueAtTime(f, t0);
    if (f2 !== f) osc.frequency.exponentialRampToValueAtTime(Math.max(f2, 1), t0 + t);
    g.gain.setValueAtTime(v, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + t);
    osc.connect(g); g.connect(AC.destination);
    osc.start(t0); osc.stop(t0 + t + 0.03);
  } catch (e) {}
}
const sfx = {
  click: () => beep({f:700, t:0.05, type:'square', v:0.08}),
  drop:  () => beep({f:620, f2:320, t:0.12, type:'triangle', v:0.16}),
  thud:  () => beep({f:150, f2:60, t:0.13, type:'square', v:0.2}),
  perfect: () => beep({f:880, t:0.15, type:'sine', v:0.18}),
};

function spawnStars(x, y, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = 80 + Math.random() * 180;
    particles.push({x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, g: 320, r: 2 + Math.random() * 2, t: 0, life: 0.6 + Math.random() * 0.4, k: 's'});
  }
}
function spawnDust(x, y, n) {
  for (let i = 0; i < n; i++) {
    particles.push({x: x + rand(-30, 30), y: y, vx: rand(-100, 100), vy: rand(-80, -20), g: 600, r: 2 + Math.random() * 3, t: 0, life: 0.4 + Math.random() * 0.4, k: 'd'});
  }
}
function addText(x, y, str, color, size, life) {
  texts.push({x: x, y: y, str: str, color: color, size: size || 16, t: 0, life: life || 1});
}

function trolleyX() {
  return Math.sin(swingPh) * Math.min(W * 0.4, 200);
}

function startGame() {
  tower = [];
  score = 0; combo = 0; newBest = false;
  fall = null;
  particles = []; texts = [];
  swingPh = Math.random() * TAU;
  camY = H * 0.35;
  state = ST.SWING;
}

function drop() {
  const topY = tower.length ? tower[tower.length - 1].y : 0;
  fall = { x: trolleyX(), y: topY + H * 0.4, vy: 0, colorIdx: tower.length % PALETTE.length };
  state = ST.FALL;
}

function land() {
  const topX = tower.length ? tower[tower.length - 1].x : 0;
  const off = fall.x - topX;
  const perfect = Math.abs(off) <= PERFECT_PX;
  const towerTop = tower.length ? tower[tower.length - 1].y : 0;

  if (Math.abs(off) > BLOCK_W * 0.5) {
    spawnDust(fall.x, fall.y, 12);
    addText(0, towerTop + 60, L.miss, '#ff5d5d', 22, 1.5);
    shake = 10;
    if (score > best) { best = score; newBest = true; try { localStorage.setItem('ss5_best', String(best)); } catch (e) {} }
    fall = null;
    state = ST.OVER; overT = 0;
    sfx.thud();
    return;
  }

  tower.push({ x: fall.x, y: fall.y, colorIdx: fall.colorIdx });
  if (perfect) {
    combo++;
    const bonus = combo * 5;
    score += 10 + bonus;
    spawnStars(fall.x, fall.y, 12);
    addText(0, fall.y + BLOCK_H * 0.8, L.perfect + ' +' + (10 + bonus), '#ffd75e', combo > 1 ? 22 : 18, 1);
    sfx.perfect();
  } else {
    combo = 0;
    score += 10;
    addText(0, fall.y + BLOCK_H * 0.8, '+10', '#fff', 16, 0.7);
    sfx.thud();
  }
  shake = perfect ? 3 : 5;
  fall = null;
  state = ST.SWING;
}

function update(dt) {
  tGlobal += dt;

  if (state === ST.SWING || state === ST.MENU) {
    swingPh += 1.8 * dt;
  }

  if (state === ST.FALL && fall) {
    fall.vy += GRAVITY * dt;
    fall.y += fall.vy * dt;
    const targetY = (tower.length + 0.5) * BLOCK_H;
    if (fall.y >= targetY) {
      fall.y = targetY;
      land();
    }
  }

  const towerTop = tower.length ? tower[tower.length - 1].y : 0;
  const targetCamY = Math.max(0, towerTop + H * 0.3);
  camY += (targetCamY - camY) * Math.min(1, dt * 2.5);

  shake = Math.max(0, shake - dt * 30);

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt;
    if (p.t > p.life) { particles.splice(i, 1); continue; }
    p.vy += p.g * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    texts[i].t += dt;
    if (texts[i].t > texts[i].life) texts.splice(i, 1);
  }

  if (state === ST.OVER) overT += dt;
}

function worldToScreen(wy) {
  return wy - camY + H * 0.7;
}

function drawBox(cx, worldCenterY, w, h, colorIdx) {
  const topY = worldToScreen(worldCenterY) - h / 2;
  const c = PALETTE[colorIdx % PALETTE.length];

  ctx.fillStyle = shade(c, 30);
  ctx.beginPath();
  ctx.moveTo(cx - w/2, topY);
  ctx.lineTo(cx - w/2 + DX, topY - DY);
  ctx.lineTo(cx + w/2 + DX, topY - DY);
  ctx.lineTo(cx + w/2, topY);
  ctx.closePath(); ctx.fill();

  ctx.fillStyle = shade(c, -30);
  ctx.beginPath();
  ctx.moveTo(cx + w/2, topY);
  ctx.lineTo(cx + w/2 + DX, topY - DY);
  ctx.lineTo(cx + w/2 + DX, topY - DY + h);
  ctx.lineTo(cx + w/2, topY + h);
  ctx.closePath(); ctx.fill();

  ctx.fillStyle = c;
  ctx.fillRect(cx - w/2, topY, w, h);

  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.fillRect(cx - w/2, topY, w, 3);
}

function drawIconButton(x, y, r, label, fontSize) {
  ctx.fillStyle = 'rgba(10,15,30,0.55)';
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = (fontSize || 15) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x, y + 5);
}

function render() {
  ctx.fillStyle = '#0e1526';
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#1a2845');
  grad.addColorStop(1, '#0e1526');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const sh = shake > 0 ? rand(-shake, shake) : 0;

  ctx.save();
  ctx.translate(W/2 + sh, 0);

  const platTopY = worldToScreen(0);
  ctx.fillStyle = '#252e49';
  ctx.fillRect(-PLATFORM_W/2 - DX, platTopY - DY, PLATFORM_W + DX, DY);
  ctx.fillStyle = '#3a4567';
  ctx.fillRect(-PLATFORM_W/2, platTopY, PLATFORM_W, PLATFORM_H);
  ctx.fillStyle = '#4d5a80';
  ctx.fillRect(-PLATFORM_W/2, platTopY, PLATFORM_W, 3);
  ctx.strokeStyle = 'rgba(230,238,255,0.4)';
  ctx.lineWidth = 2;
  for (let x = -PLATFORM_W/2 + 15; x < PLATFORM_W/2 - 10; x += 25) {
    ctx.beginPath(); ctx.moveTo(x, platTopY - DY); ctx.lineTo(x, platTopY - DY - 14); ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(-PLATFORM_W/2, platTopY - DY - 14);
  ctx.lineTo(PLATFORM_W/2, platTopY - DY - 14);
  ctx.stroke();

  for (let i = 0; i < tower.length; i++) {
    const b = tower[i];
    drawBox(b.x, b.y, BLOCK_W, BLOCK_H, b.colorIdx);
  }

  if (state === ST.FALL && fall) {
    drawBox(fall.x, fall.y, BLOCK_W, BLOCK_H, fall.colorIdx);
  }

  if (state === ST.MENU || state === ST.SWING) {
    const tx = trolleyX();
    const railY = 30;
    ctx.fillStyle = '#252e49';
    ctx.fillRect(-W*0.6, railY, W*1.2, 10);
    ctx.fillStyle = '#39466b';
    for (let x = -W*0.6; x < W*0.6; x += 28) {
      ctx.fillRect(x, railY + 3, 12, 4);
    }
    ctx.fillStyle = '#ffcf3f';
    ctx.fillRect(tx - 22, railY + 8, 44, 20);
    ctx.fillStyle = '#d9a516';
    ctx.fillRect(tx - 22, railY + 25, 44, 3);
    ctx.fillStyle = '#2c3552';
    ctx.beginPath(); ctx.arc(tx - 13, railY + 30, 3.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(tx + 13, railY + 30, 3.5, 0, TAU); ctx.fill();

    const previewY = (tower.length ? tower[tower.length - 1].y : 0) + H * 0.4;
    const cableEndY = worldToScreen(previewY) + BLOCK_H / 2;
    ctx.strokeStyle = 'rgba(220,228,245,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tx, railY + 30); ctx.lineTo(tx, cableEndY); ctx.stroke();
    drawBox(tx, previewY, BLOCK_W, BLOCK_H, tower.length % PALETTE.length);
  }

  ctx.restore();

  for (const p of particles) {
    const a = clamp(1 - p.t / p.life, 0, 1);
    const px = W/2 + sh + p.x;
    const py = worldToScreen(p.y);
    if (p.k === 's') {
      ctx.fillStyle = 'rgba(255,215,94,' + a.toFixed(3) + ')';
    } else {
      ctx.fillStyle = 'rgba(228,230,240,' + (a * 0.7).toFixed(3) + ')';
    }
    ctx.beginPath(); ctx.arc(px, py, p.r, 0, TAU); ctx.fill();
  }

  for (const t of texts) {
    const a = clamp(1 - t.t / t.life, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = t.color;
    ctx.font = '700 ' + t.size + 'px ' + F;
    ctx.textAlign = 'center';
    ctx.fillText(t.str, W/2 + sh + t.x, worldToScreen(t.y) - t.t * 30);
  }
  ctx.globalAlpha = 1;

  if (state !== ST.MENU) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = '700 28px ' + F;
    ctx.fillText((tower.length * 2) + ' m', 16, 46);
    ctx.font = '500 14px ' + F;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(L.score + ': ' + score, 16, 66);

    if (combo > 1) {
      ctx.fillStyle = '#ffd75e';
      ctx.font = '700 16px ' + F;
      ctx.fillText(L.comboLabel + ' x' + combo, 16, 90);
    }

    drawIconButton(W - 32, 38, 22, muted ? '🔇' : '🔊');
    drawIconButton(W - 72, 38, 22, L.langBtn, 11);
  }

  if (state === ST.MENU) {
    ctx.fillStyle = 'rgba(8,12,24,0.65)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = '900 52px ' + F;
    ctx.fillText(L.title, W/2, H * 0.3);
    ctx.font = '500 16px ' + F;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(L.tagline, W/2, H * 0.3 + 32);

    ctx.font = '500 14px ' + F;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(L.tip1, W/2, H * 0.5);
    ctx.fillText(L.tip2, W/2, H * 0.5 + 24);
    ctx.fillText(L.tip3, W/2, H * 0.5 + 48);

    if (best > 0) {
      ctx.fillStyle = '#ffd75e';
      ctx.font = '600 18px ' + F;
      ctx.fillText('🏆 ' + L.best + ': ' + best, W/2, H * 0.68);
    }

    ctx.fillStyle = '#ffd75e';
    ctx.font = '800 22px ' + F;
    ctx.fillText(L.start, W/2, H * 0.85);

    drawIconButton(W - 32, 38, 22, muted ? '🔇' : '🔊');
    drawIconButton(W - 72, 38, 22, L.langBtn, 11);
  }

  if (state === ST.OVER && overT > 0.3) {
    ctx.fillStyle = 'rgba(8,12,24,0.78)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = '900 40px ' + F;
    ctx.fillText(L.miss, W/2, H * 0.4);

    ctx.font = '600 16px ' + F;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(L.height + ': ' + (tower.length * 2) + ' m', W/2, H * 0.4 + 40);
    ctx.fillStyle = '#ffd75e';
    ctx.fillText(L.score + ': ' + score, W/2, H * 0.4 + 70);

    if (newBest) {
      ctx.fillStyle = '#3ddc84';
      ctx.font = '700 18px ' + F;
      ctx.fillText('🎉 NEW BEST!', W/2, H * 0.4 + 105);
    }

    if (overT > 1) {
      ctx.fillStyle = '#ffd75e';
      ctx.font = '800 22px ' + F;
      ctx.fillText(L.retry, W/2, H * 0.7);
    }
  }
}

function handleInput(px, py) {
  ensureAudio();
  if (Math.hypot(px - (W - 32), py - 38) < 24) { toggleMute(); sfx.click(); return; }
  if (Math.hypot(px - (W - 72), py - 38) < 24) { cycleLang(); sfx.click(); return; }

  if (state === ST.MENU) {
    sfx.click();
    startGame();
  } else if (state === ST.SWING) {
    drop();
  } else if (state === ST.OVER && overT > 0.8) {
    state = ST.MENU;
    tower = []; fall = null; score = 0; combo = 0;
    particles = []; texts = []; newBest = false;
    sfx.click();
  }
}

cvs.addEventListener('pointerdown', function(e) {
  e.preventDefault();
  const r = cvs.getBoundingClientRect();
  handleInput(e.clientX - r.left, e.clientY - r.top);
});
window.addEventListener('keydown', function(e) {
  if (e.repeat) return;
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    handleInput(W/2, H/2);
  } else if (e.code === 'KeyM') {
    toggleMute();
    sfx.click();
  } else if (e.code === 'KeyL') {
    cycleLang();
    sfx.click();
  }
});

camY = H * 0.35;

let last = performance.now();
function frame(now) {
  try {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    update(dt);
    render();
  } catch (e) {
    console.error('SkyStack render error:', e);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
