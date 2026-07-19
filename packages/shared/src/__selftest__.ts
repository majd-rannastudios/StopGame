import { scoreRound } from "./scoring";
import { normalizeAnswer, startsWithLetter } from "./normalize";
import { DEFAULT_RULESET } from "./ruleset";
import { DEFAULT_CATEGORIES } from "./categories";

const rules = { ...DEFAULT_RULESET, categories: DEFAULT_CATEGORIES.slice(0, 2) };
const assert = (c: boolean, m: string) => { if (!c) throw new Error("FAIL: " + m) };

// duplicates fold plurals + diacritics
assert(normalizeAnswer("Cats", "en") === normalizeAnswer("cat", "en"), "en plural fold");
assert(normalizeAnswer("Éléphant", "fr") === normalizeAnswer("elephant", "fr"), "fr diacritics");
assert(normalizeAnswer("بطة", "ar") === normalizeAnswer("بطه", "ar"), "ar ta-marbuta fold");
assert(startsWithLetter("Émile Zola", "E", "fr"), "fr accent-insensitive first letter");
assert(startsWithLetter("أحمد", "ا", "ar"), "ar alef variants first letter");

const { scored, totals } = scoreRound(
  {
    p1: { name: { raw: "Nora", verdict: "valid" }, place: { raw: "Norway", verdict: "valid" } },
    p2: { name: { raw: "Nora", verdict: "valid" }, place: { raw: "Niger", verdict: "valid" } },
    p3: { name: { raw: "", verdict: "empty" }, place: { raw: "Norway", verdict: "valid" } },
  },
  rules, "en", "p1"
);
assert(totals.p1 === rules.pointsDuplicate * 2, "p1 dup+dup");
assert(totals.p2 === rules.pointsDuplicate + rules.pointsUnique, "p2 dup+unique");
assert(totals.p3 === rules.pointsDuplicate, "p3 empty+dup");
assert(scored.p2.place.unique === true, "unique flag");
console.log("shared selftest: ALL PASS");
