import { Room, Client, Delayed } from "@colyseus/core";
import {
  Ruleset, DEFAULT_RULESET, DEFAULT_CATEGORIES, resolvePool,
  Lang, Verdict, C2S, S2C,
  scoreRound, RoundAnswers, applyChallengeFlip,
} from "@stop/shared";
import { MatchState, Player } from "../state/MatchState";
import { LetterBag, DrawResult, makeRoomCode } from "../rng";
import { validateDeterministic, validateWithAI, PendingAnswer } from "../validation/engine";
import { registerCode, unregisterCode } from "../codeRegistry";
import { persistMatch } from "../persist";

interface JoinOptions { name?: string; }
interface CreateOptions {
  lang?: Lang;
  difficulty?: "easy" | "hard";
  rounds?: number;
  ranked?: boolean;
  private?: boolean;
}

/** Simple token bucket per client — first line of flood defense. */
class Bucket {
  tokens = 30;
  last = Date.now();
  take(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(30, this.tokens + ((now - this.last) / 1000) * 15);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

const sanitizeName = (s: unknown): string =>
  String(s ?? "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim()
    .slice(0, 16) || "Player";

export class MatchRoom extends Room<MatchState> {
  maxClients = 8;

  private rules!: Ruleset;
  private bag!: LetterBag;
  private draw?: DrawResult;
  /** SERVER-PRIVATE: answers are never in synced state until LOCK. */
  private answers: RoundAnswers = {};
  private verdicts: Record<string, Record<string, Verdict>> = {};
  private lastScored: ReturnType<typeof scoreRound> | null = null;
  private challengesUsed: Record<string, number> = {};
  private votes: Record<string, boolean> = {};
  private buckets: Record<string, Bucket> = {};
  private phaseTimer?: Delayed;
  private roundsLog: { letter: string; nonce: string; commitHash: string; stoppedBy: string }[] = [];
  private seatCounter = 0;

  onCreate(options: CreateOptions) {
    const lang: Lang = (["en", "fr", "ar"] as Lang[]).includes(options.lang as Lang)
      ? (options.lang as Lang) : "en";
    const ranked = !!options.ranked;

    this.rules = {
      ...DEFAULT_RULESET,
      language: lang,
      categories: DEFAULT_CATEGORIES,
      letterPool: resolvePool(lang, options.difficulty ?? "easy"),
      roundsPerMatch: Math.min(10, Math.max(1, options.rounds ?? DEFAULT_RULESET.roundsPerMatch)),
      // ranked = authentic mode: you may STOP with blanks, but false stops are punished
      stopRequiresAllFilled: ranked ? false : DEFAULT_RULESET.stopRequiresAllFilled,
      penalizeFalseStop: true,
    };

    this.setState(new MatchState());
    this.state.language = lang;
    this.state.totalRounds = this.rules.roundsPerMatch;
    this.rules.categories.forEach((c) => this.state.categoryKeys.push(c.key));
    this.state.roomCode = makeRoomCode();
    registerCode(this.state.roomCode, this.roomId);
    this.setPrivate(!!options.private);
    this.setMetadata({ code: this.state.roomCode, lang, ranked });

    this.bag = new LetterBag(this.rules.letterPool, this.rules.letterDrawMode);
    this.clock.setInterval(() => (this.state.serverTime = Date.now()), 1000);

    this.onMessage(C2S.READY, (c, m) => this.guard(c, () => this.handleReady(c, !!m?.ready)));
    this.onMessage(C2S.START, (c) => this.guard(c, () => this.handleStart(c)));
    this.onMessage(C2S.ANSWER, (c, m) => this.guard(c, () => this.handleAnswer(c, m), 0.5));
    this.onMessage(C2S.STOP, (c) => this.guard(c, () => this.handleStop(c)));
    this.onMessage(C2S.CHALLENGE, (c, m) => this.guard(c, () => this.handleChallenge(c, m)));
    this.onMessage(C2S.VOTE, (c, m) => this.guard(c, () => this.handleVote(c, !!m?.valid)));
    this.onMessage(C2S.EMOTE, (c, m) => this.guard(c, () => this.handleEmote(c, m)));
  }

  /** rate-limit + never let a bad payload crash the room */
  private guard(client: Client, fn: () => void, cost = 1) {
    const b = (this.buckets[client.sessionId] ??= new Bucket());
    if (!b.take(cost)) return;
    try { fn(); } catch (e) { console.error("intent error", e); }
  }

  onJoin(client: Client, options: JoinOptions) {
    if (this.state.phase !== "LOBBY") throw new Error("match already started");
    const p = new Player();
    p.pid = client.sessionId;
    p.name = sanitizeName(options?.name);
    p.seat = this.seatCounter++;
    p.isHost = this.state.players.size === 0;
    this.state.players.set(client.sessionId, p);
  }

  async onLeave(client: Client, consented: boolean) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    if (consented || this.state.phase === "LOBBY" || this.state.phase === "MATCH_END") {
      this.removePlayer(client.sessionId);
      return;
    }
    // hold the seat — mid-match disconnect grace
    p.connected = false;
    try {
      await this.allowReconnection(client, this.rules.reconnectGraceSeconds);
      p.connected = true;
      // resync their private answers so the client can restore inputs
      client.send("restore", { answers: this.answers[client.sessionId] ?? {} });
    } catch {
      this.removePlayer(client.sessionId); // grace expired; score stays on the board via log
    }
  }

  private removePlayer(pid: string) {
    const p = this.state.players.get(pid);
    this.state.players.delete(pid);
    delete this.buckets[pid];
    if (p?.isHost) {
      const next = [...this.state.players.values()].sort((a, b) => a.seat - b.seat)[0];
      if (next) next.isHost = true;
    }
    // never let a departure stall the room
    if (this.state.phase === "WRITING") this.maybeAutoStopCheck();
    if (this.state.phase === "SCORED") this.maybeAdvanceRound();
    if (this.state.phase === "MATCH_END") this.maybeRematch();
  }

  // ---------------- LOBBY ----------------

  /** `ready` is reused across three gates: lobby start, next-round confirm, and rematch confirm. */
  private handleReady(client: Client, ready: boolean) {
    const phase = this.state.phase;
    if (phase !== "LOBBY" && phase !== "SCORED" && phase !== "MATCH_END") return;
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.ready = ready;
    if (phase === "SCORED") this.maybeAdvanceRound();
    if (phase === "MATCH_END") this.maybeRematch();
  }

  private handleStart(client: Client) {
    const p = this.state.players.get(client.sessionId);
    if (!p?.isHost || this.state.phase !== "LOBBY") return;
    if (this.state.players.size < this.rules.minPlayers) {
      client.send(S2C.TOAST, { key: "needMorePlayers", params: { min: this.rules.minPlayers } });
      return;
    }
    this.startCountdown();
  }

  private startCountdown() {
    this.toPhase("COUNTDOWN", this.rules.countdownSeconds * 1000, () => this.startSpin());
  }

  // ---------------- SPIN (server-authoritative letter) ----------------

  private startSpin() {
    this.answers = {};
    this.verdicts = {};
    this.votes = {};
    this.challengesUsed = {};
    this.state.stoppedBy = "";
    this.state.players.forEach((p) => { p.filledCount = 0; p.roundScore = 0; p.ready = false; });

    this.draw = this.bag.draw();
    // Provably fair: commit BEFORE revealing the letter
    this.state.commitHash = this.rules.provablyFair ? this.draw.commitHash : "";
    this.state.revealedNonce = "";
    this.state.letter = ""; // letter is not in state until reveal below

    this.toPhase("SPINNING", this.rules.spinDurationMs + 400, () => this.startWriting());

    // clients animate deterministically from the seed; the OUTCOME is already fixed here
    this.broadcast(S2C.SPIN, {
      letter: this.draw.letter,
      poolIndex: this.draw.poolIndex,
      pool: this.rules.letterPool,
      spinSeed: this.draw.spinSeed,
      rotations: this.draw.rotations,
      commitHash: this.state.commitHash,
      durationMs: this.rules.spinDurationMs,
    });
  }

  private startWriting() {
    if (!this.draw) return;
    this.state.letter = this.draw.letter;
    if (this.rules.provablyFair) this.state.revealedNonce = this.draw.nonce; // verify: sha256(letter+nonce)===commitHash
    this.toPhase("WRITING", this.rules.maxRoundSeconds * 1000, () => this.enterGrace("")); // timeout path
  }

  // ---------------- WRITING ----------------

  private handleAnswer(client: Client, m: any) {
    if (this.state.phase !== "WRITING" && this.state.phase !== "STOP_GRACE") return;
    const cat = String(m?.category ?? "");
    if (!this.rules.categories.some((c) => c.key === cat)) return;
    let text = String(m?.text ?? "").slice(0, this.rules.maxAnswerLength);
    text = text.replace(/[\u0000-\u001f<>]/g, "");
    const pid = client.sessionId;
    this.answers[pid] ??= {};
    this.answers[pid][cat] = { raw: text, verdict: "pending" };

    const p = this.state.players.get(pid);
    if (p) {
      p.filledCount = Object.values(this.answers[pid]).filter((a) => a.raw.trim()).length;
    }
  }

  private stopEligible(pid: string): boolean {
    if (!this.rules.stopRequiresAllFilled) return true;
    const mine = this.answers[pid] ?? {};
    return this.rules.categories.every((c) => (mine[c.key]?.raw ?? "").trim().length > 0);
  }

  private handleStop(client: Client) {
    if (this.state.phase !== "WRITING") return;
    const pid = client.sessionId;
    if (!this.state.players.has(pid)) return;
    if (!this.stopEligible(pid)) {
      client.send(S2C.TOAST, { key: "fillAllFirst" });
      return;
    }
    this.enterGrace(pid);
  }

  private maybeAutoStopCheck() {
    // if everyone remaining has left mid-write, end the round
    if ([...this.state.players.values()].filter((p) => p.connected).length === 0) {
      this.enterGrace("");
    }
  }

  private enterGrace(stoppedBy: string) {
    this.state.stoppedBy = stoppedBy;
    this.toPhase("STOP_GRACE", this.rules.stopGraceSeconds * 1000, () => void this.lockAndReveal());
  }

  // ---------------- LOCK → VALIDATE → REVEAL ----------------

  private async lockAndReveal() {
    this.toPhase("LOCKED", 0);

    const lang = this.rules.language;
    const letter = this.state.letter;

    // Layer 0+1 for everything; collect uncertain for the batched AI call
    const pendingAI: PendingAnswer[] = [];
    for (const pid of this.state.players.keys()) {
      this.answers[pid] ??= {};
      this.verdicts[pid] = {};
      for (const c of this.rules.categories) {
        const raw = this.answers[pid][c.key]?.raw ?? "";
        this.answers[pid][c.key] = { raw, verdict: "pending" };
        const v = validateDeterministic(
          { pid, category: c.key, constraint: c.constraint, raw },
          letter, lang, this.rules
        );
        this.verdicts[pid][c.key] = v;
        if (v === "uncertain" ) pendingAI.push({ pid, category: c.key, constraint: c.constraint, raw });
      }
    }

    // Layer 2 — budget-capped; reveal proceeds either way
    const aiVerdicts = await validateWithAI(pendingAI, letter, lang, this.rules);
    aiVerdicts.forEach((v, i) => {
      const p = pendingAI[i];
      if (p) this.verdicts[p.pid][p.category] = v;
    });

    for (const pid of Object.keys(this.answers))
      for (const c of this.rules.categories)
        this.answers[pid][c.key].verdict = this.verdicts[pid]?.[c.key] ?? "uncertain";

    this.finalizeScores();

    this.roundsLog.push({
      letter,
      nonce: this.draw?.nonce ?? "",
      commitHash: this.draw?.commitHash ?? "",
      stoppedBy: this.state.stoppedBy,
    });

    const revealMs = 4000 + this.rules.categories.length * 3500 +
      (this.rules.enablePeerChallenge ? 6000 : 0);
    this.toPhase("REVEAL", revealMs, () => this.endRound());
  }

  private finalizeScores() {
    this.lastScored = scoreRound(this.answers, this.rules, this.rules.language, this.state.stoppedBy || undefined);
    for (const [pid, total] of Object.entries(this.lastScored.totals)) {
      const p = this.state.players.get(pid);
      if (p) p.roundScore = total;
    }
    this.broadcast(S2C.REVEAL, {
      scored: this.lastScored.scored,
      totals: this.lastScored.totals,
      stoppedBy: this.state.stoppedBy,
      letter: this.state.letter,
      nonce: this.state.revealedNonce,
      commitHash: this.state.commitHash,
    });
  }

  // ---------------- CHALLENGES (during REVEAL) ----------------

  private handleChallenge(client: Client, m: any) {
    if (!this.rules.enablePeerChallenge || this.state.phase !== "REVEAL") return;
    if (this.state.challenge.open) return;
    const byPid = client.sessionId;
    const targetPid = String(m?.targetPid ?? "");
    const category = String(m?.category ?? "");
    if (byPid === targetPid) return;
    if (!this.state.players.has(targetPid)) return;
    if (!this.rules.categories.some((c) => c.key === category)) return;
    const used = this.challengesUsed[byPid] ?? 0;
    if (used >= this.rules.maxChallengesPerPlayerPerRound) return;
    const target = this.lastScored?.scored[targetPid]?.[category];
    if (!target || target.verdict === "empty" || target.verdict === "invalid") return;

    this.challengesUsed[byPid] = used + 1;
    this.votes = {};
    const ch = this.state.challenge;
    ch.open = true; ch.targetPid = targetPid; ch.category = category; ch.byPid = byPid;
    ch.votesValid = 0; ch.votesInvalid = 0;
    ch.deadlineTs = Date.now() + this.rules.challengeVoteSeconds * 1000;

    // pause the reveal timer by extending it past the vote window
    this.toPhase("REVEAL", this.rules.challengeVoteSeconds * 1000 + 4000, () => this.endRound());
    this.clock.setTimeout(() => this.resolveChallenge(), this.rules.challengeVoteSeconds * 1000);
  }

  private handleVote(client: Client, valid: boolean) {
    const ch = this.state.challenge;
    if (!ch.open) return;
    if (client.sessionId === ch.targetPid) {
      // classic rule: the accused's vote only counts as a tiebreak — record separately
      this.votes["__accused__" + client.sessionId] = valid;
      return;
    }
    if (this.votes[client.sessionId] !== undefined) return;
    this.votes[client.sessionId] = valid;
    ch.votesValid = Object.entries(this.votes).filter(([k, v]) => !k.startsWith("__") && v).length;
    ch.votesInvalid = Object.entries(this.votes).filter(([k, v]) => !k.startsWith("__") && !v).length;
    const eligible = [...this.state.players.values()].filter((p) => p.connected && p.pid !== ch.targetPid).length;
    if (ch.votesValid + ch.votesInvalid >= eligible) this.resolveChallenge();
  }

  private resolveChallenge() {
    const ch = this.state.challenge;
    if (!ch.open) return;
    ch.open = false;
    let invalid = ch.votesInvalid > ch.votesValid;
    if (ch.votesInvalid === ch.votesValid) {
      // tie → accused's own vote is DISCARDED; status quo (valid) stands
      invalid = false;
    }
    if (invalid) {
      this.answers = applyChallengeFlip(this.answers, ch.targetPid, ch.category, "invalid");
      this.finalizeScores(); // re-broadcast full corrected breakdown
    }
    this.broadcast(S2C.CHALLENGE_RESULT, {
      targetPid: ch.targetPid, category: ch.category,
      upheld: invalid, votes: { valid: ch.votesValid, invalid: ch.votesInvalid },
    });
  }

  // ---------------- ROUND / MATCH END ----------------

  private endRound() {
    this.state.challenge.open = false;
    for (const p of this.state.players.values()) p.totalScore += p.roundScore;

    this.state.roundIndex++;
    if (this.state.roundIndex >= this.rules.roundsPerMatch) {
      this.matchEnd();
    } else {
      // no auto-advance: everyone connected must confirm before the next letter spins
      this.state.players.forEach((p) => (p.ready = false));
      this.toPhase("SCORED", 0);
    }
  }

  /** Everyone still connected has confirmed → spin the next round. A departure re-checks this. */
  private maybeAdvanceRound() {
    if (this.state.phase !== "SCORED") return;
    const connected = [...this.state.players.values()].filter((p) => p.connected);
    if (connected.length > 0 && connected.every((p) => p.ready)) this.startSpin();
  }

  private matchEnd() {
    this.state.players.forEach((p) => (p.ready = false));
    this.toPhase("MATCH_END", 0);
    const standings = [...this.state.players.values()]
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((p, i) => ({ pid: p.pid, name: p.name, score: p.totalScore, placement: i + 1 }));
    this.broadcast(S2C.MATCH_END, { standings });
    void persistMatch({
      roomCode: this.state.roomCode,
      language: this.rules.language,
      ruleset: this.rules,
      rounds: this.roundsLog,
      standings,
    });
  }

  /** Everyone still connected opted into a rematch → back to the lobby. No one restarts it alone. */
  private maybeRematch() {
    if (this.state.phase !== "MATCH_END") return;
    const connected = [...this.state.players.values()].filter((p) => p.connected);
    if (connected.length > 0 && connected.every((p) => p.ready)) this.doRematch();
  }

  private doRematch() {
    this.state.roundIndex = 0;
    this.roundsLog = [];
    this.state.players.forEach((q) => { q.totalScore = 0; q.roundScore = 0; q.ready = false; q.filledCount = 0; });
    this.toPhase("LOBBY", 0);
  }

  private handleEmote(client: Client, m: any) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    const code = String(m?.code ?? "").slice(0, 8);
    if (!["🔥", "😮", "😂", "GG", "👏", "🫣"].includes(code)) return;
    p.emote = code + "|" + Date.now(); // timestamp so repeats re-trigger client-side
  }

  // ---------------- phase helper: server owns the clock ----------------

  private toPhase(phase: string, durationMs: number, next?: () => void) {
    this.phaseTimer?.clear();
    this.state.phase = phase;
    this.state.serverTime = Date.now();
    this.state.deadlineTs = durationMs > 0 ? Date.now() + durationMs : 0;
    if (next && durationMs > 0) this.phaseTimer = this.clock.setTimeout(next, durationMs);
  }

  onDispose() {
    unregisterCode(this.state.roomCode);
  }
}
