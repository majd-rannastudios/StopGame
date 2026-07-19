/** Wire protocol: client → server intents and server → client broadcasts. */

export const C2S = {
  READY: "ready",            // { ready: boolean }
  START: "start",            // host only
  ANSWER: "answer",          // { category: string, text: string }
  STOP: "stop",              // {}
  CHALLENGE: "challenge",    // { targetPid: string, category: string }
  VOTE: "vote",              // { valid: boolean }
  EMOTE: "emote",            // { code: string }
  REMATCH: "rematch",        // {}
} as const;

export const S2C = {
  SPIN: "spin",              // { letter, spinSeed, rotations, commitHash?, nonce?, poolIndex }
  REVEAL: "reveal",          // { scored, totals, stoppedBy }
  CHALLENGE_OPEN: "challengeOpen",   // { targetPid, category, byPid, deadlineTs }
  CHALLENGE_RESULT: "challengeResult", // { targetPid, category, upheld, votes }
  MATCH_END: "matchEnd",     // { standings: [{pid, name, score, placement}] }
  TOAST: "toast",            // { key, params? }
  KICKED: "kicked",
} as const;

export type Phase =
  | "LOBBY" | "COUNTDOWN" | "SPINNING" | "WRITING"
  | "STOP_GRACE" | "LOCKED" | "REVEAL" | "SCORED" | "MATCH_END";
