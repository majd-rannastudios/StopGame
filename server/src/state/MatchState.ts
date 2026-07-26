import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") pid = "";
  @type("string") name = "";
  @type("number") seat = 0;
  @type("boolean") isHost = false;
  @type("boolean") isAI = false;
  @type("boolean") ready = false;
  @type("boolean") connected = true;
  /** how many categories they've filled — broadcast for pressure; NEVER the words */
  @type("number") filledCount = 0;
  /** this round's points, still unbanked. Zeroed the moment they land in totalScore. */
  @type("number") roundScore = 0;
  /** the delta that was last banked — kept only so the UI can show "+40" after the fact */
  @type("number") lastRoundScore = 0;
  @type("number") totalScore = 0;
  @type("string") emote = "";
}

/**
 * One answer in front of the table for a vote. Raised either by the AI referee
 * ("I can't confirm this person exists") or by a player's flag.
 */
export class ReviewState extends Schema {
  @type("boolean") open = false;
  @type("string") targetPid = "";
  @type("string") targetName = "";
  @type("string") category = "";
  @type("string") answer = "";
  /** i18n key ("@..."), or free text written by the referee in the room language */
  @type("string") reason = "";
  @type("string") source = ""; // "ai" | "peer"
  @type("number") deadlineTs = 0;
  @type("number") votesValid = 0;
  @type("number") votesInvalid = 0;
  @type("number") voters = 0;   // how many players are entitled to vote
  @type("number") remaining = 0; // still queued behind this one
}

export class MatchState extends Schema {
  @type("string") phase = "LOBBY";
  @type("string") roomCode = "";
  @type("string") language = "en";
  @type("number") roundIndex = 0;
  @type("number") totalRounds = 5;
  @type("string") letter = "";
  /** commit hash broadcast BEFORE the spin when provablyFair (letter+nonce revealed after) */
  @type("string") commitHash = "";
  @type("string") revealedNonce = "";
  @type("number") deadlineTs = 0;
  @type("number") serverTime = 0;
  @type("string") stoppedBy = "";
  /** seconds a writing round lasts — the client's timer bar reads this, never a constant */
  @type("number") roundSeconds = 120;
  /** whether the AI referee is configured on this server, so the UI can say so honestly */
  @type("boolean") aiReferee = false;
  /** one player against the clock: no lobby, no opponents, no table votes */
  @type("boolean") solo = false;
  @type(["string"]) categoryKeys = new ArraySchema<string>();
  @type({ map: Player }) players = new MapSchema<Player>();
  @type(ReviewState) review = new ReviewState();
}
