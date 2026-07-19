import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_CATEGORIES } from "@stop/shared";
import { game, verifyCommit, SpinPayload, RevealPayload } from "./net/game";
import { Wheel } from "./components/Wheel";
import { t, isRTL, UILang } from "./i18n";

/* ---------------- state plumbing ---------------- */

function useGame() {
  const subscribe = useCallback((cb: () => void) => {
    game.listeners.add(cb);
    return () => { game.listeners.delete(cb); };
  }, []);
  useSyncExternalStore(subscribe, () => game.room?.state?.phase ?? "NONE");
  // re-render on every patch (cheap; state graph is small)
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((x) => x + 1);
    game.listeners.add(cb);
    return () => { game.listeners.delete(cb); };
  }, []);
  return game.room?.state as any | undefined;
}

interface PView {
  pid: string; name: string; seat: number; isHost: boolean; ready: boolean;
  connected: boolean; filledCount: number; roundScore: number; totalScore: number; emote: string;
}
function playersOf(state: any): PView[] {
  const out: PView[] = [];
  state?.players?.forEach((p: any, pid: string) =>
    out.push({ pid, name: p.name, seat: p.seat, isHost: p.isHost, ready: p.ready,
      connected: p.connected, filledCount: p.filledCount, roundScore: p.roundScore,
      totalScore: p.totalScore, emote: p.emote }));
  return out.sort((a, b) => a.seat - b.seat);
}

function useCountdown(deadlineTs: number) {
  const [ms, setMs] = useState(() => game.remaining(deadlineTs));
  useEffect(() => {
    const id = setInterval(() => setMs(game.remaining(deadlineTs)), 250);
    return () => clearInterval(id);
  }, [deadlineTs]);
  return ms;
}

/* ---------------- shared bits ---------------- */

function TimerBar({ deadlineTs, totalMs, lang }: { deadlineTs: number; totalMs: number; lang: UILang }) {
  const ms = useCountdown(deadlineTs);
  const pct = totalMs > 0 ? Math.max(0, Math.min(100, (ms / totalMs) * 100)) : 0;
  const secs = Math.ceil(ms / 1000);
  const cls = pct < 18 ? "hot" : pct < 45 ? "warn" : "";
  return (
    <div className="row" aria-live="polite">
      <div className={`timerBar ${cls}`} style={{ flex: 1 }}><i style={{ width: `${pct}%` }} /></div>
      <div className={`timerNum ${cls === "hot" ? "hot" : ""}`}>{secs}</div>
    </div>
  );
}

