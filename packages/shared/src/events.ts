/** Wire protocol: client → server intents and server → client broadcasts. */

export const C2S = {
  READY: "ready",            // { ready: boolean }
  START: "start",            // host only
  ANSWER: "answer",          // { category: string, text: string }
  STOP: "stop",              // {}
  CHALLENGE: "challenge",    // { targetPid: string, category: string } — queue a table vote
  VOTE: "vote",              // { valid: boolean }
  EMOTE: "emote",            // { code: string }
} as const;

export const S2C = {
  SPIN: "spin",              // { letter, spinSeed, rotations, commitHash?, nonce?, poolIndex }
  REVEAL: "reveal",          // { scored, totals, stoppedBy, aiChecked }
  REVIEW_RESULT: "reviewResult", // { targetPid, category, answer, valid, votes, source }
  MATCH_END: "matchEnd",     // { standings: [{pid, name, score, placement}] }
  TOAST: "toast",            // { key, params? }
  KICKED: "kicked",
} as const;

export type Phase =
  | "LOBBY" | "COUNTDOWN" | "SPINNING" | "WRITING"
  | "STOP_GRACE" | "LOCKED" | "REVEAL" | "SCORED" | "MATCH_END";

/** Why an answer is in front of the table for a vote. */
export type ReviewSource = "ai" | "peer";
