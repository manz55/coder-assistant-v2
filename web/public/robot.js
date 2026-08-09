import { getRMSLevel } from './audio-analyser.js';

// Canvas-based organic orb + aura. Deliberately not SVG/CSS: the wobble needs
// per-frame control over an irregular boundary and audio-driven distortion,
// which reads as mechanical with pure CSS transforms.

const SIZE   = 260; // logical (CSS) px — canvas backing store scales by DPR
const CORE_R = 34;
const N_PTS  = 10;  // points around the blob boundary

// ── State ─────────────────────────────────────────────────────────────────────

let _state     = 'idle';
let _micNode   = null;
let _outNode   = null;
let _container = null;
let canvas, ctx;

let micLvl = 0;
let outLvl = 0;

// Per-point wobble is eased frame-to-frame so the blob flows instead of
// snapping to each new audio sample — this is what keeps "speaking" from
// looking like it's jolting/exploding.
const pointWobble = new Array(N_PTS).fill(0);

let sparkActive = false;
let sparkStart  = 0;
const SPARK_MS = 750;

let colors = {
  core:   '#6366f1',
  bright: '#818cf8',
  spark:  '#fbbf24',
  err:    '#ef4444',
};

// ── Public API ────────────────────────────────────────────────────────────────

export function initRobot(container) {
  _container = container;
  container.innerHTML = '';

  canvas = document.createElement('canvas');
  canvas.style.width  = SIZE + 'px';
  canvas.style.height = SIZE + 'px';
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = SIZE * dpr;
  canvas.height = SIZE * dpr;
  ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  container.appendChild(canvas);

  readColors();
  _startLoop();
}

export function setMicAnalyser(node) { _micNode = node; }
export function setOutAnalyser(node) { _outNode = node; }

export function setState(s) {
  _state = s;
  if (s === 'idle' || s === 'connecting') {
    micLvl = 0;
    outLvl = 0;
  }
}