function Avatar({ name, mini }: { name: string; mini?: boolean }) {
  const hue = useMemo(() => {
    let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h;
  }, [name]);
  return (
    <div className={`avatar ${mini ? "mini" : ""}`} style={{ background: `hsl(${hue} 75% 62%)` }}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function Toast({ msg }: { msg: string }) {
  if (!msg) return null;
  return <div className="toast"><div>{msg}</div></div>;
}

/* ---------------- HOME ---------------- */

function Home({ lang, setLang, onError }: { lang: UILang; setLang: (l: UILang) => void; onError: (m: string) => void }) {
  const [name, setName] = useState(() => localStorage.getItem("stop.name") ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const saveName = (v: string) => { setName(v); localStorage.setItem("stop.name", v); };

  const go = async (fn: () => Promise<void>) => {
    if (!name.trim()) { onError(t("yourName", lang)); return; }
    setBusy(true);
    try { await fn(); } catch (e: any) { onError(e?.message === "room_not_found" ? "Room not found" : "Connection failed"); }
    setBusy(false);
  };

  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <div className="brand">
        <span className="word">STOP!</span>
        <span className="tag">{t("tagline", lang)}</span>
      </div>

      <div className="row" style={{ justifyContent: "center", gap: 8 }}>
        {(["en", "fr", "ar"] as UILang[]).map((l) => (
          <button key={l} className={`btn small ${l === lang ? "red" : "ghost"}`} onClick={() => setLang(l)}>
            {l === "en" ? "EN" : l === "fr" ? "FR" : "ع"}
          </button>
        ))}
      </div>

      <input className="input" placeholder={t("yourName", lang)} value={name}
        maxLength={16} onChange={(e) => saveName(e.target.value)}
        autoComplete="off" autoCorrect="off" spellCheck={false} />

      <button className="btn red" disabled={busy} onClick={() => go(() => game.createRoom(name.trim(), lang, false))}>
        {t("createRoom", lang)}
      </button>
      <button className="btn" disabled={busy} onClick={() => go(() => game.quickMatch(name.trim(), lang))}>
        {t("quickMatch", lang)}
      </button>

      <div className="card stack" style={{ gap: 10 }}>
        <div className="muted center">{t("joinCode", lang)}</div>
        <input className="input code" placeholder="ABC123" maxLength={6} value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          autoComplete="off" autoCorrect="off" spellCheck={false} />
        <button className="btn ghost" disabled={busy || code.length < 6}
          onClick={() => go(() => game.joinByCode(name.trim(), code))}>
          {t("joinCode", lang)} →
        </button>
      </div>
    </div>
  );
}

/* ---------------- LOBBY ---------------- */

function Lobby({ state, lang, onToast }: { state: any; lang: UILang; onToast: (m: string) => void }) {
  const players = playersOf(state);
  const me = players.find((p) => p.pid === game.room?.sessionId);
  const copyInvite = async () => {
    const text = `${location.origin}?join=${state.roomCode}`;
    try { await navigator.clipboard.writeText(text); onToast(t("copied", lang)); } catch { /* noop */ }
  };
  return (
    <div className="stack">
      <div className="brand"><span className="word" style={{ fontSize: 30 }}>STOP!</span></div>
      <div className="card stack" style={{ gap: 6 }}>
        <div className="muted center">{t("code", lang)}</div>
        <div className="codebox" onClick={copyInvite} title="copy">{state.roomCode}</div>
        <button className="btn ghost small" style={{ alignSelf: "center" }} onClick={copyInvite}>
          {t("share", lang)}
        </button>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        {players.map((p) => (
          <div key={p.pid} className="playerRow">
            <Avatar name={p.name} />
            <div style={{ flex: 1 }}>
              <div>{p.name}{p.pid === me?.pid ? " ✦" : ""}</div>
              <div className="muted" style={{ fontSize: 11 }}>{p.isHost ? t("host", lang) : ""}</div>
            </div>
            <span className={`dot ${p.connected ? "" : "off"}`} />
            {p.ready && <span className="chip" style={{ borderColor: "var(--green)", color: "var(--green)" }}>{t("ready", lang)}</span>}
          </div>
        ))}
        {players.length < 2 && <div className="muted center">{t("waiting", lang)}</div>}
      </div>

      <div className="spacer" />
      {me?.isHost ? (
        <button className="btn red" onClick={() => game.start()}>{t("start", lang)}</button>
      ) : (
        <button className={`btn ${me?.ready ? "ghost" : ""}`} onClick={() => game.ready(!me?.ready)}>
          {me?.ready ? "✓ " : ""}{t("ready", lang)}
        </button>
      )}
    </div>
  );
}

/* ---------------- SPIN ---------------- */

function SpinScreen({ state, lang, spin }: { state: any; lang: UILang; spin: SpinPayload | null }) {
  return (
    <div className="stack center">
      <div className="muted" style={{ marginTop: 10 }}>
        {t("round", lang)} {state.roundIndex + 1} / {state.totalRounds}
      </div>
      {spin ? (
        <Wheel
          pool={spin.pool}
          poolIndex={spin.poolIndex}
          rotations={spin.rotations}
          durationMs={spin.durationMs}
          muted={localStorage.getItem("stop.muted") === "1"}
        />
      ) : (
        <div className="muted" style={{ padding: 60 }}>…</div>
      )}
      {spin?.commitHash && (
        <div className="fairBadge" title={spin.commitHash}>
          🔒 {spin.commitHash.slice(0, 12)}…
        </div>
      )}
    </div>
  );
}

/* ---------------- PLAY ---------------- */

function Play({ state, lang }: { state: any; lang: UILang }) {
  const cats = DEFAULT_CATEGORIES;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const players = playersOf(state);
  const me = players.find((p) => p.pid === game.room?.sessionId);
  const others = players.filter((p) => p.pid !== me?.pid);
  const totalMs = 120_000;

  useEffect(() => {
    game.onRestore = (a) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(a)) next[k] = (v as any).raw ?? "";
      setAnswers(next);
    };
    // reset per round
    setAnswers({});
    setTimeout(() => inputs.current[cats[0].key]?.focus(), 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.roundIndex]);

  const setAns = (key: string, v: string) => {
    setAnswers((a) => ({ ...a, [key]: v }));
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => game.answer(key, v), 300); // debounce → server
  };
  const flush = (key: string) => {
    clearTimeout(timers.current[key]);
    game.answer(key, answers[key] ?? "");
  };
  const jumpNext = (i: number) => {
    flush(cats[i].key);
    const next = cats[i + 1]?.key;
    if (next) inputs.current[next]?.focus();
  };

  const allFilled = cats.every((c) => (answers[c.key] ?? "").trim());
  const grace = state.phase === "STOP_GRACE";
  const graceMs = useCountdown(grace ? state.deadlineTs : 0);
  const stopper = players.find((p) => p.pid === state.stoppedBy);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row">
        <span className="chip letter">{state.letter}</span>
        <span className="muted">{t("round", lang)} {state.roundIndex + 1}/{state.totalRounds}</span>
        <div className="spacer" />
        <span className="muted">{t("startsWith", lang)} “{state.letter}”</span>
      </div>
      <TimerBar deadlineTs={state.deadlineTs} totalMs={totalMs} lang={lang} />

      <div className="oppStrip" aria-label="opponents progress">
        {others.map((p) => (
          <div key={p.pid} className="oppPill">
            <Avatar name={p.name} mini />
            <span>{p.name}</span>
            <span className="oppFill">{p.filledCount}/{cats.length}</span>
            {!p.connected && <span className="dot off" />}
          </div>
        ))}
      </div>

      <div className="stack" style={{ gap: 9 }}>
        {cats.map((c, i) => {
          const v = answers[c.key] ?? "";
          return (
            <div className="catRow" key={c.key}>
              <label className="catLabel" htmlFor={`f-${c.key}`}>
                {c.label[lang]} {v.trim() && <span style={{ color: "var(--green)" }}>✓</span>}
              </label>
              <input
                id={`f-${c.key}`}
                ref={(el) => { inputs.current[c.key] = el; }}
                className={`input ${v.trim() ? "filled" : ""}`}
                value={v}
                placeholder={`${state.letter}…`}
                maxLength={40}
                enterKeyHint={i === cats.length - 1 ? "done" : "next"}
                autoComplete="off" autoCorrect="off" spellCheck={false} autoCapitalize="words"
                onChange={(e) => setAns(c.key, e.target.value)}
                onBlur={() => flush(c.key)}
                onKeyDown={(e) => { if (e.key === "Enter") jumpNext(i); }}
              />
            </div>
          );
        })}
      </div>

      <button
        className={`stopBtn ${allFilled ? "armed" : ""}`}
        disabled={!allFilled || grace}
        aria-label={t("stop", lang)}
        onClick={() => { cats.forEach((c) => flush(c.key)); game.stop(); }}
      >
        {t("stop", lang)}
      </button>

      {grace && (
        <div className="overlay">
          <div className="stack center" style={{ gap: 8 }}>
            <div className="display" style={{ fontSize: 22 }}>
              {stopper ? `${stopper.name} ${t("called", lang)}` : t("timeUp", lang)}
            </div>
            <div className="graceNum" key={Math.ceil(graceMs / 1000)}>
              {Math.max(0, Math.ceil(graceMs / 1000))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- REVEAL ---------------- */

function Reveal({ state, lang, reveal }: { state: any; lang: UILang; reveal: RevealPayload | null }) {
  const cats = DEFAULT_CATEGORIES;
  const players = playersOf(state);
  const me = game.room?.sessionId;
  const [stage, setStage] = useState(0);
  const [fair, setFair] = useState<boolean | null>(null);

  useEffect(() => { setStage(0); }, [state.roundIndex]);
  useEffect(() => {
    if (!reveal) return;
    if (reveal.nonce) verifyCommit(reveal.letter, reveal.nonce, reveal.commitHash).then(setFair);
    const id = setInterval(() => setStage((s) => Math.min(cats.length, s + 1)), 3200);
    return () => clearInterval(id);
  }, [reveal, cats.length]);

  const ch = state.challenge;
  if (!reveal) return <div className="muted center" style={{ padding: 40 }}>…</div>;

  return (
    <div className="stack" style={{ gap: 12 }} onClick={() => setStage((s) => Math.min(cats.length, s + 1))}>
      <div className="row">
        <span className="chip letter">{reveal.letter}</span>
        <span className="muted">{t("round", lang)} {state.roundIndex + 1}</span>
        <div className="spacer" />
        {fair === true && <span className="fairBadge">✓ {t("fairV", lang)}</span>}
      </div>

      {cats.slice(0, Math.max(1, stage + 1)).map((c) => (
        <div className="card revealCat" key={c.key}>
          <div className="catLabel">{c.label[lang]}</div>
          {players.map((p) => {
            const a = reveal.scored[p.pid]?.[c.key];
            const cls = !a || !a.raw.trim() || a.verdict === "invalid" || a.verdict === "empty"
              ? "bad" : a.unique ? "unique" : "dup";
            const pts = a?.points ?? 0;
            const canFlag =
              state.phase === "REVEAL" && p.pid !== me && a && a.raw.trim() &&
              a.verdict !== "invalid" && a.verdict !== "empty" && !ch?.open;
            return (
              <div className={`ansRow ${cls}`} key={p.pid}>
                <Avatar name={p.name} mini />
                <span className="ansText">{a?.raw?.trim() || "—"}</span>
                {a?.verdict === "uncertain" && <span className="muted" style={{ fontSize: 10 }}>?</span>}
                <span className={`pts ${cls === "unique" ? "u" : cls === "dup" ? "d" : "z"}`}>+{pts}</span>
                {canFlag && (
                  <button className="flag" title={t("challenge", lang)}
                    onClick={(e) => { e.stopPropagation(); game.challenge(p.pid, c.key); }}>
                    🚩
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div className="card">
        <div className="catLabel">{t("scoreboard", lang)}</div>
        {[...players].sort((a, b) => (b.totalScore + b.roundScore) - (a.totalScore + a.roundScore)).map((p, i) => (
          <div className="row" key={p.pid} style={{ padding: "6px 2px" }}>
            <span className="rankNum">{i + 1}</span>
            <span style={{ flex: 1 }}>{p.name}</span>
            <span className="muted">+{reveal.totals[p.pid] ?? 0}</span>
            <span className="scoreVal">{p.totalScore + p.roundScore}</span>
          </div>
        ))}
      </div>

      {ch?.open && <VoteSheet state={state} lang={lang} reveal={reveal} />}
    </div>
  );
}

function VoteSheet({ state, lang, reveal }: { state: any; lang: UILang; reveal: RevealPayload }) {
  const ch = state.challenge;
  const players = playersOf(state);
  const target = players.find((p) => p.pid === ch.targetPid);
  const cat = DEFAULT_CATEGORIES.find((c) => c.key === ch.category);
  const answer = reveal.scored[ch.targetPid]?.[ch.category]?.raw ?? "";
  const me = game.room?.sessionId;
  const [voted, setVoted] = useState(false);
  useEffect(() => setVoted(false), [ch.targetPid, ch.category]);
  const iAmTarget = me === ch.targetPid;

  return (
    <div className="sheet stack center" onClick={(e) => e.stopPropagation()}>
      <div className="muted">{target?.name} — {cat?.label[lang]}</div>
      <div className="display" style={{ fontSize: 26 }}>“{answer}”</div>
      <div className="muted">{t("voteQ", lang)}</div>
      <div className="row" style={{ justifyContent: "center" }}>
        <button className="btn small" disabled={voted || iAmTarget}
          onClick={() => { game.vote(true); setVoted(true); }}>
          ✓ {t("voteValid", lang)} ({ch.votesValid})
        </button>
        <button className="btn small red" disabled={voted || iAmTarget}
          onClick={() => { game.vote(false); setVoted(true); }}>
          ✗ {t("voteInvalid", lang)} ({ch.votesInvalid})
        </button>
      </div>
    </div>
  );
}

/* ---------------- PODIUM ---------------- */

function Podium({ state, lang, standings }: { state: any; lang: UILang; standings: any[] }) {
  const me = game.room?.sessionId;
  const isHost = playersOf(state).find((p) => p.pid === me)?.isHost;
  const [s1, s2, s3] = standings;
  return (
    <div className="stack center">
      <div className="brand"><span className="word" style={{ fontSize: 30 }}>STOP!</span></div>
      <div className="muted">{t("winner", lang)}</div>
      <div className="display" style={{ fontSize: 30, color: "var(--amber)" }}>{s1?.name}</div>
      <div className="podium">
        {s2 && <div className="podCol p2"><Avatar name={s2.name} /><div className="podBar">2</div><div className="muted">{s2.score}</div></div>}
        {s1 && <div className="podCol p1"><Avatar name={s1.name} /><div className="podBar">1</div><div className="scoreVal">{s1.score}</div></div>}
        {s3 && <div className="podCol p3"><Avatar name={s3.name} /><div className="podBar">3</div><div className="muted">{s3.score}</div></div>}
      </div>
      <div className="stack" style={{ width: "100%" }}>
        {standings.slice(3).map((s) => (
          <div className="scoreRow" key={s.pid}>
            <span className="rankNum">{s.placement}</span>
            <span style={{ flex: 1, textAlign: "start" }}>{s.name}</span>
            <span className="scoreVal">{s.score}</span>
          </div>
        ))}
      </div>
      <div className="spacer" />
      {isHost && <button className="btn red" onClick={() => game.rematch()}>{t("rematch", lang)}</button>}
      <button className="btn ghost" onClick={() => { game.leave(); location.reload(); }}>← {t("quickMatch", lang)}?</button>
    </div>
  );
}

/* ---------------- ROOT ---------------- */

export default function App() {
  const state = useGame();
  const [lang, setLang] = useState<UILang>(() => (localStorage.getItem("stop.lang") as UILang) || "en");
  const [spin, setSpin] = useState<SpinPayload | null>(null);
  const [reveal, setReveal] = useState<RevealPayload | null>(null);
  const [standings, setStandings] = useState<any[]>([]);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const showToast = useCallback((m: string) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  }, []);

  useEffect(() => { localStorage.setItem("stop.lang", lang); }, [lang]);
  useEffect(() => {
    document.documentElement.dir = isRTL(lang) ? "rtl" : "ltr";
    document.documentElement.lang = lang;
  }, [lang]);

  // room language wins once joined
  const roomLang = (state?.language as UILang) || lang;
  useEffect(() => { if (state?.language && state.language !== lang) setLang(state.language); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state?.language]);

  useEffect(() => {
    game.onSpin = (p) => { setSpin(p); setReveal(null); };
    game.onReveal = (p) => setReveal(p);
    game.onMatchEnd = (p) => setStandings(p.standings ?? []);
    game.onToast = (key) => showToast(t(key, roomLang));
    game.onChallengeResult = (p) =>
      showToast(p.upheld ? `🚩 ${t("invalid", roomLang)}` : `✓ ${t("voteValid", roomLang)}`);
  }, [roomLang, showToast]);

  // deep-link join: ?join=CODE
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("join");
    if (code) {
      const el = document.querySelector<HTMLInputElement>(".input.code");
      if (el) el.value = code.toUpperCase();
    }
  }, []);

  const phase = state?.phase ?? "NONE";

  return (
    <div className="app">
      <Toast msg={toast} />
      {phase === "NONE" && <Home lang={lang} setLang={setLang} onError={showToast} />}
      {phase === "LOBBY" && <Lobby state={state} lang={roomLang} onToast={showToast} />}
      {(phase === "COUNTDOWN" || phase === "SPINNING") && <SpinScreen state={state} lang={roomLang} spin={phase === "SPINNING" ? spin : null} />}
      {(phase === "WRITING" || phase === "STOP_GRACE") && <Play state={state} lang={roomLang} />}
      {(phase === "LOCKED" || phase === "REVEAL" || phase === "SCORED") && <Reveal state={state} lang={roomLang} reveal={reveal} />}
      {phase === "MATCH_END" && <Podium state={state} lang={roomLang} standings={standings} />}
    </div>
  );
}
