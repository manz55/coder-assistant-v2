import { getRMSLevel } from './audio-analyser.js';

// Full-viewport depth-of-field particle field, PS5-home-screen inspired.
// Each particle has a fixed "home" position it organically drifts around
// (never physically simulated/wrapped — positions are derived from
// continuous time functions, same technique as robot.js's blob wobble, so
// motion is always smooth and never snaps or clumps). State only biases
// how far/fast a particle strays from its home, blended in with easing.

// Phones/low-core devices get a cheaper profile: fewer particles, no
// per-particle canvas `filter` (a blur-filter context switch per draw call
// is one of the priciest Canvas2D ops and tanks frame time on mid/low-end
// mobile GPUs), and a capped backing-store resolution.
const LIGHT = window.matchMedia('(max-width: 768px)').matches
  || (navigator.hardwareConcurrency || 8) <= 4
  || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const N = LIGHT ? 16 : 52;
const MAX_DPR = LIGHT ? 1.5 : 2;

let canvas, ctx, W, H, dpr;
let particles = [];
let _state    = 'idle';
let _micNode  = null;
let _outNode  = null;
let _visible  = true;
let _loopQueued = false;

let sparkActive = false;
let sparkStart  = 0;
const SPARK_MS = 950;

let colors = { bright: '#818cf8', spark: '#fbbf24' };

// ── Public API ────────────────────────────────────────────────────────────────

export function initParticles(container) {
  canvas = document.createElement('canvas');
  canvas.style.width  = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  container.innerHTML = '';
  container.appendChild(canvas);
  ctx = canvas.getContext('2d');

  readColors();
  resize();
  window.addEventListener('resize', resize);

  particles = Array.from({ length: N }, makeParticle);

  // Don't burn CPU/GPU animating a canvas nobody can see — pause the whole
  // loop while the tab is backgrounded and pick it back up on return.
  document.addEventListener('visibilitychange', () => {
    _visible = !document.hidden;
    if (_visible) _startLoop();
  });

  _startLoop();
}

export function setMicAnalyser(node) { _micNode = node; }
export function setOutAnalyser(node) { _outNode = node; }

export function setState(s) { _state = s; }

export function triggerSpark() {
  sparkActive = true;
  sparkStart  = performance.now();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  colors.bright = pick('--accent-bright', colors.bright);
  colors.spark  = pick('--warn-bright', colors.spark);
}

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const int = parseInt(n, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function makeParticle() {
  const depth = Math.random(); // 0 = far, 1 = near
  return {
    homeX: Math.random() * (W || window.innerWidth),
    homeY: Math.random() * (H || window.innerHeight),
    depth,
    size: 0.9 + depth * 2.6,
    baseAlpha: 0.10 + depth * 0.42,
    // Two independent sine phases per axis — same layered-noise trick as
    // robot.js's wobble, so idle drift feels organic, not a lone metronome.
    jf1: 0.05 + Math.random() * 0.05,
    jf2: 0.08 + Math.random() * 0.06,
    jp1: Math.random() * Math.PI * 2,
    jp2: Math.random() * Math.PI * 2,
    jamp: 14 + depth * 26,
    biasCurrent: 0, // eased toward the state's target bias each frame
  };
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(t) {
  ctx.clearRect(0, 0, W, H);

  const focusX = W / 2;
  const focusY = H * 0.32; // roughly where the orb sits in the layout

  const isThinking = _state === 'thinking' || _state === 'connecting';
  const isListening = _state === 'listening';
  const isSpeaking  = _state === 'speaking';

  const micLvl = isListening && _micNode ? getRMSLevel(_micNode) : 0;
  const outLvl = isSpeaking  && _outNode ? getRMSLevel(_outNode) : 0;

  const targetBias = isListening ? -1 : isSpeaking ? 1 : 0;
  const speedMult = isThinking ? 2.7 : 1;
  const ampMult   = isThinking ? 1.9 : 1;

  let sparkEnvelope = 0;
  let sparkPhase = 0;
  if (sparkActive) {
    const elapsed = performance.now() - sparkStart;
    const progress = elapsed / SPARK_MS;
    if (progress >= 1) {
      sparkActive = false;
    } else {
      sparkEnvelope = Math.sin(progress * Math.PI); // rises then falls
      sparkPhase = progress;
    }
  }

  const [br, bg, bb] = hexToRgb(colors.bright);
  const [sr, sg, sb] = hexToRgb(colors.spark);

  for (const p of particles) {
    p.biasCurrent += (targetBias - p.biasCurrent) * 0.04;

    const j1 = Math.sin(t * p.jf1 * speedMult + p.jp1) * p.jamp * ampMult;
    const j2 = Math.cos(t * p.jf2 * speedMult + p.jp2) * p.jamp * ampMult * 0.7;
    let x = p.homeX + j1;
    let y = p.homeY + j2;

    // Directional bias toward (listening) or away from (speaking) the orb,
    // as a bounded pixel offset — not a fraction of distance, so far
    // particles never get flung across the screen.
    const dx = focusX - x, dy = focusY - y;
    const dist = Math.hypot(dx, dy) || 1;
    const reactivity = 0.4 + p.depth * 0.7; // near particles respond more
    const audioBoost = isListening ? micLvl : isSpeaking ? outLvl : 0;
    const pull = p.biasCurrent * (34 + audioBoost * 70) * reactivity;
    x += (dx / dist) * pull;
    y += (dy / dist) * pull;

    // Spark: brief converge-then-release impulse, direction flips partway through.
    if (sparkEnvelope > 0.01) {
      const sparkDir = sparkPhase < 0.4 ? 1 : -1; // toward center, then burst out
      const impulse = sparkEnvelope * sparkDir * 26 * (0.5 + p.depth * 0.6);
      x += (dx / dist) * impulse;
      y += (dy / dist) * impulse;
    }

    const alpha = Math.min(0.95, p.baseAlpha * (0.75 + audioBoost * 1.4));
    const [r, g, b] = sparkEnvelope > 0.01
      ? [
          br + (sr - br) * sparkEnvelope,
          bg + (sg - bg) * sparkEnvelope,
          bb + (sb - bb) * sparkEnvelope,
        ]
      : [br, bg, bb];

    ctx.beginPath();
    ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha})`;
    // `filter: blur()` is a per-draw-call context switch — one of the most
    // expensive Canvas2D ops on mobile GPUs. LIGHT profile skips it and
    // leans on alpha alone for the depth-of-field feel instead.
    if (!LIGHT) ctx.filter = p.depth < 0.4 ? `blur(${(0.4 - p.depth) * 2.5}px)` : 'none';
    ctx.arc(x, y, p.size * (1 + sparkEnvelope * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }
  if (!LIGHT) ctx.filter = 'none';
}

function _startLoop() {
  if (_loopQueued) return; // already running, don't stack multiple loops
  _loopQueued = true;
  const loop = (now) => {
    if (!_visible) { _loopQueued = false; return; } // resumed by visibilitychange
    requestAnimationFrame(loop);
    render(now / 1000);
  };
  requestAnimationFrame(loop);
}
