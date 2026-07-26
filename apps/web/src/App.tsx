import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_CATEGORIES, normalizeAnswer, startsWithLetter, Lang } from "@stop/shared";
import {
  game, verifyCommit, SpinPayload, RevealPayload, ReviewResultPayload, ScoredCell,
} from "./net/game";
import { Wheel } from "./components/Wheel";
import { t, isRTL, reasonText, UILang } from "./i18n";
import { sfx, isMuted, setMuted } from "./sfx";

const CATS = DEFAULT_CATEGORIES;
const EMOTES = ["🔥", "😮", "😂", "👏", "🫣", "GG"];

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
  connected: boolean; filledCount: number; roundScore: number; lastRoundScore: number;
  totalScore: number; emote: string;
}
/** Colyseus only syncs fields that have changed, so every numeric read is defaulted. */
function playersOf(state: any): PView[] {
  const out: PView[] = [];
  state?.players?.forEach((p: any, pid: string) =>
    out.push({
      pid, name: p.name ?? "?", seat: p.seat ?? 0, isHost: !!p.isHost, ready: !!p.ready,
      connected: p.connected !== false, filledCount: p.filledCount ?? 0,
      roundScore: p.roundScore ?? 0, lastRoundScore: p.lastRoundScore ?? 0,
      totalScore: p.totalScore ?? 0, emote: p.emote ?? "",
    }));
  return out.sort((a, b) => a.seat - b.seat);
}

/** Banked total. roundScore is zeroed the instant it lands in totalScore, so this
 *  is correct in every phase and can never double-count a round. */
const shownScore = (p: PView) => p.totalScore + p.roundScore;
/** The "+N" delta: live during the reveal, the banked figure afterwards. */
const shownDelta = (p: PView) => (p.roundScore !== 0 ? p.roundScore : p.lastRoundScore);

function useCountdown(deadlineTs: number) {
  const [ms, setMs] = useState(() => game.remaining(deadlineTs));
  useEffect(() => {
    setMs(game.remaining(deadlineTs));
    const id = setInterval(() => setMs(game.remaining(deadlineTs)), 200);
    return () => clearInterval(id);
  }, [deadlineTs]);
  return ms;
}

/* ---------------- shared bits ---------------- */

function TimerBar({ deadlineTs, totalMs }: { deadlineTs: number; totalMs: number }) {
  const ms = useCountdown(deadlineTs);
  const pct = totalMs > 0 ? Math.max(0, Math.min(100, (ms / totalMs) * 100)) : 0;
  const secs = Math.ceil(ms / 1000);
  const cls = pct < 18 ? "hot" : pct < 45 ? "warn" : "";
  const last = useRef(secs);
  useEffect(() => {
    if (secs !== last.current && secs <= 5 && secs > 0) sfx.tick();
    last.current = secs;
  }, [secs]);
  return (
    <div className="row" aria-live="off">
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

/** Emotes arrive as "code|timestamp" so a repeat of the same emoji re-triggers. */
function useEmote(raw: string): string | null {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!raw) return;
    const [code, ts] = raw.split("|");
    if (!code || Date.now() - Number(ts) > 4000) return;
    setShown(code);
    const id = setTimeout(() => setShown(null), 1800);
    return () => clearTimeout(id);
  }, [raw]);
  return shown;
}

function EmoteBar() {
  return (
    <div className="emoteBar">
      {EMOTES.map((e) => (
        <button key={e} className="emoteBtn" aria-label={`react ${e}`}
          onClick={(ev) => { ev.stopPropagation(); sfx.pop(); game.emote(e); }}>
          {e}
        </button>
      ))}
    </div>
  );
}

function SoundToggle() {
  const [m, setM] = useState(isMuted);
  return (
    <button className="iconBtn" aria-label={m ? "unmute" : "mute"}
      onClick={() => { setMuted(!m); setM(!m); if (m) sfx.pop(); }}>
      {m ? "🔇" : "🔊"}
    </button>
  );
}

/* ---------------- HOME ---------------- */

