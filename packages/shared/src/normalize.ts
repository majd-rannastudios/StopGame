import { Lang } from "./ruleset";

/**
 * Normalization is used for MATCHING ONLY (duplicates, wordlist lookup,
 * first-letter checks, validation-cache keys). The raw answer is always
 * what gets displayed.
 */

const AR_HARAKAT = /[\u064B-\u0652\u0670\u0640]/g; // tashkeel + dagger alef + tatweel

/** Fold Arabic orthographic variants so بطة/بطه, أحمد/احمد, مصطفى/مصطفي match. */
function foldArabic(s: string): string {
  return s
    .replace(AR_HARAKAT, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

/** Strip Latin diacritics: é→e, ç→c, ï→i … (matching only, display keeps them). */
function foldLatin(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Light plural/stem folding so cat/cats, cheval/chevaux count as duplicates. */
function foldPlural(s: string, lang: Lang): string {
  if (s.length <= 3) return s;
  if (lang === "en") {
    if (s.endsWith("ies")) return s.slice(0, -3) + "y";
    if (s.endsWith("ses") || s.endsWith("xes") || s.endsWith("zes")) return s.slice(0, -2);
    if (s.endsWith("s") && !s.endsWith("ss")) return s.slice(0, -1);
  }
  if (lang === "fr") {
    if (s.endsWith("aux")) return s.slice(0, -3) + "al"; // chevaux→cheval
    if (s.endsWith("x") || (s.endsWith("s") && !s.endsWith("ss"))) return s.slice(0, -1);
  }
  if (lang === "ar") {
    if (s.startsWith("ال") && s.length > 4) return s.slice(2); // strip definite article
  }
  return s;
}

export function normalizeAnswer(raw: string, lang: Lang): string {
  let s = raw.toLowerCase().trim().replace(/\s+/g, " ");
  s = s.replace(/["'’`.,;:!?()\[\]{}«»]/g, "");
  s = lang === "ar" ? foldArabic(s) : foldLatin(s);
  s = foldPlural(s, lang);
  return s;
}

/** First display word must start with the round letter (diacritic/variant-insensitive). */
export function startsWithLetter(raw: string, letter: string, lang: Lang): boolean {
  const t = raw.trim();
  if (!t) return false;
  const first = t.split(/\s+/)[0];
  const nf = lang === "ar" ? foldArabic(first.replace(AR_HARAKAT, "")) : foldLatin(first.toLowerCase());
  const nl = lang === "ar" ? foldArabic(letter) : foldLatin(letter.toLowerCase());
  return nf.startsWith(nl);
}

const MASH = ["asdf", "sdfg", "qwer", "wert", "zxcv", "xcvb", "hjkl", "uiop", "azer", "qsdf", "wxcv"];

/**
 * Cheap keyboard-mash gate, run BEFORE the wordlist and the AI referee.
 * Deliberately conservative: a false positive costs a player real points, and the
 * AI referee behind it already rejects invented words. It only catches input no
 * human would submit in earnest.
 */
export function looksLikeGibberish(raw: string, lang: Lang = "en"): boolean {
  const t = raw.trim();
  if (t.length < 2) return true;
  if (/(.)\1{2,}/.test(t)) return true;                 // aaa, !!!
  if (/^[^\p{L}]+$/u.test(t)) return true;              // digits/punctuation only

  const low = t.toLowerCase();
  if (MASH.some((m) => low.includes(m))) return true;   // home-row runs

  // repeated bigram: "abababab"
  if (/(..)\1{2,}/.test(low)) return true;

  if (lang !== "ar") {
    const letters = low.replace(/[^a-z]/g, "");
    if (letters.length >= 3) {
      if (!/[aeiouy]/.test(letters)) return true;       // no vowel at all
      if (/[bcdfgjklmnpqstvwxz]{6,}/.test(letters)) return true; // impossible cluster
    }
  }
  return false;
}
