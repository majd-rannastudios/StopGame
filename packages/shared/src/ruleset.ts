/** The single source of every gameplay tunable. Never hard-code these elsewhere. */
export type Lang = "en" | "fr" | "ar";
export type LetterDrawMode = "bag" | "uniform" | "noImmediateRepeat";
export type Verdict = "valid" | "invalid" | "uncertain" | "empty" | "pending";

export interface CategoryDef {
  key: string;
  /** emoji shown next to the field — pure UI sugar */
  icon: string;
  label: Record<Lang, string>;
  /** the membership test handed to the AI referee, verbatim */
  aiRule: string;
  /**
   * May an unsure verdict here go to a table vote?
   *
   * Only true for the two categories where a human genuinely knows something the
   * referee can't: a given name, and a locally-famous person. Whether something is
   * an animal or a city is a matter of fact — the referee decides those alone, and
   * an unsure verdict is accepted rather than put to the room. Players can still
   * flag any answer by hand; this governs the AUTOMATIC queue only.
   */
  humanReviewable?: boolean;
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

  /** unsure NAMES and PEOPLE go to a table vote instead of silently passing */
  enablePeerReview: boolean;
  reviewVoteSeconds: number;
  /** hard cap so one messy round can't turn the reveal into a committee meeting */
  maxReviewsPerRound: number;
  /** flags a player may raise per round on answers the AI *did* settle */
  maxChallengesPerPlayerPerRound: number;
  /**
   * Last-resort default for answers that reach scoring still unresolved — only
   * reachable when peer review is off or there is nobody left to vote.
   */
  acceptUncertain: boolean;

  reconnectGraceSeconds: number;
  spinDurationMs: number;
  /**
   * Wall-clock CEILING for the AI referee, not a wait: the reveal fires the moment
   * the answer comes back (measured ~0.7–2.6s for a full table). This only bites
   * when the API is slow, and blowing it sends that round to the table vote —
   * so it wants roughly 2x the observed worst case, not more.
   */
  validationBudgetMs: number;
  /** per-category stagger while the reveal plays out */
  revealStepMs: number;
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

  enablePeerReview: true,
  reviewVoteSeconds: 12,
  maxReviewsPerRound: 3,
  maxChallengesPerPlayerPerRound: 2,
  acceptUncertain: true,

  reconnectGraceSeconds: 45,
  spinDurationMs: 3800,
  validationBudgetMs: 4000,
  revealStepMs: 1100,
  maxAnswerLength: 40,
};
