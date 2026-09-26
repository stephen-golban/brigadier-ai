/**
 * Dictation's audio worklet: the microphone's samples, at whatever rate the device runs,
 * turned into what the speech engine takes (16 kHz mono 16-bit PCM) and posted about every
 * half second. "flush" posts what's left, then "flushed".
 */

// The audio worklet scope's globals (TypeScript's DOM library doesn't describe it).
declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor & { process(inputs: Float32Array[][]): boolean },
): void;

const TARGET_RATE = 16_000;
const CHUNK = TARGET_RATE / 2;

class Pcm16 extends AudioWorkletProcessor {
  /** Input samples per output sample. */
  readonly #step = sampleRate / TARGET_RATE;
  /** Where the next output sample starts, in input samples from the first pending one. */
  #at = 0;
  #pending: number[] = [];
  #out = new Int16Array(CHUNK);
  #length = 0;

  constructor() {
    super();
    this.port.addEventListener("message", (event: MessageEvent) => {
      if (event.data !== "flush") return;
      this.#post();
      this.port.postMessage("flushed", []);
    });
    this.port.start();
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) this.#pending.push(sample);
    // Each output sample is the mean of the input samples it covers: a box filter, enough
    // against aliasing for speech.
    while (this.#at + this.#step <= this.#pending.length) {
      const from = Math.floor(this.#at);
      const to = Math.max(from + 1, Math.floor(this.#at + this.#step));
      let sum = 0;
      for (let i = from; i < to; i++) sum += this.#pending[i] ?? 0;
      const value = Math.max(-1, Math.min(1, sum / (to - from)));
      this.#out[this.#length++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      if (this.#length === CHUNK) this.#post();
      this.#at += this.#step;
    }
    const used = Math.floor(this.#at);
    this.#pending = this.#pending.slice(used);
    this.#at -= used;
    return true;
  }

  #post(): void {
    if (this.#length === 0) return;
    const chunk = this.#out.slice(0, this.#length);
    this.port.postMessage(chunk, [chunk.buffer]);
    this.#length = 0;
  }
}

registerProcessor("pcm16", Pcm16);
