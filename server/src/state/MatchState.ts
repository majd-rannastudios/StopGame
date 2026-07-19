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
  @type("number") roundScore = 0;
  @type("number") totalScore = 0;
  @type("string") emote = "";
}

export class ChallengeState extends Schema {
  @type("boolean") open = false;
  @type("string") targetPid = "";
  @type("string") category = "";
  @type("string") byPid = "";
  @type("number") deadlineTs = 0;
  @type("number") votesValid = 0;
  @type("number") votesInvalid = 0;
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
  @type(["string"]) categoryKeys = new ArraySchema<string>();
  @type({ map: Player }) players = new MapSchema<Player>();
  @type(ChallengeState) challenge = new ChallengeState();
}
