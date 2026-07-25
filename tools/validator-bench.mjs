/**
 * Accuracy bench for the answer referee.
 *
 * Runs a labelled set through the real pipeline (structural → wordlist → AI) and
 * reports every disagreement, so "the AI accepts junk" is a measurement instead of
 * a hunch. Run it after touching the prompt, the wordlists or normalize.ts.
 *
 *   node tools/validator-bench.mjs                       # default model
 *   AI_VALIDATOR_MODEL=claude-sonnet-5 node tools/validator-bench.mjs
 *
 * Expectation labels:
 *   valid   — must end up valid
 *   invalid — must end up invalid
 *   either  — genuinely arguable; valid OR uncertain pass, invalid fails
 */
import dotenv from "dotenv";
dotenv.config({ path: "server/.env", quiet: true });

const { validateDeterministic, validateWithAI, isAIAvailable } =
  await import("../server/dist/validation/engine.js");
const { DEFAULT_RULESET, DEFAULT_CATEGORIES, resolvePool } =
  await import("../packages/shared/dist/index.js");

/** [letter, category, answer, expectation] */
const CASES = {
  en: [
    // --- everyday valid answers -------------------------------------------
    ["S", "name", "Sara", "valid"],
    ["S", "place", "Sweden", "valid"],
    ["S", "animal", "Salmon", "valid"],
    ["S", "food", "Strawberry", "valid"],
    ["S", "object", "Scissors", "valid"],
    ["S", "celebrity", "Shakira", "valid"],
    ["M", "name", "Maria", "valid"],
    ["M", "place", "Morocco", "valid"],
    ["M", "animal", "Mongoose", "valid"],
    ["M", "food", "Mango", "valid"],
    ["M", "object", "Mirror", "valid"],
    ["M", "celebrity", "Messi", "valid"],
    ["B", "animal", "Buffalo", "valid"],
    ["B", "object", "Bicycle", "valid"],
    ["T", "food", "Tomato", "valid"],
    ["T", "place", "Tokyo", "valid"],
    ["K", "celebrity", "Kobe Bryant", "valid"],
    ["A", "celebrity", "Amr Diab", "valid"],       // regional fame counts
    ["O", "celebrity", "Oum Kalthoum", "valid"],
    ["N", "place", "Nairobi", "valid"],
    ["D", "animal", "Dromedary", "valid"],
    ["C", "food", "Couscous", "valid"],

    // --- plausible-looking inventions --------------------------------------
    ["S", "name", "Sklorn", "invalid"],
    ["S", "place", "Snarvia", "invalid"],
    ["S", "animal", "Sprocket", "invalid"],
    ["S", "celebrity", "Sam Blorgenson", "invalid"],
    ["M", "food", "Morbidge", "invalid"],
    ["B", "animal", "Brackle", "invalid"],
    ["T", "place", "Trenvia", "invalid"],
    ["P", "object", "Plimber", "invalid"],
    ["G", "name", "Grondak", "invalid"],
    ["F", "animal", "Flimwhistle", "invalid"],

    // --- real word, wrong category ------------------------------------------
    ["S", "object", "Sandwich", "invalid"],        // food, not object
    ["S", "animal", "Sunflower", "invalid"],       // plant
    ["T", "animal", "Table", "invalid"],
    ["C", "object", "Cucumber", "invalid"],        // food
    ["P", "food", "Pliers", "invalid"],
    ["L", "animal", "Lamp", "invalid"],
    ["D", "food", "Drill", "invalid"],
    ["H", "name", "Hammer", "invalid"],            // common noun as a name
    ["R", "celebrity", "Rabbit", "invalid"],
    ["B", "celebrity", "Batman", "invalid"],       // fictional

    // --- wrong first letter ---------------------------------------------------
    ["S", "animal", "Tiger", "invalid"],
    ["M", "place", "Paris", "invalid"],

    // --- keyboard mash ---------------------------------------------------------
    ["A", "name", "asdfgh", "invalid"],
    ["S", "food", "sssss", "invalid"],
    ["Q", "object", "qwerty", "invalid"],

    // --- genuinely arguable — must not be hard-rejected -------------------------
    ["S", "celebrity", "Sadio Mane", "either"],
    ["T", "food", "Tabbouleh", "either"],
    ["S", "place", "Sfax", "either"],
    ["Z", "animal", "Zorilla", "either"],
  ],
  fr: [
    ["C", "name", "Camille", "valid"],
    ["C", "place", "Casablanca", "valid"],
    ["C", "animal", "Chameau", "valid"],
    ["C", "food", "Cerise", "valid"],
    ["C", "object", "Ciseaux", "valid"],
    ["C", "celebrity", "Coluche", "valid"],
    ["P", "food", "Pomme", "valid"],
    ["P", "object", "Parapluie", "valid"],
    ["C", "animal", "Croquette", "invalid"],
    ["P", "place", "Pluvionie", "invalid"],
    ["C", "object", "Chocolat", "invalid"],
    ["M", "animal", "Marteau", "invalid"],
  ],
  ar: [
    ["م", "name", "محمد", "valid"],
    ["م", "place", "مصر", "valid"],
    ["م", "animal", "ماعز", "valid"],
    ["م", "food", "موز", "valid"],
    ["م", "object", "مفتاح", "valid"],
    ["م", "celebrity", "ماجدة الرومي", "valid"],
    ["ق", "animal", "قرد", "valid"],
    ["ق", "object", "قلم", "valid"],
    ["م", "animal", "مكتب", "invalid"],
    ["ق", "food", "قلم", "invalid"],
    ["م", "place", "مرفانيا", "invalid"],
  ],
};

