import { Client, Room } from "colyseus.js";
import { C2S } from "@stop/shared";

const WS_URL =
  (import.meta as any).env?.VITE_WS_URL ||
  (location.protocol === "https:" ? "wss://" : "ws://") + location.hostname + ":2567";
const API_URL = (import.meta as any).env?.VITE_API_URL || "";

export interface SpinPayload {
  letter: string; poolIndex: number; pool: string[];
  spinSeed: number; rotations: number; commitHash: string; durationMs: number;
}
export interface ScoredCell {
  raw: string; verdict: string; unique: boolean; points: number;
  dupWith: string[]; reason?: string; reviewed?: boolean;
}
export interface RevealPayload {
  scored: Record<string, Record<string, ScoredCell>>;
  totals: Record<string, number>;
  stoppedBy: string; letter: string; nonce: string; commitHash: string;
  aiChecked: boolean;
}
export interface ReviewResultPayload {
  targetPid: string; category: string; answer: string;
  valid: boolean; source: string; votes: { valid: number; invalid: number };
}
export interface RoomOptions {
  lang: string;
  rounds?: number;
  difficulty?: "easy" | "hard";
  roundSeconds?: number;
}

export class GameClient {
  client = new Client(WS_URL);
  room: Room | null = null;
  /** serverTime - clientNow, refreshed on every state patch */
  clockOffset = 0;

  listeners = new Set<() => void>();
  onSpin: ((p: SpinPayload) => void) | null = null;
  onReveal: ((p: RevealPayload) => void) | null = null;
  onToast: ((key: string, params?: any) => void) | null = null;
  onReviewResult: ((p: ReviewResultPayload) => void) | null = null;
  onMatchEnd: ((p: any) => void) | null = null;
  onRestore: ((answers: Record<string, { raw: string }>) => void) | null = null;

  private notify = () => this.listeners.forEach((l) => l());

  async createRoom(name: string, opts: RoomOptions) {
    this.room = await this.client.create("match", { name, ...opts, private: true });
    this.wire();
  }

  /** One player against the clock — no lobby to sit in, so start straight away. */
  async createSolo(name: string, opts: RoomOptions) {
    this.room = await this.client.create("match", { name, ...opts, solo: true, private: true });
    this.wire();
    this.room.send(C2S.START); // the creator is the host, so this is theirs to send
  }

  async joinByCode(name: string, code: string) {
    const res = await fetch(`${API_URL}/api/resolve/${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error("room_not_found");
    const { roomId } = await res.json();
    this.room = await this.client.joinById(roomId, { name });
    this.wire();
  }

  async quickMatch(name: string, lang: string) {
    const res = await fetch(`${API_URL}/api/quickmatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lang }),
    });
    if (!res.ok) throw new Error("matchmaking_failed");
    const { roomId } = await res.json();
    this.room = await this.client.joinById(roomId, { name });
    this.wire();
  }

  private wire() {
    const r = this.room!;
    r.onStateChange((state: any) => {
      if (state.serverTime) this.clockOffset = state.serverTime - Date.now();
      this.notify();
    });
    r.onMessage("spin", (p: SpinPayload) => this.onSpin?.(p));
    r.onMessage("reveal", (p: RevealPayload) => this.onReveal?.(p));
    r.onMessage("toast", (p: any) => this.onToast?.(p.key, p.params));
    r.onMessage("reviewResult", (p: ReviewResultPayload) => this.onReviewResult?.(p));
    r.onMessage("matchEnd", (p: any) => this.onMatchEnd?.(p));
    r.onMessage("restore", (p: any) => this.onRestore?.(p.answers ?? {}));
    r.onError(() => this.onToast?.("connError"));
  }

  /** server-reconciled remaining ms for a deadline */
  remaining(deadlineTs: number): number {
    if (!deadlineTs) return 0;
    return Math.max(0, deadlineTs - (Date.now() + this.clockOffset));
  }

  ready = (v: boolean) => this.room?.send(C2S.READY, { ready: v });
  start = () => this.room?.send(C2S.START);
  answer = (category: string, text: string) => this.room?.send(C2S.ANSWER, { category, text });
  stop = () => this.room?.send(C2S.STOP);
  challenge = (targetPid: string, category: string) => this.room?.send(C2S.CHALLENGE, { targetPid, category });
  vote = (valid: boolean) => this.room?.send(C2S.VOTE, { valid });
  emote = (code: string) => this.room?.send(C2S.EMOTE, { code });
  leave = () => { this.room?.leave(); this.room = null; this.notify(); };
}

/** Provably-fair check: sha256(letter + nonce) must equal the pre-spin commit. */
export async function verifyCommit(letter: string, nonce: string, commitHash: string): Promise<boolean> {
  if (!letter || !nonce || !commitHash) return false;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(letter + nonce));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === commitHash;
}

export const game = new GameClient();
