import Anthropic from "@anthropic-ai/sdk";
import {
  Lang, Ruleset, Verdict, CategoryDef,
  normalizeAnswer, startsWithLetter, looksLikeGibberish,
} from "@stop/shared";
import enList from "../wordlists/en.json";
import frList from "../wordlists/fr.json";
import arList from "../wordlists/ar.json";

type Wordlists = Record<string, string[]>;
const LISTS: Record<Lang, Wordlists> = {
  en: enList as Wordlists,
  fr: frList as Wordlists,
  ar: arList as Wordlists,
};

const LANG_NAME: Record<Lang, string> = { en: "English", fr: "French", ar: "Arabic" };

// Pre-normalize wordlists once at boot so lookups match player normalization.
const NORMALIZED: Record<Lang, Record<string, Set<string>>> = { en: {}, fr: {}, ar: {} };
for (const lang of ["en", "fr", "ar"] as Lang[]) {
  for (const [cat, words] of Object.entries(LISTS[lang])) {
    NORMALIZED[lang][cat] = new Set(words.map((w) => normalizeAnswer(w, lang)));
  }
}

/**
 * A verdict plus a short justification. Reasons beginning with "@" are i18n keys the
 * client translates; anything else is free text written by the referee in the room's
 * language. Players are far more willing to accept a rejection they can read.
 */
export interface Judgement {
  verdict: Verdict;
  reason?: string;
}

/** In-memory judgement cache: (lang|cat|normalized) → judgement. Words recur constantly. */
const cache = new Map<string, Judgement>();
const cacheKey = (lang: Lang, cat: string, n: string) => `${lang}|${cat}|${n}`;
const MAX_CACHE = 50_000;
function cacheSet(k: string, j: Judgement) {
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(k, j);
}

export interface PendingAnswer {
  pid: string;
  category: string;
  constraint?: string;
  raw: string;
}

export const isAIAvailable = (): boolean => !!process.env.ANTHROPIC_API_KEY;

/** Layers 0+1: structural + wordlist. Synchronous, deterministic, instant. */
export function validateDeterministic(
  a: PendingAnswer,
  letter: string,
  lang: Lang,
  rules: Ruleset
): Judgement {
  const raw = a.raw.trim();
  if (!raw) return { verdict: "empty" };
  if (raw.length > rules.maxAnswerLength) return { verdict: "invalid", reason: "@tooLong" };
  if (!startsWithLetter(raw, letter, lang)) return { verdict: "invalid", reason: "@wrongLetter" };
  if (looksLikeGibberish(raw, lang)) return { verdict: "invalid", reason: "@notAWord" };
  if (!rules.allowMultiWord && raw.includes(" ")) return { verdict: "invalid", reason: "@oneWordOnly" };

  const n = normalizeAnswer(raw, lang);
  const cached = cache.get(cacheKey(lang, a.category, n));
  if (cached) return cached;

  const list = NORMALIZED[lang][a.category];
  if (list?.has(n)) {
    const j: Judgement = { verdict: "valid" };
    cacheSet(cacheKey(lang, a.category, n), j);
    return j;
  }
  return { verdict: "uncertain" }; // escalate to the AI referee / table vote
}

/* ------------------------------------------------------------------ *
 * Layer 2 — the AI referee
 * ------------------------------------------------------------------ */

const MAX_ITEMS_PER_CALL = 20;

/** Lazily constructed so a server with no key never touches the SDK. */
let anthropic: Anthropic | null = null;
const client = (): Anthropic => (anthropic ??= new Anthropic({ maxRetries: 0 }));

/**
 * Structured output schema — the referee's reply is constrained to this shape, so a
 * malformed answer can't leak through as "the AI didn't decide". Note the schema
 * dialect here forbids numeric/length constraints and requires additionalProperties:false.
 */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer", description: "the item's index, echoed back" },
          ok: { type: "boolean", description: "true only if real, right letter and right category" },
          sure: { type: "boolean", description: "false only when genuinely unverifiable" },
          why: { type: "string", description: "at most six words; empty when ok and sure" },
        },
        required: ["i", "ok", "sure", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

function systemPrompt(lang: Lang, letter: string): string {
  const L = LANG_NAME[lang];
  return [
    `You are the referee of a fast word game (Scattergories / "Stop"). You judge strictly but fairly, and you never invent facts.`,
    ``,
    `An answer is VALID only if ALL THREE hold:`,
    `1. REAL — it is a genuine ${L} word or a real proper name. Invented words are never valid, however plausible they look.`,
    `2. LETTER — its first word begins with "${letter}".`,
    `3. CATEGORY — it truly satisfies that category's rule, which is given to you.`,
    ``,
    `Judging notes:`,
    `- Accept minor misspellings, missing accents, plurals and common transliterations of a real answer.`,
    `- Accept regional, non-Western and historical answers on completely equal footing.`,
    `- Reject an answer that really belongs to a different category on the same card (a food entered as an object, an animal entered as a food).`,
    `- Set "sure" to false ONLY when a well-informed person could genuinely be unable to confirm it: an obscure local celebrity, a small village, a regional dish. The players at the table will then vote on it. Never use "sure": false to dodge a decision on an ordinary word.`,
    `- "why" is at most six words, written in ${L}, and is only needed when you reject or doubt an answer.`,
    ``,
    `Return one result object per item, echoing each item's index in "i".`,
  ].join("\n");
}

function userPrompt(
  items: { i: number; category: string; answer: string }[],
  categories: CategoryDef[],
  lang: Lang,
  letter: string
): string {
  // Every category on the card is listed, not just the ones being judged: the
  // contrast is what stops a food ("Sandwich") from sliding through as an object.
  const rules = categories
    .map((c) => `- ${c.label.en}: ${c.aiRule}${c.constraint ? ` Additional constraint: ${c.constraint}.` : ""}`)
    .join("\n");
  return [
    `Language: ${LANG_NAME[lang]}. Round letter: "${letter}".`,
    ``,
    `The card has these categories, and each answer must fit the one it was entered under —`,
    `an answer that really belongs to a different category on this list is not valid:`,
    rules,
    ``,
    `Judge these ${items.length} item(s):`,
    JSON.stringify(items),
  ].join("\n");
}

/** Trim to a whole word so a reason never reads like it was cut off mid-sentence. */
function shortReason(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  if (!t) return undefined;
  if (t.length <= 48) return t;
  const cut = t.slice(0, 48);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut) + "…";
}

