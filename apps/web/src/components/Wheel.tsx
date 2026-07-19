import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The wheel is a RENDERER, not a decider. The server picked `poolIndex`
 * before this component ever mounts; we animate a deterministic spin
 * (same seed → same rotations → same landing) so every client in the
 * room watches the identical result. Wheel arcs === true probability.
 */
interface Props {
  pool: string[];
  poolIndex: number;
  rotations: number;
  durationMs: number;
  muted: boolean;
  onDone?: () => void;
}

const SIZE = 320;
const R = SIZE / 2;
const SEG_COLORS = ["#221E2E", "#2B2438"];

const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);

function arcPath(startDeg: number, endDeg: number): string {
  const a0 = ((startDeg - 90) * Math.PI) / 180;
  const a1 = ((endDeg - 90) * Math.PI) / 180;
  const x0 = R + R * Math.cos(a0), y0 = R + R * Math.sin(a0);
  const x1 = R + R * Math.cos(a1), y1 = R + R * Math.sin(a1);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${R} ${R} L ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} Z`;
}

export function Wheel({ pool, poolIndex, rotations, durationMs, muted, onDone }: Props) {
  const n = pool.length;
  const arc = 360 / n;
  const reduced = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );
  const [rot, setRot] = useState(0);
  const [landed, setLanded] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const doneRef = useRef(false);

  // final rotation puts the target segment's CENTER under the top pointer
  const finalRot = rotations * 360 - (poolIndex * arc + arc / 2);

  useEffect(() => {
    doneRef.current = false;
    setLanded(false);

    if (reduced) {
      setRot(finalRot);
      const t = setTimeout(() => { setLanded(true); onDone?.(); }, 500);
      return () => clearTimeout(t);
    }

    // schedule ratchet ticks at each segment-boundary crossing of the easing curve
    if (!muted) {
      try {
        const ctx = (audioRef.current ??= new AudioContext());
        const boundaries = Math.floor(finalRot / arc);
        const maxTicks = 90; // cap scheduling work
        const step = Math.max(1, Math.floor(boundaries / maxTicks));
        for (let b = 1; b <= boundaries; b += step) {
          const target = (b * arc) / finalRot; // eased progress at crossing
          // invert easeOutQuint: t = 1 - (1-p)^(1/5)
          const t = 1 - Math.pow(1 - target, 1 / 5);
          const when = ctx.currentTime + (t * durationMs) / 1000;
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.frequency.value = 1100;
          g.gain.setValueAtTime(0.06, when);
          g.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
          osc.connect(g).connect(ctx.destination);
          osc.start(when);
          osc.stop(when + 0.045);
        }
        // landing thunk
        const land = ctx.currentTime + durationMs / 1000;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.setValueAtTime(190, land);
        osc.frequency.exponentialRampToValueAtTime(70, land + 0.22);
        g.gain.setValueAtTime(0.22, land);
        g.gain.exponentialRampToValueAtTime(0.0001, land + 0.3);
        osc.connect(g).connect(ctx.destination);
        osc.start(land);
        osc.stop(land + 0.32);
      } catch { /* audio blocked — fine */ }
    }

    const raf = requestAnimationFrame(() => setRot(finalRot)); // trigger CSS transition
    const t = setTimeout(() => {
      if (doneRef.current) return;
      doneRef.current = true;
      setLanded(true);
      if (navigator.vibrate) navigator.vibrate(40);
      onDone?.();
    }, durationMs + 120);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolIndex, rotations, durationMs]);

  return (
    <div className="wheelWrap" role="img" aria-label={`Letter wheel — landed on ${pool[poolIndex]}`}>
      <div className="wheelPointer" />
      <svg
        className="wheelSvg"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{
          transform: `rotate(${rot}deg)`,
          transition: reduced ? "none" : `transform ${durationMs}ms cubic-bezier(0.12, 0.84, 0.18, 1)`,
        }}
      >
        <circle cx={R} cy={R} r={R} fill="#171422" />
        {pool.map((letter, i) => {
          const s = i * arc, e = (i + 1) * arc, mid = s + arc / 2;
          const lr = R * 0.78;
          const a = ((mid - 90) * Math.PI) / 180;
          const lx = R + lr * Math.cos(a), ly = R + lr * Math.sin(a);
          const isTarget = landed && i === poolIndex;
          return (
            <g key={i}>
              <path d={arcPath(s, e)} fill={isTarget ? "#FF4433" : SEG_COLORS[i % 2]} stroke="#0E0C15" strokeWidth={2} />
              <text
                x={lx} y={ly}
                fill={isTarget ? "#FFF6E9" : "#CFC6B8"}
                fontSize={n > 24 ? 13 : 16}
                fontFamily="'Archivo Black','Cairo',sans-serif"
                textAnchor="middle" dominantBaseline="central"
                transform={`rotate(${mid} ${lx} ${ly})`}
              >
                {letter}
              </text>
            </g>
          );
        })}
        <circle cx={R} cy={R} r={44} fill="#0E0C15" stroke="#322C42" strokeWidth={3} />
        {landed && (
          <text x={R} y={R + 2} className="wheelHubLetter landed" fontSize={40}
            textAnchor="middle" dominantBaseline="central">
            {pool[poolIndex]}
          </text>
        )}
      </svg>
    </div>
  );
}
