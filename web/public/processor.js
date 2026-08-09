// AudioWorklet processor — downsamples to 16 kHz and converts to PCM16
// Runs in the audio rendering thread; communicates via port.postMessage

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._ratio = sampleRate / 16000; // e.g. 3.0 at 48 kHz, 2.75625 at 44.1 kHz
    this._outChunk = 2048;            // output samples per message (~128 ms at 16 kHz)
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);

    const inChunk = Math.round(this._outChunk * this._ratio);

    while (this._buf.length >= inChunk) {
      const chunk = this._buf.splice(0, inChunk);
      const out = new Int16Array(this._outChunk);

      for (let i = 0; i < this._outChunk; i++) {
        // Linear interpolation for clean downsampling
        const pos = i * this._ratio;
        const lo  = Math.floor(pos);
        const hi  = Math.min(lo + 1, chunk.length - 1);
        const s   = chunk[lo] + (chunk[hi] - chunk[lo]) * (pos - lo);
        out[i]    = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      }

      this.port.postMessage(out.buffer, [out.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
