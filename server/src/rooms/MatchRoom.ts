import { Room, Client, Delayed } from "@colyseus/core";
import {
  Ruleset, DEFAULT_RULESET, DEFAULT_CATEGORIES, resolvePool,
  Lang, Verdict, C2S, S2C, ReviewSource,
  scoreRound, RoundAnswers, applyChallengeFlip,
} from "@stop/shared";
import { MatchState, Player } from "../state/MatchState";
import { LetterBag, DrawResult, makeRoomCode } from "../rng";
import { validateDeterministic, validateWithAI, isAIAvailable, PendingAnswer } from "../validation/engine";
import { registerCode, unregisterCode } from "../codeRegistry";
import { persistMatch } from "../persist";

interface JoinOptions { name?: string; }
interface CreateOptions {
  lang?: Lang;
  difficulty?: "easy" | "hard";
  rounds?: number;
  roundSeconds?: number;
  ranked?: boolean;
  private?: boolean;
}

interface ReviewItem {
  targetPid: string;
  category: string;
  source: ReviewSource;
  reason: string;
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
  private lastScored: ReturnType<typeof scoreRound> | null = null;
  private challengesUsed: Record<string, number> = {};
  private buckets: Record<string, Bucket> = {};
  private phaseTimer?: Delayed;

  /** answers still waiting for the table's verdict, plus what has already been settled */
  private reviewQueue: ReviewItem[] = [];
  private reviewVotes: Record<string, boolean> = {};
  private reviewTimer?: Delayed;
  private reviewed = new Set<string>();

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
      maxRoundSeconds: Math.min(180, Math.max(30, options.roundSeconds ?? DEFAULT_RULESET.maxRoundSeconds)),
      // ranked = authentic mode: you may STOP with blanks, but false stops are punished
      stopRequiresAllFilled: ranked ? false : DEFAULT_RULESET.stopRequiresAllFilled,
      penalizeFalseStop: true,
    };

    this.setState(new MatchState());
    this.state.language = lang;
    this.state.totalRounds = this.rules.roundsPerMatch;
    this.state.roundSeconds = this.rules.maxRoundSeconds;
    this.state.aiReferee = isAIAvailable();
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
    this.checkRoomStillPlayable();
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
    this.checkRoomStillPlayable();
  }

  /** Never let a departure stall the room, whatever phase it happens in. */
  private checkRoomStillPlayable() {
    const live = [...this.state.players.values()].filter((p) => p.connected);
    if (this.state.phase === "WRITING" && live.length === 0) this.enterGrace("");
    if (this.state.review.open && !this.state.players.has(this.state.review.targetPid)) {
      this.resolveReview(); // the accused left mid-vote
    } else if (this.state.review.open) {
      this.tallyAndMaybeResolve();
    }
    this.maybeAdvanceRound();
    this.maybeRematch();
  }

  // ---------------- LOBBY ----------------

  /** `ready` is reused across three gates: lobby start, next-round confirm, and rematch confirm. */
  private handleReady(client: Client, ready: boolean) {
    const phase = this.state.phase;
    if (phase !== "LOBBY" && phase !== "REVEAL" && phase !== "SCORED" && phase !== "MATCH_END") return;
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.ready = ready;
    if (phase === "REVEAL" || phase === "SCORED") this.maybeAdvanceRound();
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
    // no late joins once the first letter is on its way — they'd have no score and no answers
    this.lock();
    this.toPhase("COUNTDOWN", this.rules.countdownSeconds * 1000, () => this.startSpin());
  }

  // ---------------- SPIN (server-authoritative letter) ----------------

  private startSpin() {
    this.answers = {};
    this.challengesUsed = {};
    this.reviewQueue = [];
    this.reviewVotes = {};
    this.reviewed.clear();
    this.closeReview();
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

  private enterGrace(stoppedBy: string) {
    if (this.state.phase !== "WRITING") return;
    this.state.stoppedBy = stoppedBy;
    this.toPhase("STOP_GRACE", this.rules.stopGraceSeconds * 1000, () => void this.lockAndReveal());
  }

  // ---------------- LOCK → VALIDATE → REVEAL ----------------

  private async lockAndReveal() {
    this.toPhase("LOCKED", 0);

    const lang = this.rules.language;
    const letter = this.state.letter;

    // Layer 0+1 for everything; collect the leftovers for the batched referee call
    const pendingAI: PendingAnswer[] = [];
    for (const pid of this.state.players.keys()) {
      this.answers[pid] ??= {};
      for (const c of this.rules.categories) {
        const raw = this.answers[pid][c.key]?.raw ?? "";
        const j = validateDeterministic(
          { pid, category: c.key, constraint: c.constraint, raw },
          letter, lang, this.rules
        );
        this.answers[pid][c.key] = { raw, verdict: j.verdict, reason: j.reason };
        if (j.verdict === "uncertain") {
          pendingAI.push({ pid, category: c.key, constraint: c.constraint, raw });
        }
      }
    }

    // Layer 2 — budget-capped; the reveal proceeds either way
    const judged = await validateWithAI(pendingAI, letter, lang, this.rules);
    judged.forEach((j, i) => {
      const p = pendingAI[i];
      if (!p) return;
      const cell = this.answers[p.pid]?.[p.category];
      if (cell) { cell.verdict = j.verdict; cell.reason = j.reason; }
    });

    // Layer 3 — whatever the referee could not settle goes to the table
    this.buildReviewQueue();

    this.finalizeScores();

    this.roundsLog.push({
      letter,
      nonce: this.draw?.nonce ?? "",
      commitHash: this.draw?.commitHash ?? "",
      stoppedBy: this.state.stoppedBy,
    });

    this.toPhase("REVEAL", this.revealMs(), () => this.endRound());
    // let the cards land before the first vote sheet slides up
    if (this.reviewQueue.length) this.clock.setTimeout(() => this.openNextReview(), 1200);
  }

  private revealMs(): number {
    return 2600 + this.rules.categories.length * this.rules.revealStepMs;
  }

  private finalizeScores() {
    this.lastScored = scoreRound(this.answers, this.rules, this.rules.language, this.state.stoppedBy || undefined);
    for (const p of this.state.players.values()) {
      p.roundScore = this.lastScored.totals[p.pid] ?? 0;
    }
    this.broadcast(S2C.REVEAL, {
      scored: this.lastScored.scored,
      totals: this.lastScored.totals,
      stoppedBy: this.state.stoppedBy,
      letter: this.state.letter,
      nonce: this.state.revealedNonce,
      commitHash: this.state.commitHash,
      aiChecked: this.state.aiReferee,
    });
  }

  // ---------------- TABLE REVIEW ----------------

  private reviewKey = (pid: string, cat: string) => `${pid}|${cat}`;

  /** Eligible voters = everyone connected except the answer's author. */
  private votersFor(targetPid: string): number {
    return [...this.state.players.values()].filter((p) => p.connected && p.pid !== targetPid).length;
  }

  private buildReviewQueue() {
    this.reviewQueue = [];
    if (!this.rules.enablePeerReview) return;
    for (const c of this.rules.categories) {
      for (const pid of Object.keys(this.answers)) {
        const cell = this.answers[pid][c.key];
        if (!cell || cell.verdict !== "uncertain" || !cell.raw.trim()) continue;
        if (this.votersFor(pid) === 0) continue; // nobody to ask — acceptUncertain decides
        this.reviewQueue.push({
          targetPid: pid, category: c.key, source: "ai",
          reason: cell.reason || "@aiUnsure",
        });
      }
    }
    if (this.reviewQueue.length > this.rules.maxReviewsPerRound) {
      this.reviewQueue.length = this.rules.maxReviewsPerRound;
    }
  }

  private openNextReview(): void {
    if (this.state.phase !== "REVEAL") return;
    if (this.state.review.open) return;

    const item = this.reviewQueue.shift();
    if (!item) {
      this.closeReview();
      // reveal was paused while the table deliberated — give it a short tail
      this.toPhase("REVEAL", 2200, () => this.endRound());
      return;
    }
    const cell = this.answers[item.targetPid]?.[item.category];
    const target = this.state.players.get(item.targetPid);
    if (!cell || !target || this.votersFor(item.targetPid) === 0) return this.openNextReview();

    this.reviewVotes = {};
    const r = this.state.review;
    r.open = true;
    r.targetPid = item.targetPid;
    r.targetName = target.name;
    r.category = item.category;
    r.answer = cell.raw;
    r.reason = item.reason;
    r.source = item.source;
    r.votesValid = 0;
    r.votesInvalid = 0;
    r.voters = this.votersFor(item.targetPid);
    r.remaining = this.reviewQueue.length;
    r.deadlineTs = Date.now() + this.rules.reviewVoteSeconds * 1000;

    // hold the reveal open for exactly as long as the vote needs
    this.phaseTimer?.clear();
    this.state.deadlineTs = r.deadlineTs;
    this.reviewTimer?.clear();
    this.reviewTimer = this.clock.setTimeout(() => this.resolveReview(), this.rules.reviewVoteSeconds * 1000);
  }

  private handleVote(client: Client, valid: boolean) {
    const r = this.state.review;
    if (!r.open) return;
    if (client.sessionId === r.targetPid) return;       // you don't vote on your own answer
    if (this.reviewVotes[client.sessionId] !== undefined) return;
    this.reviewVotes[client.sessionId] = valid;
    this.tallyAndMaybeResolve();
  }

  private tallyAndMaybeResolve() {
    const r = this.state.review;
    if (!r.open) return;
    const votes = Object.values(this.reviewVotes);
    r.votesValid = votes.filter(Boolean).length;
    r.votesInvalid = votes.length - r.votesValid;
    r.voters = this.votersFor(r.targetPid);
    if (votes.length >= r.voters) this.resolveReview();
  }

  private resolveReview() {
    const r = this.state.review;
    if (!r.open) return;
    this.reviewTimer?.clear();

    const votes = Object.values(this.reviewVotes);
    const yes = votes.filter(Boolean).length;
    const no = votes.length - yes;
    // Silence and ties both favour the player — you have to actively vote a word down.
    const valid = yes >= no;

    const targetPid = r.targetPid;
    const category = r.category;
    const answer = r.answer;
    const source = r.source;

    this.reviewed.add(this.reviewKey(targetPid, category));
    this.answers = applyChallengeFlip(
      this.answers, targetPid, category,
      valid ? "valid" : "invalid",
      valid ? "@tableAccepted" : "@tableRejected"
    );
    this.closeReview();
    this.finalizeScores();

    this.broadcast(S2C.REVIEW_RESULT, {
      targetPid, category, answer, valid, source,
      votes: { valid: yes, invalid: no },
    });

    // a beat to read the outcome, then the next one (or back to the reveal)
    this.clock.setTimeout(() => this.openNextReview(), 1600);
  }

  private closeReview() {
    this.reviewTimer?.clear();
    this.reviewVotes = {};
    const r = this.state.review;
    r.open = false;
    r.targetPid = ""; r.targetName = ""; r.category = ""; r.answer = "";
    r.reason = ""; r.source = "";
    r.votesValid = 0; r.votesInvalid = 0; r.voters = 0;
    r.remaining = this.reviewQueue.length;
  }

  /** A player flags an answer the referee already settled — same queue, same vote. */
  private handleChallenge(client: Client, m: any) {
    if (!this.rules.enablePeerReview || this.state.phase !== "REVEAL") return;
    const byPid = client.sessionId;
    const targetPid = String(m?.targetPid ?? "");
    const category = String(m?.category ?? "");
    if (byPid === targetPid) return;
    if (!this.state.players.has(targetPid)) return;
    if (!this.rules.categories.some((c) => c.key === category)) return;

    const key = this.reviewKey(targetPid, category);
    if (this.reviewed.has(key)) {
      client.send(S2C.TOAST, { key: "alreadyReviewed" });
      return;
    }
    if (this.reviewQueue.some((q) => q.targetPid === targetPid && q.category === category)) return;
    if (this.state.review.open && this.state.review.targetPid === targetPid && this.state.review.category === category) return;

    const used = this.challengesUsed[byPid] ?? 0;
    if (used >= this.rules.maxChallengesPerPlayerPerRound) {
      client.send(S2C.TOAST, { key: "noFlagsLeft" });
      return;
    }
    const cell = this.answers[targetPid]?.[category];
    if (!cell || !cell.raw.trim() || cell.verdict === "empty" || cell.verdict === "invalid") return;

    this.challengesUsed[byPid] = used + 1;
    this.reviewQueue.push({ targetPid, category, source: "peer", reason: "@peerFlag" });
    this.state.review.remaining = this.reviewQueue.length;
    if (!this.state.review.open) this.openNextReview();
  }

  // ---------------- ROUND / MATCH END ----------------

  private endRound() {
    if (this.state.phase !== "REVEAL") return;
    this.reviewQueue = [];
    this.closeReview();

    // Bank exactly once: the delta moves into totalScore and roundScore goes to zero,
    // so no client can ever show total+round twice.
    for (const p of this.state.players.values()) {
      p.lastRoundScore = p.roundScore;
      p.totalScore += p.roundScore;
      p.roundScore = 0;
    }

    this.state.roundIndex++;
    if (this.state.roundIndex >= this.rules.roundsPerMatch) {
      this.matchEnd();
      return;
    }
    // no auto-advance: everyone connected must confirm before the next letter spins
    this.toPhase("SCORED", 0);
    this.maybeAdvanceRound(); // players who confirmed during the reveal already voted with their thumb
  }

  /**
   * Everyone still connected has confirmed → next letter. Works from the reveal too,
   * so a table that agrees early never sits through the rest of the animation.
   */
  private maybeAdvanceRound() {
    const phase = this.state.phase;
    if (phase !== "REVEAL" && phase !== "SCORED") return;
    if (this.state.review.open || this.reviewQueue.length > 0) return;
    const connected = [...this.state.players.values()].filter((p) => p.connected);
    if (connected.length === 0 || !connected.every((p) => p.ready)) return;
    if (phase === "REVEAL") this.endRound();
    else this.startSpin();
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
    this.state.letter = "";
    this.state.players.forEach((q) => {
      q.totalScore = 0; q.roundScore = 0; q.lastRoundScore = 0; q.ready = false; q.filledCount = 0;
    });
    this.unlock(); // the lobby is open to newcomers again
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
