/**
 * Tiny synthesised sound set — no audio files, no network, no library.
 * Every cue is short and quiet; the mute flag is honoured everywhere.
 */
let ctx: AudioContext | null = null;

const muted = () => localStorage.getItem("stop.muted") === "1";
export const isMuted = muted;
export const setMuted = (v: boolean) => localStorage.setItem("stop.muted", v ? "1" : "0");

function tone(freq: number, dur: number, gain: number, type: OscillatorType = "sine", slideTo?: number) {
  if (muted()) return;
  try {
    const c = (ctx ??= new AudioContext());
    if (c.state === "suspended") void c.resume();
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch { /* autoplay blocked — silence is fine */ }
}

export const sfx = {
  tick: () => tone(1200, 0.03, 0.05, "square"),
  good: () => { tone(660, 0.09, 0.09); setTimeout(() => tone(990, 0.13, 0.08), 80); },
  bad: () => tone(220, 0.22, 0.10, "sawtooth", 110),
  pop: () => tone(880, 0.06, 0.07, "triangle"),
  alarm: () => { tone(520, 0.12, 0.11, "square"); setTimeout(() => tone(390, 0.2, 0.11, "square"), 120); },
  win: () => [0, 120, 240, 400].forEach((d, i) =>
    setTimeout(() => tone([523, 659, 784, 1047][i], 0.22, 0.09), d)),
};