function Home({ lang, setLang, onError }: { lang: UILang; setLang: (l: UILang) => void; onError: (m: string) => void }) {
  const [name, setName] = useState(() => localStorage.getItem("stop.name") ?? "");
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("join")?.toUpperCase() ?? "");
  const [busy, setBusy] = useState(false);
  const [rounds, setRounds] = useState(5);
  const [difficulty, setDifficulty] = useState<"easy" | "hard">("easy");
  const [secs, setSecs] = useState(90);
  const saveName = (v: string) => { setName(v); localStorage.setItem("stop.name", v); };

  const go = async (fn: () => Promise<void>) => {
    if (!name.trim()) { onError(t("yourName", lang)); return; }
    setBusy(true);
    try { await fn(); } catch (e: any) {
      onError(e?.message === "room_not_found" ? "Room not found" : "Connection failed");
    }
    setBusy(false);
  };

  return (
    <div className="stack" style={{ marginTop: 4 }}>
      <div className="topBar">
        <div className="row" style={{ gap: 6 }}>
          {(["en", "fr", "ar"] as UILang[]).map((l) => (
            <button key={l} className={`pill ${l === lang ? "on" : ""}`} onClick={() => setLang(l)}>
              {l === "en" ? "EN" : l === "fr" ? "FR" : "ع"}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <SoundToggle />
      </div>

      <div className="brand">
        <span className="word">STOP!</span>
        <span className="tag">{t("tagline", lang)}</span>
      </div>

      <input className="input" placeholder={t("yourName", lang)} value={name}
        maxLength={16} onChange={(e) => saveName(e.target.value)}
        autoComplete="off" autoCorrect="off" spellCheck={false} />

      <div className="card stack" style={{ gap: 12 }}>
        <div className="segRow">
          <span className="segLabel">{t("rounds", lang)}</span>
          <div className="seg">
            {[3, 5, 8].map((r) => (
              <button key={r} className={rounds === r ? "on" : ""} onClick={() => setRounds(r)}>{r}</button>
            ))}
          </div>
        </div>
        <div className="segRow">
          <span className="segLabel">{t("seconds", lang)}</span>
          <div className="seg">
            {[60, 90, 120].map((s) => (
              <button key={s} className={secs === s ? "on" : ""} onClick={() => setSecs(s)}>{s}s</button>
            ))}
          </div>
        </div>
        <div className="segRow">
          <span className="segLabel">{t("difficulty", lang)}</span>
          <div className="seg">
            <button className={difficulty === "easy" ? "on" : ""} onClick={() => setDifficulty("easy")}>{t("easy", lang)}</button>
            <button className={difficulty === "hard" ? "on" : ""} onClick={() => setDifficulty("hard")}>{t("hard", lang)}</button>
          </div>
        </div>
        <button className="btn red" disabled={busy}
          onClick={() => go(() => game.createRoom(name.trim(), { lang, rounds, difficulty, roundSeconds: secs }))}>
          {t("createRoom", lang)}
        </button>
        <button className="btn ghost" disabled={busy}
          onClick={() => go(() => game.createSolo(name.trim(), { lang, rounds, difficulty, roundSeconds: secs }))}>
          🕐 {t("soloPlay", lang)}
        </button>
      </div>

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
  const enough = players.length >= 2 || !!state.solo;
  return (
    <div className="stack">
      <div className="topBar">
        <span className="chip">{state.totalRounds} × {t("round", lang)}</span>
        {state.aiReferee && <span className="chip ai">✨ {t("aiRef", lang)}</span>}
        <div className="spacer" />
        <SoundToggle />
      </div>

      <div className="brand"><span className="word" style={{ fontSize: 32 }}>STOP!</span></div>

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
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ellipsis">{p.name}{p.pid === me?.pid ? " ✦" : ""}</div>
              <div className="muted" style={{ fontSize: 11 }}>{p.isHost ? t("host", lang) : ""}</div>
            </div>
            <span className={`dot ${p.connected ? "" : "off"}`} />
            {p.ready && <span className="chip ok">{t("ready", lang)}</span>}
          </div>
        ))}
        {!enough && <div className="muted center">{t("waiting", lang)}</div>}
      </div>

      <div className="spacer" />
      {me?.isHost ? (
        <button className="btn red" disabled={!enough} onClick={() => { sfx.pop(); game.start(); }}>
          {t("start", lang)}
        </button>
      ) : (
        <button className={`btn ${me?.ready ? "ghost" : ""}`} onClick={() => { sfx.pop(); game.ready(!me?.ready); }}>
          {me?.ready ? "✓ " : ""}{t("ready", lang)}
        </button>
      )}
    </div>
  );
}

