// Utility for real-time audio level analysis via Web Audio API AnalyserNode

export function createAnalyser(ctx, { fftSize = 256, smoothing = 0.8 } = {}) {
  const node = ctx.createAnalyser();
  node.fftSize = fftSize;
  node.smoothingTimeConstant = smoothing;
  return node;
}

// Returns RMS amplitude in [0, 1] — amplified so normal speech reaches ~0.5–0.9
export function getRMSLevel(analyser) {
  const buf = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) {
    const s = (v - 128) / 128;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 5);
}
