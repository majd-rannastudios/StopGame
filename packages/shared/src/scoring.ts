import { Lang, Ruleset, Verdict } from "./ruleset";
import { normalizeAnswer } from "./normalize";

export interface AnswerIn {
  raw: string;
  /** verdict from the validation pipeline BEFORE duplicate grouping */
  verdict: Verdict;
  /** short human-readable justification, shown on the reveal card */
  reason?: string;
  /** true once the table has voted on this answer */
  reviewed?: boolean;
}

export interface AnswerScored {
  raw: string;
  normalized: string;
  verdict: Verdict;      // final verdict (empty/invalid/valid/uncertain)
  unique: boolean;
  points: number;
  /** playerIds that gave the same normalized answer (excl. self) */
  dupWith: string[];
  reason?: string;
  reviewed?: boolean;
}

export type RoundAnswers = Record<string /*playerId*/, Record<string /*catKey*/, AnswerIn>>;
export type RoundScored = Record<string /*playerId*/, Record<string /*catKey*/, AnswerScored>>;

function isCountable(v: Verdict, rules: Ruleset): boolean {
  return v === "valid" || (v === "uncertain" && rules.acceptUncertain);
}

/**
 * Canonical scoring. Pure & deterministic — unit-tested, shared by server (authoritative)
 * and client (optimistic display).
 *
 * stoppedBy + penalizeFalseStop implements the classic rule: if the STOP caller
 * left blanks / invalid answers, their remaining answers score as duplicates at best
 * (they are denied uniqueness bonuses for ending the round early with holes).
 */
export function scoreRound(
  answers: RoundAnswers,
  rules: Ruleset,
  lang: Lang,
  stoppedBy?: string
): { scored: RoundScored; totals: Record<string, number> } {
  const scored: RoundScored = {};
  const totals: Record<string, number> = {};

  for (const cat of rules.categories) {
    // group by normalized form among countable answers
    const groups = new Map<string, string[]>();
    for (const [pid, byCat] of Object.entries(answers)) {
      const a = byCat[cat.key];
      if (!a || !a.raw.trim()) continue;
      if (!isCountable(a.verdict, rules)) continue;
      const n = normalizeAnswer(a.raw, lang);
      if (!n) continue;
      const g = groups.get(n) ?? [];
      g.push(pid);
      groups.set(n, g);
    }

    for (const [pid, byCat] of Object.entries(answers)) {
      const a = byCat[cat.key] ?? { raw: "", verdict: "empty" as Verdict };
      const n = a.raw.trim() ? normalizeAnswer(a.raw, lang) : "";
      scored[pid] ??= {};
      totals[pid] ??= 0;

      let verdict: Verdict = a.raw.trim() ? a.verdict : "empty";
      let unique = false;
      let points = rules.pointsInvalid;
      let dupWith: string[] = [];

      if (isCountable(verdict, rules) && n) {
        const g = groups.get(n) ?? [pid];
        unique = g.length === 1;
        dupWith = g.filter((p) => p !== pid);
        points = unique ? rules.pointsUnique : rules.pointsDuplicate;
      }

      scored[pid][cat.key] = {
        raw: a.raw, normalized: n, verdict, unique, points, dupWith,
        reason: a.reason, reviewed: a.reviewed,
      };
      totals[pid] += points;
    }
  }

  // False-STOP penalty (authentic rule, ranked mode)
  if (stoppedBy && rules.penalizeFalseStop && !rules.stopRequiresAllFilled) {
    const mine = scored[stoppedBy];
    if (mine) {
      const hasHole = rules.categories.some((c) => {
        const a = mine[c.key];
        return !a || a.verdict === "empty" || a.verdict === "invalid";
      });
      if (hasHole) {
        for (const c of rules.categories) {
          const a = mine[c.key];
          if (a && a.unique) {
            totals[stoppedBy] -= a.points - rules.pointsDuplicate;
            a.points = rules.pointsDuplicate;
            a.unique = false;
          }
        }
      }
    }
  }

  // STOP bonus (casual mode flavor)
  if (stoppedBy && rules.stopBonus > 0 && totals[stoppedBy] !== undefined) {
    totals[stoppedBy] += rules.stopBonus;
  }

  return { scored, totals };
}

/** Re-score a single category after the table votes a verdict onto one answer. */
export function applyChallengeFlip(
  answers: RoundAnswers,
  targetPid: string,
  catKey: string,
  newVerdict: Verdict,
  reason?: string
): RoundAnswers {
  const next: RoundAnswers = JSON.parse(JSON.stringify(answers));
  const cell = next[targetPid]?.[catKey];
  if (cell) {
    cell.verdict = newVerdict;
    cell.reviewed = true;
    if (reason) cell.reason = reason;
  }
  return next;
}