/* ---------------- SPIN ---------------- */

function SpinScreen({ state, lang, spin }: { state: any; lang: UILang; spin: SpinPayload | null }) {
  const ms = useCountdown(state.deadlineTs);
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
          muted={isMuted()}
        />
      ) : (
        <div className="bigLetter" style={{ padding: "40px 0" }}>{Math.max(1, Math.ceil(ms / 1000))}</div>
      )}
      {spin?.commitHash && (
        <div className="fairBadge" title={spin.commitHash}>🔒 {spin.commitHash.slice(0, 12)}…</div>
      )}
    </div>
  );
}

/* ---------------- PLAY ---------------- */

/** Instant, client-only feedback. The server still decides; this just stops
 *  a player wasting the round on an answer that can't possibly count. */
function localHint(value: string, letter: string, lang: Lang, others: string[]): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!startsWithLetter(v, letter, lang)) return "mustStart";
  const n = normalizeAnswer(v, lang);
  if (n && others.includes(n)) return "sameTwice";
  return null;
}

function Play({ state, lang }: { state: any; lang: UILang }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const players = playersOf(state);
  const me = players.find((p) => p.pid === game.room?.sessionId);
  const others = players.filter((p) => p.pid !== me?.pid);
  const totalMs = (state.roundSeconds || 120) * 1000;
  const roomLang = state.language as Lang;

  useEffect(() => {
    game.onRestore = (a) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(a)) next[k] = (v as any).raw ?? "";
      setAnswers(next);
    };
    setAnswers({});
    setTimeout(() => inputs.current[CATS[0].key]?.focus(), 250);
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
    flush(CATS[i].key);
    const next = CATS[i + 1]?.key;
    if (next) inputs.current[next]?.focus();
    else (document.activeElement as HTMLElement)?.blur();
  };

  const filledCount = CATS.filter((c) => (answers[c.key] ?? "").trim()).length;
  const allFilled = filledCount === CATS.length;
  const grace = state.phase === "STOP_GRACE";
  const graceMs = useCountdown(grace ? state.deadlineTs : 0);
  const stopper = players.find((p) => p.pid === state.stoppedBy);

  useEffect(() => { if (grace) sfx.alarm(); }, [grace]);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="topBar">
        <span className="chip letter big">{state.letter}</span>
        <span className="muted">{t("round", lang)} {state.roundIndex + 1}/{state.totalRounds}</span>
        <div className="spacer" />
        <span className="progressPill">{filledCount}/{CATS.length}</span>
      </div>
      <TimerBar deadlineTs={state.deadlineTs} totalMs={totalMs} />

      {state.solo ? (
        <div className="muted center" style={{ fontSize: 12 }}>{t("soloNoRivals", lang)}</div>
      ) : (
        <div className="oppStrip" aria-label="opponents progress">
          {others.map((p) => <OppPill key={p.pid} p={p} total={CATS.length} />)}
        </div>
      )}

      <div className="stack" style={{ gap: 9 }}>
        {CATS.map((c, i) => {
          const v = answers[c.key] ?? "";
          const mine = CATS.filter((o) => o.key !== c.key)
            .map((o) => normalizeAnswer(answers[o.key] ?? "", roomLang))
            .filter(Boolean);
          const hint = localHint(v, state.letter, roomLang, mine);
          const ok = v.trim() && !hint;
          return (
            <div className="catRow" key={c.key}>
              <label className="catLabel" htmlFor={`f-${c.key}`}>
                <span className="catIcon" aria-hidden="true">{c.icon}</span>
                {c.label[lang]}
                {ok && <span className="tickOk">✓</span>}
              </label>
              <input
                id={`f-${c.key}`}
                ref={(el) => { inputs.current[c.key] = el; }}
                className={`input ${ok ? "filled" : ""} ${hint ? "warnInput" : ""}`}
                value={v}
                placeholder={`${state.letter}…`}
                maxLength={40}
                enterKeyHint={i === CATS.length - 1 ? "done" : "next"}
                autoComplete="off" autoCorrect="off" spellCheck={false} autoCapitalize="words"
                onChange={(e) => setAns(c.key, e.target.value)}
                onBlur={() => flush(c.key)}
                onKeyDown={(e) => { if (e.key === "Enter") jumpNext(i); }}
              />
              {hint && (
                <div className="fieldHint">
                  {hint === "mustStart"
                    ? `${t("mustStart", lang)} “${state.letter}”`
                    : t("sameTwice", lang)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!state.solo && <EmoteBar />}

      <button
        className={`stopBtn ${allFilled ? "armed" : ""}`}
        disabled={!allFilled || grace}
        aria-label={t("stop", lang)}
        onClick={() => { sfx.alarm(); CATS.forEach((c) => flush(c.key)); game.stop(); }}
      >
        {t("stop", lang)}
      </button>
      {!allFilled && <div className="muted center">{t("fillAllToStop", lang)}</div>}

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

function OppPill({ p, total }: { p: PView; total: number }) {
  const emote = useEmote(p.emote);
  return (
    <div className="oppPill">
      <Avatar name={p.name} mini />
      <span className="ellipsis" style={{ maxWidth: 72 }}>{p.name}</span>
      <span className="oppBar"><i style={{ width: `${(p.filledCount / total) * 100}%` }} /></span>
      {!p.connected && <span className="dot off" />}
      {emote && <span className="emoteFloat">{emote}</span>}
    </div>
  );
}

/* ---------------- CHECKING ---------------- */

function Checking({ state, lang }: { state: any; lang: UILang }) {
  return (
    <div className="stack center" style={{ gap: 18, paddingTop: 60 }}>
      <span className="chip letter big">{state.letter}</span>
      <div className="scanner"><i /></div>
      <div className="display" style={{ fontSize: 18 }}>{t("checking", lang)}</div>
      {state.aiReferee && <div className="muted">✨ {t("aiRef", lang)}</div>}
    </div>
  );
}

/* ---------------- REVEAL ---------------- */

function cellClass(a: ScoredCell | undefined): string {
  if (!a || !a.raw.trim() || a.verdict === "empty") return "bad";
  if (a.verdict === "invalid") return "bad";
  if (a.verdict === "uncertain") return "pend";
  return a.unique ? "unique" : "dup";
}

function Reveal({ state, lang, reveal }: { state: any; lang: UILang; reveal: RevealPayload | null }) {
  const players = playersOf(state);
  const me = game.room?.sessionId;
  const [stage, setStage] = useState(0);
  const [fair, setFair] = useState<boolean | null>(null);
  const review = state.review;

  // A new round's reveal always starts from the first card. Re-broadcasts caused by
  // a table vote re-score must NOT rewind the animation, so this keys off the phase
  // transition into LOCKED, never off roundIndex (which ticks over at SCORED).
  useEffect(() => { if (state.phase === "LOCKED") setStage(0); }, [state.phase]);

  useEffect(() => {
    if (!reveal) return;
    if (reveal.nonce) verifyCommit(reveal.letter, reveal.nonce, reveal.commitHash).then(setFair);
  }, [reveal]);

  useEffect(() => {
    if (!reveal || stage >= CATS.length) return;
    const id = setTimeout(() => { setStage((s) => s + 1); sfx.pop(); }, 850);
    return () => clearTimeout(id);
  }, [reveal, stage]);

  if (!reveal) return <Checking state={state} lang={lang} />;

  const visible = CATS.slice(0, Math.max(1, stage));
  const canReady = state.phase === "REVEAL" || state.phase === "SCORED";

  return (
    <div className="stack" style={{ gap: 12 }} onClick={() => setStage(CATS.length)}>
      <div className="topBar">
        <span className="chip letter">{reveal.letter}</span>
        <span className="muted">{t("round", lang)} {Math.min(state.roundIndex + 1, state.totalRounds)}/{state.totalRounds}</span>
        <div className="spacer" />
        {fair === true && <span className="fairBadge">✓ {t("fairV", lang)}</span>}
      </div>

      {visible.map((c) => (
        <div className="card revealCat" key={c.key}>
          <div className="catLabel">
            <span className="catIcon" aria-hidden="true">{c.icon}</span>{c.label[lang]}
          </div>
          {players.map((p) => {
            const a = reveal.scored[p.pid]?.[c.key];
            const cls = cellClass(a);
            const canFlag =
              state.phase === "REVEAL" && p.pid !== me && a && a.raw.trim() &&
              a.verdict === "valid" && !a.reviewed && !review?.open;
            const why = reasonText(a?.reason, lang);
            return (
              <div className={`ansRow ${cls}`} key={p.pid}>
                <Avatar name={p.name} mini />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ansText">{a?.raw?.trim() || "—"}</div>
                  {why && <div className="ansWhy">{why}</div>}
                </div>
                <span className={`badge ${cls}`}>
                  {/* "Only one!" is a boast about beating other players — meaningless solo */}
                  {cls === "unique" ? t(state.solo ? "validBadge" : "unique", lang)
                    : cls === "dup" ? t("duplicate", lang)
                    : cls === "pend" ? t("underReview", lang)
                    : a?.raw?.trim() ? t("invalid", lang) : t("blank", lang)}
                </span>
                <span className={`pts ${cls}`}>+{a?.points ?? 0}</span>
                {canFlag && (
                  <button className="flag" title={t("challenge", lang)}
                    onClick={(e) => { e.stopPropagation(); sfx.pop(); game.challenge(p.pid, c.key); }}>
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
        {[...players].sort((a, b) => shownScore(b) - shownScore(a)).map((p, i) => (
          <div className={`scoreRow ${i === 0 ? "first" : ""}`} key={p.pid}>
            <span className="rankNum">{i + 1}</span>
            <Avatar name={p.name} mini />
            <span className="ellipsis" style={{ flex: 1 }}>{p.name}</span>
            <span className="delta">+{shownDelta(p)}</span>
            <span className="scoreVal">{shownScore(p)}</span>
          </div>
        ))}
      </div>

      {!state.solo && <EmoteBar />}
      {canReady && <NextRoundGate state={state} lang={lang} />}
      {review?.open && <VoteSheet state={state} lang={lang} />}
    </div>
  );
}

function NextRoundGate({ state, lang }: { state: any; lang: UILang }) {
  const players = playersOf(state);
  const me = players.find((p) => p.pid === game.room?.sessionId);
  const connected = players.filter((p) => p.connected);
  const readyCount = connected.filter((p) => p.ready).length;
  const blocked = state.review?.open;
  return (
    <div className="card stack center gate" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
      {/* Solo has nobody to wait for, so the gate is just a continue button. */}
      {!state.solo && (
        <>
          <div className="readyDots">
            {connected.map((p) => (
              <span key={p.pid} className={`readyDot ${p.ready ? "on" : ""}`} title={p.name} />
            ))}
          </div>
          <div className="muted">{readyCount}/{connected.length} {t("ready", lang)}</div>
        </>
      )}
      <button className={`btn ${me?.ready && !state.solo ? "ghost" : "red"}`} disabled={blocked}
        onClick={() => { sfx.pop(); game.ready(!me?.ready); }}>
        {me?.ready && !state.solo ? `✓ ${t("ready", lang)}` : t("nextRound", lang)}
      </button>
      {me?.ready && !blocked && !state.solo && <div className="muted center">{t("waitingOthers", lang)}</div>}
    </div>
  );
}

/* ---------------- TABLE VOTE ---------------- */

function VoteSheet({ state, lang }: { state: any; lang: UILang }) {
  const r = state.review;
  const cat = CATS.find((c) => c.key === r.category);
  const me = game.room?.sessionId;
  const iAmTarget = me === r.targetPid;
  const [voted, setVoted] = useState(false);
  const ms = useCountdown(r.deadlineTs);
  useEffect(() => { setVoted(false); sfx.alarm(); }, [r.targetPid, r.category, r.answer]);

  const cast = (valid: boolean) => {
    setVoted(true);
    if (valid) sfx.good(); else sfx.bad();
    game.vote(valid);
  };

  return (
    <div className="sheet stack center" onClick={(e) => e.stopPropagation()}>
      <div className="sheetHead">
        <span className="chip warn">⚖️ {t("tableVote", lang)}</span>
        <div className="spacer" />
        <span className="voteClock">{Math.max(0, Math.ceil(ms / 1000))}</span>
      </div>

      <div className="muted center">
        {r.source === "peer" ? t("peerFlagHdr", lang) : t("aiUnsureHdr", lang)}
      </div>
      <div className="muted center" style={{ fontSize: 11 }}>
        {r.targetName} · {cat?.icon} {cat?.label[lang]}
      </div>
      <div className="display voteWord">“{r.answer}”</div>
      {reasonText(r.reason, lang) && <div className="muted center">{reasonText(r.reason, lang)}</div>}

      {iAmTarget ? (
        <div className="muted center" style={{ padding: "10px 0" }}>{t("yourAnswer", lang)}</div>
      ) : (
        <>
          <div className="muted">{t("voteQ", lang)}</div>
          <div className="row" style={{ justifyContent: "center", gap: 12 }}>
            <button className="btn voteBtn ok" disabled={voted} onClick={() => cast(true)}>
              ✓ {t("voteValid", lang)}
            </button>
            <button className="btn voteBtn no" disabled={voted} onClick={() => cast(false)}>
              ✗ {t("voteInvalid", lang)}
            </button>
          </div>
        </>
      )}

      <div className="muted" style={{ fontSize: 11 }}>
        {r.votesValid + r.votesInvalid}/{r.voters} {t("votesIn", lang)}
        {r.remaining > 0 && ` · ${r.remaining} ${t("moreQueued", lang)}`}
      </div>
    </div>
  );
}

/* ---------------- PODIUM ---------------- */

function Podium({ state, lang, standings }: { state: any; lang: UILang; standings: any[] }) {
  const players = playersOf(state);
  const me = players.find((p) => p.pid === game.room?.sessionId);
  const connected = players.filter((p) => p.connected);
  const readyCount = connected.filter((p) => p.ready).length;
  const [s1, s2, s3] = standings;
  useEffect(() => { sfx.win(); }, []);
  return (
    <div className="stack center">
      <div className="brand"><span className="word" style={{ fontSize: 30 }}>STOP!</span></div>

      {state.solo ? (
        // No rostrum for one player — the number is the whole story.
        <>
          <div className="muted">{t("soloDone", lang)}</div>
          <div className="display soloScore">{s1?.score ?? 0}</div>
          <div className="muted">
            {state.totalRounds} × {t("round", lang)} · {t("soloNoRivals", lang)}
          </div>
        </>
      ) : (
        <>
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
        </>
      )}

      {!state.solo && <EmoteBar />}
      <div className="spacer" />
      {!state.solo && (
        <div className="muted center">{readyCount}/{connected.length} {t("playAgain", lang)}</div>
      )}
      <button className={`btn ${me?.ready && !state.solo ? "ghost" : "red"}`}
        onClick={() => { sfx.pop(); game.ready(!me?.ready); }}>
        {me?.ready && !state.solo ? `✓ ${t("ready", lang)}` : t("playAgain", lang)}
      </button>
      {me?.ready && !state.solo && <div className="muted center">{t("waitingOthers", lang)}</div>}
      <button className="btn ghost" onClick={() => { game.leave(); location.reload(); }}>{t("leave", lang)}</button>
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
    game.onReviewResult = (p: ReviewResultPayload) => {
      if (p.valid) sfx.good(); else sfx.bad();
      showToast(`“${p.answer}” — ${p.valid ? t("accepted", roomLang) : t("rejected", roomLang)} ${p.votes.valid}–${p.votes.invalid}`);
    };
  }, [roomLang, showToast]);

  const phase = state?.phase ?? "NONE";

  return (
    <div className="app">
      <Toast msg={toast} />
      {phase === "NONE" && <Home lang={lang} setLang={setLang} onError={showToast} />}
      {phase === "LOBBY" && <Lobby state={state} lang={roomLang} onToast={showToast} />}
      {(phase === "COUNTDOWN" || phase === "SPINNING") &&
        <SpinScreen state={state} lang={roomLang} spin={phase === "SPINNING" ? spin : null} />}
      {(phase === "WRITING" || phase === "STOP_GRACE") && <Play state={state} lang={roomLang} />}
      {phase === "LOCKED" && <Checking state={state} lang={roomLang} />}
      {(phase === "REVEAL" || phase === "SCORED") && <Reveal state={state} lang={roomLang} reveal={reveal} />}
      {phase === "MATCH_END" && <Podium state={state} lang={roomLang} standings={standings} />}
    </div>
  );
}