async function askReferee(
  items: { i: number; category: string; answer: string }[],
  categories: CategoryDef[],
  letter: string,
  lang: Lang,
  budgetMs: number
): Promise<Map<number, Judgement>> {
  const out = new Map<number, Judgement>();

  const res = await client().messages.create(
    {
      model: process.env.AI_VALIDATOR_MODEL || "claude-haiku-4-5",
      max_tokens: 2000,
      system: systemPrompt(lang, letter),
      messages: [{ role: "user", content: userPrompt(items, categories, lang, letter) }],
      // Constrain the reply to the verdict schema — no prose to unwrap, nothing to
      // mis-parse, and no silent "unjudged" fallout from a stray markdown fence.
      output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
    } as any,
    { timeout: budgetMs }
  );

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) return out;

  const parsed = JSON.parse(text);
  const rows: any[] = Array.isArray(parsed) ? parsed : parsed?.results ?? [];
  for (const row of rows) {
    if (typeof row?.i !== "number" || !items.some((it) => it.i === row.i)) continue;
    const ok = row.ok === true;
    const sure = row.sure !== false;
    const verdict: Verdict = !sure ? "uncertain" : ok ? "valid" : "invalid";
    out.set(row.i, {
      verdict,
      reason: verdict === "valid" ? undefined : shortReason(row.why),
    });
  }
  return out;
}

/**
 * One batched Anthropic call per 20 uncertain answers, hard-capped by
 * validationBudgetMs. On timeout, error or missing key the answers stay "uncertain"
 * and the table vote takes over — the reveal NEVER blocks on this.
 */
export async function validateWithAI(
  pending: PendingAnswer[],
  letter: string,
  lang: Lang,
  rules: Ruleset
): Promise<Map<number, Judgement>> {
  const out = new Map<number, Judgement>();
  if (!isAIAvailable() || pending.length === 0) return out;

  const byKey = new Map<string, CategoryDef>(rules.categories.map((c) => [c.key, c]));
  const items = pending.map((p, i) => ({
    i,
    category: byKey.get(p.category)?.label.en ?? p.category,
    answer: p.raw,
  }));

  const chunks: (typeof items)[] = [];
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_CALL) {
    chunks.push(items.slice(i, i + MAX_ITEMS_PER_CALL));
  }

  const started = Date.now();
  const timedOut = (err: any) =>
    err instanceof Anthropic.APIConnectionTimeoutError || err?.name === "AbortError";

  const results = await Promise.allSettled(
    chunks.map(async (chunk) => {
      try {
        return await askReferee(chunk, rules.categories, letter, lang, rules.validationBudgetMs);
      } catch (err: any) {
        // One retry with whatever budget is left — transient socket errors are common.
        const left = rules.validationBudgetMs - (Date.now() - started);
        if (!timedOut(err) && left > 1500) {
          return askReferee(chunk, rules.categories, letter, lang, left);
        }
        throw err;
      }
    })
  );

  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      r.value.forEach((j, i) => out.set(i, j));
    } else {
      failed++;
      const err: any = r.reason;
      const why = timedOut(err)
        ? `timed out (budget ${rules.validationBudgetMs}ms)`
        : (err?.message ?? String(err));
      console.error(`[referee] batch failed (${why}) — falling back to the table vote`);
    }
  }
  if (failed === 0 && out.size < pending.length) {
    console.warn(`[referee] ${pending.length - out.size} item(s) unjudged — falling back to the table vote`);
  }

  // Only settled judgements are worth remembering; doubt is per-round, not permanent.
  out.forEach((j, i) => {
    const p = pending[i];
    if (p && j.verdict !== "uncertain") {
      cacheSet(cacheKey(lang, p.category, normalizeAnswer(p.raw, lang)), j);
    }
  });

  return out;
}
