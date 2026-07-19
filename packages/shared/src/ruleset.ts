/** The single source of every gameplay tunable. Never hard-code these elsewhere. */
export type Lang = "en" | "fr" | "ar";
export type LetterDrawMode = "bag" | "uniform" | "noImmediateRepeat";
export type Verdict = "valid" | "invalid" | "uncertain" | "empty" | "pending";

export interface CategoryDef {
  key: string;
  label: Record<Lang, string>;
  /** optional tightening, e.g. "cities in Saudi Arabia" — fed to validators */
  constraint?: string;
}

export interface Ruleset {
  minPlayers: number;
  maxPlayers: number;
  roundsPerMatch: number;
  language: Lang;
  categories: CategoryDef[];
  letterPool: string[];
  letterDrawMode: LetterDrawMode;
  provablyFair: boolean;

  maxRoundSeconds: number;
  stopGraceSeconds: number;
  countdownSeconds: number;
  stopRequiresAllFilled: boolean;
  penalizeFalseStop: boolean;
  allowMultiWord: boolean;

  pointsUnique: number;
  pointsDuplicate: number;
  pointsInvalid: number;
  stopBonus: number;

  enablePeerChallenge: boolean;
  challengeVoteSeconds: number;
  maxChallengesPerPlayerPerRound: number;
  /** answers the validator can't confirm are accepted (peer challenge is the backstop) */
  acceptUncertain: boolean;

  reconnectGraceSeconds: number;
  interRoundSeconds: number;
  spinDurationMs: number;
  validationBudgetMs: number;
  maxAnswerLength: number;
}

export const DEFAULT_RULESET: Ruleset = {
  minPlayers: 2,
  maxPlayers: 8,
  roundsPerMatch: 5,
  language: "en",
  categories: [], // filled from categories.ts at room creation
  letterPool: [], // resolved from letters.ts at room creation
  letterDrawMode: "bag",
  provablyFair: true,

  maxRoundSeconds: 120,
  stopGraceSeconds: 4,
  countdownSeconds: 3,
  stopRequiresAllFilled: true,
  penalizeFalseStop: true,
  allowMultiWord: true,

  pointsUnique: 10,
  pointsDuplicate: 5,
  pointsInvalid: 0,
  stopBonus: 0,

  enablePeerChallenge: true,
  challengeVoteSeconds: 12,
  maxChallengesPerPlayerPerRound: 2,
  acceptUncertain: true,

  reconnectGraceSeconds: 45,
  interRoundSeconds: 6,
  spinDurationMs: 3800,
  validationBudgetMs: 4500,
  maxAnswerLength: 40,
};