export function triggerSpark() {
  sparkActive = true;
  sparkStart  = performance.now();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  colors.core   = pick('--accent', colors.core);
  colors.bright = pick('--accent-bright', colors.bright);
  colors.spark  = pick('--warn-bright', colors.spark);
  colors.err    = pick('--err-bright', colors.err);
}

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  const n = m.length === 3
    ? m.split('').map((c) => c + c).join('')
    : m;
  const int = parseInt(n, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function midpoint(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

function smoothBlobPath(ctx, points) {
  const n = points.length;
  const start = midpoint(points[n - 1], points[0]);
  ctx.beginPath();
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const cur  = points[i];
    const next = points[(i + 1) % n];
    const mid  = midpoint(cur, next);
    ctx.quadraticCurveTo(cur[0], cur[1], mid[0], mid[1]);
  }
  ctx.closePath();
}

// Local-window average per point instead of a single raw sample — a lone
// sample can sit anywhere in the waveform's cycle and jumps wildly frame to
// frame; averaging a small neighborhood gives a calmer, still audio-true value.
function sampleWaveform(analyser, n) {
  const buf = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(buf);
  const windowSize = Math.max(4, Math.floor(buf.length / n / 2));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const center = Math.floor((i / n) * buf.length);
    let sum = 0, count = 0;
    for (let k = -windowSize; k <= windowSize; k++) {
      const idx = center + k;
      if (idx >= 0 && idx < buf.length) { sum += buf[idx]; count++; }
    }
    out[i] = (sum / count - 128) / 128; // -1..1
  }
  return out;
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(t) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  ctx.clearRect(0, 0, SIZE, SIZE);

  // Smoothed audio levels — decay toward 0 when not applicable to the state
  const micTarget = (_state === 'listening' && _micNode) ? getRMSLevel(_micNode) : 0;
  const outTarget = (_state === 'speaking'  && _outNode) ? getRMSLevel(_outNode) : 0;
  micLvl += (micTarget - micLvl) * 0.18;
  outLvl += (outTarget - outLvl) * 0.28;

  const idlePulse = (Math.sin(t * 0.5) + 1) / 2; // smooth, never linear
  const base   = 0.16 + idlePulse * 0.08;
  const energy = _state === 'listening' ? base + micLvl * 0.95
               : _state === 'speaking'  ? base + outLvl * 0.85
               : base;

  const isError = _state === 'error';
  const [r, g, b] = hexToRgb(isError ? colors.err : colors.core);
  const [br, bg, bb] = hexToRgb(isError ? colors.err : colors.bright);

  // ── Aura: 3 async-breathing blurred layers ──
  const auraLayers = [
    { mult: 1.55, opacity: 0.16, speed: 0.35, phase: 0 },
    { mult: 2.05, opacity: 0.10, speed: 0.24, phase: 2.1 },
    { mult: 2.6,  opacity: 0.06, speed: 0.17, phase: 4.4 },
  ];

  for (const layer of auraLayers) {
    const layerPulse = (Math.sin(t * layer.speed + layer.phase) + 1) / 2;
    const radius  = CORE_R * layer.mult * (1 + energy * 0.55 + layerPulse * 0.08);
    const opacity = Math.min(0.9, layer.opacity * (0.6 + energy * 2.2));

    const grad = ctx.createRadialGradient(cx, cy, CORE_R * 0.3, cx, cy, radius);
    grad.addColorStop(0, `rgba(${br}, ${bg}, ${bb}, ${opacity})`);
    grad.addColorStop(1, `rgba(${br}, ${bg}, ${bb}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Core blob boundary ──
  let waveform = null;
  if (_state === 'speaking' && _outNode && outLvl > 0.01) {
    waveform = sampleWaveform(_outNode, N_PTS);
  }

  const wobbleAmp = _state === 'speaking'
    ? 2 + outLvl * 11
    : _state === 'listening'
      ? 2 + micLvl * 9
      : 1.5;

  const points = [];
  for (let i = 0; i < N_PTS; i++) {
    const angle = (i / N_PTS) * Math.PI * 2;
    let target;
    if (waveform) {
      target = waveform[i] * wobbleAmp;
    } else {
      const n1 = Math.sin(t * 0.7 + i * 1.8);
      const n2 = Math.sin(t * 1.4 + i * 3.2 + 10);
      target = (n1 * 0.6 + n2 * 0.4) * wobbleAmp;
    }
    // Ease toward the new target rather than snapping — smooths both the
    // raw-waveform jitter (speaking) and any abrupt state changes.
    pointWobble[i] += (target - pointWobble[i]) * 0.22;

    const rr = CORE_R + pointWobble[i];
    points.push([cx + Math.cos(angle) * rr, cy + Math.sin(angle) * rr]);
  }

  const coreGrad = ctx.createRadialGradient(
    cx - CORE_R * 0.3, cy - CORE_R * 0.35, CORE_R * 0.1,
    cx, cy, CORE_R * 1.3
  );
  coreGrad.addColorStop(0,   `rgb(${Math.min(255, br + 25)}, ${Math.min(255, bg + 25)}, ${Math.min(255, bb + 25)})`);
  coreGrad.addColorStop(0.6, `rgb(${r}, ${g}, ${b})`);
  coreGrad.addColorStop(1,   `rgb(${Math.max(0, r - 40)}, ${Math.max(0, g - 40)}, ${Math.max(0, b - 20)})`);

  ctx.save();
  ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.55)`;
  ctx.shadowBlur = 22 + energy * 30;
  smoothBlobPath(ctx, points);
  ctx.fillStyle = coreGrad;
  ctx.fill();
  ctx.restore();

  // ── Fact-saved spark: a ring of distinct color sweeping through the aura ──
  if (sparkActive) {
    const elapsed = performance.now() - sparkStart;
    const progress = elapsed / SPARK_MS;
    if (progress >= 1) {
      sparkActive = false;
    } else {
      const [sr, sg, sb] = hexToRgb(colors.spark);
      const ringR = CORE_R * 0.9 + progress * CORE_R * 3.4;
      const ringOpacity = (1 - progress) * 0.85;
      ctx.save();
      ctx.shadowColor = `rgba(${sr}, ${sg}, ${sb}, ${ringOpacity})`;
      ctx.shadowBlur = 18;
      ctx.strokeStyle = `rgba(${sr}, ${sg}, ${sb}, ${ringOpacity})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function _startLoop() {
  const loop = (now) => {
    requestAnimationFrame(loop);
    render(now / 1000);
  };
  requestAnimationFrame(loop);
}