const pass = (expected, verdict) =>
  expected === "either" ? verdict !== "invalid" : verdict === expected;

let total = 0, ok = 0;
const misses = [];

for (const [lang, cases] of Object.entries(CASES)) {
  const rules = {
    ...DEFAULT_RULESET,
    language: lang,
    categories: DEFAULT_CATEGORIES,
    letterPool: resolvePool(lang, "hard"),
  };

  // Group by letter — the referee is called once per letter, as in a real round.
  const byLetter = new Map();
  for (const c of cases) {
    if (!byLetter.has(c[0])) byLetter.set(c[0], []);
    byLetter.get(c[0]).push(c);
  }

  for (const [letter, group] of byLetter) {
    const judged = new Map();
    const pending = [];
    const pendingIdx = [];

    group.forEach((c, idx) => {
      const j = validateDeterministic({ pid: "p", category: c[1], raw: c[2] }, letter, lang, rules);
      if (j.verdict === "uncertain") {
        pendingIdx.push(idx);
        pending.push({ pid: "p", category: c[1], raw: c[2] });
      } else {
        judged.set(idx, j);
      }
    });

    if (pending.length && isAIAvailable()) {
      const t0 = Date.now();
      const ai = await validateWithAI(pending, letter, lang, rules);
      process.stdout.write(`  ${lang}/${letter}: ${pending.length} to the referee, ${Date.now() - t0}ms\n`);
      ai.forEach((j, i) => judged.set(pendingIdx[i], j));
    }

    group.forEach((c, idx) => {
      const j = judged.get(idx) ?? { verdict: "uncertain" };
      total++;
      if (pass(c[3], j.verdict)) ok++;
      else misses.push({ lang, letter, cat: c[1], answer: c[2], expected: c[3], got: j.verdict, why: j.reason ?? "" });
    });
  }
}

console.log(`\nmodel: ${process.env.AI_VALIDATOR_MODEL || "claude-haiku-4-5-20251001"}  (AI ${isAIAvailable() ? "on" : "OFF"})`);
console.log(`score: ${ok}/${total}  (${((ok / total) * 100).toFixed(1)}%)`);
if (misses.length) {
  console.log("\nmisses:");
  for (const m of misses) {
    console.log(`  ${m.lang}/${m.letter} ${m.cat.padEnd(10)} ${String(m.answer).padEnd(18)} expected ${m.expected.padEnd(8)} got ${String(m.got).padEnd(10)} ${m.why}`);
  }
}
process.exit(misses.length ? 1 : 0);
