import {
  Lang, Ruleset, Verdict,
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

// Pre-normalize wordlists once at boot so lookups match player normalization.
const NORMALIZED: Record<Lang, Record<string, Set<string>>> = { en: {}, fr: {}, ar: {} };
for (const lang of ["en", "fr", "ar"] as Lang[]) {
  for (const [cat, words] of Object.entries(LISTS[lang])) {
    NORMALIZED[lang][cat] = new Set(words.map((w) => normalizeAnswer(w, lang)));
  }
}

/** In-memory verdict cache: (lang|cat|normalized) → verdict. Words recur constantly. */
const cache = new Map<string, Verdict>();
const cacheKey = (lang: Lang, cat: string, n: string) => `${lang}|${cat}|${n}`;
const MAX_CACHE = 50_000;
function cacheSet(k: string, v: Verdict) {
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(k, v);
}

export interface PendingAnswer {
  pid: string;
  category: string;
  constraint?: string;
  raw: string;
}
export type VerdictMap = Record<string /*pid*/, Record<string /*cat*/, Verdict>>;

/** Layers 0+1: structural + wordlist. Synchronous, deterministic, instant. */
export function validateDeterministic(
  a: PendingAnswer,
  letter: string,
  lang: Lang,
  rules: Ruleset
): Verdict {
  const raw = a.raw.trim();
  if (!raw) return "empty";
  if (raw.length > rules.maxAnswerLength) return "invalid";
  if (looksLikeGibberish(raw)) return "invalid";
  if (!startsWithLetter(raw, letter, lang)) return "invalid";
  if (!rules.allowMultiWord && raw.includes(" ")) return "invalid";

  const n = normalizeAnswer(raw, lang);
  const cached = cache.get(cacheKey(lang, a.category, n));
  if (cached) return cached;

  const list = NORMALIZED[lang][a.category];
  if (list?.has(n)) {
    cacheSet(cacheKey(lang, a.category, n), "valid");
    return "valid";
  }
  return "uncertain"; // escalate to AI / peer challenge
}

/**
 * Layer 2: one batched Anthropic call for all uncertain answers in the round.
 * Hard-capped by validationBudgetMs — on timeout or missing key, answers stay
 * "uncertain" and the peer-challenge layer is the backstop. Reveal NEVER blocks.
 */
export async function validateWithAI(
  pending: PendingAnswer[],
  letter: string,
  lang: Lang,
  rules: Ruleset
): Promise<Map<number, Verdict>> {
  const out = new Map<number, Verdict>();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || pending.length === 0) return out;

  const items = pending.map((p, i) => ({
    i,
    category: p.category + (p.constraint ? ` (${p.constraint})` : ""),
    answer: p.raw,
  }));

  const body = {
    model: process.env.AI_VALIDATOR_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    system:
      'You validate answers for a word game. Respond ONLY with a JSON array, one object per item: {"i":<index>,"valid":<true|false>}. Be lenient with spelling and accept broad, reasonable category interpretations. No prose, no markdown.',
    messages: [
      {
        role: "user",
        content: `Language: ${lang}. Round letter: "${letter}". For each item: is the answer a real member of its category AND does its first word start with the round letter?\n${JSON.stringify(items)}`,
      },
    ],
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), rules.validationBudgetMs);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.error(`[validateWithAI] Anthropic API returned ${res.status}: ${await res.text()}`);
      return out;
    }
    const data: any = await res.json();
    const text: string = (data.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (typeof row?.i === "number" && typeof row?.valid === "boolean") {
          const v: Verdict = row.valid ? "valid" : "invalid";
          out.set(row.i, v);
          const p = pending[row.i];
          if (p) cacheSet(cacheKey(lang, p.category, normalizeAnswer(p.raw, lang)), v);
        }
      }
    } else {
      console.error(`[validateWithAI] unexpected response shape, leaving ${pending.length} answer(s) uncertain:`, text.slice(0, 500));
    }
  } catch (err: any) {
    const reason = err?.name === "AbortError"
      ? `timed out after ${rules.validationBudgetMs}ms`
      : (err?.message ?? String(err));
    console.error(`[validateWithAI] failed (${reason}), leaving ${pending.length} answer(s) uncertain — peer challenge is the backstop`);
  }
  return out;
}
